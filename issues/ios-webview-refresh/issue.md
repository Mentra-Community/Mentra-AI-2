# Issue: Frontend Keeps Refreshing / Going Blank on iPhone WebView (Every 10-15s)

**Date:** 2026-02-23
**Symptom:** Frontend goes blank and reloads every ~10-15 seconds on iPhone WebView. Does NOT happen on Android.
**Platform:** iOS WKWebView (MentraOS app)

---

## TL;DR

Five interacting bugs cause a refresh loop on iPhone WebView:

1. **HomePage SSE reconnect timers leak** — `setTimeout(connect, 3000)` is never stored/cleaned up, creating orphaned reconnects
2. **`broadcastChatEvent` doesn't `await` writes** — unhandled promise rejections on iOS connection drops
3. **HMR active in dev mode** — Bun's HMR WebSocket doesn't work properly in iOS WebView, triggers page reloads
4. **No `visibilitychange` handling** — iOS suspends/resumes WebViews aggressively, killing SSE connections silently
5. **Photo/transcription streams have no heartbeat** — 30s of silence gets killed by iOS network stack

The 10-15s timing matches the chat heartbeat interval (15,000ms). When the heartbeat write fails on iOS, the SSE connection drops, frontend detects the error, goes blank, and reconnects — repeating the cycle.

---

## Bug #1: Leaking Reconnect Timers in HomePage.tsx (CRITICAL)

**File:** `src/frontend/pages/home/HomePage.tsx`
**Lines:** 79-83 (photo stream), 138-142 (transcription stream)

### Current behavior:
```typescript
// Photo stream — line 79-83
eventSource.onerror = () => {
  addLog("Photo stream disconnected, reconnecting...");
  eventSource?.close();
  setTimeout(connect, 3000);  // NOT STORED — never cleaned up
};

// Cleanup — line 90
return () => eventSource?.close();  // Only closes eventSource, NOT the timeout
```

Same pattern at lines 138-142 for transcription stream.

### The problem:
When the component unmounts (page navigation, React re-render), the cleanup function closes the EventSource but does NOT cancel the pending `setTimeout`. The orphaned timeout fires 3 seconds later, calls `connect()`, creates a NEW EventSource on a dead component, which immediately errors, schedules another timeout, and so on — an infinite loop of reconnects that can cause the WebView to blank out.

### Compare to ChatInterface (correct):
```typescript
// ChatInterface.tsx — lines 228-335
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
// ...
reconnectTimer = setTimeout(connect, delay);  // STORED
// ...
return () => {
  if (reconnectTimer) clearTimeout(reconnectTimer);  // CLEANED UP
  sseRef.current?.close();
};
```

### Fix:
```typescript
// Photo stream
useEffect(() => {
  let eventSource: EventSource | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  const connect = () => {
    try {
      eventSource = new EventSource(`/api/photo-stream?userId=${encodeURIComponent(userId)}`);

      eventSource.onopen = () => addLog("Connected to photo stream");
      eventSource.onmessage = (event) => { /* same as before */ };

      eventSource.onerror = () => {
        addLog("Photo stream disconnected, reconnecting...");
        eventSource?.close();
        reconnectTimer = setTimeout(connect, 3000);  // STORE IT
      };
    } catch {
      addLog("Failed to connect to photo stream");
    }
  };

  connect();
  return () => {
    if (reconnectTimer) clearTimeout(reconnectTimer);  // CLEAN IT UP
    eventSource?.close();
  };
}, [addLog, userId]);
```

Apply the same fix to the transcription stream useEffect.

---

## Bug #2: `broadcastChatEvent` Doesn't Await Writes

**File:** `src/server/api/chat.ts`
**Lines:** 76-83

### Current behavior:
```typescript
for (const writer of clients) {
  try {
    writer.write(`data: ${data}\n\n`);  // NOT AWAITED
  } catch {
    clients.delete(writer);
  }
}
```

### The problem:
The `SSEWriter` interface declares `write` as returning `Promise<void>` (line 12-15), but `broadcastChatEvent` is a sync function that doesn't `await` the write. This means:
- Write failures produce **unhandled promise rejections** instead of being caught
- Disconnected clients are **never cleaned up** (the catch block never fires for async errors)
- On iOS WebView, where connections drop more frequently, this creates silent failures

### Fix:
```typescript
export async function broadcastChatEvent(userId: string, event: { ... }) {
  const clients = chatClients.get(userId);
  const data = JSON.stringify(event);

  if (!clients || clients.size === 0) {
    if (!pendingEvents.has(userId)) pendingEvents.set(userId, []);
    pendingEvents.get(userId)!.push(data);
    return;
  }

  for (const writer of clients) {
    try {
      await writer.write(`data: ${data}\n\n`);
    } catch {
      clients.delete(writer);
    }
  }
}
```

**Note:** The session-heartbeat issue.md says "broadcastChatEvent is fire-and-forget — no await needed" and that ordering before `sessions.remove()` is sufficient. This was true for the ordering guarantee, but NOT true for error handling. We need the await to properly catch write failures and clean up dead clients. The callers (`MentraAI.ts`, `QueryProcessor`) don't need to await broadcastChatEvent itself — the function can still be called fire-and-forget from the caller's perspective.

**Alternative (if we don't want to make callers deal with async):** Keep the function sync but handle the promise:
```typescript
export function broadcastChatEvent(userId: string, event: { ... }) {
  // ...
  for (const writer of clients) {
    writer.write(`data: ${data}\n\n`).catch(() => {
      clients.delete(writer);
    });
  }
}
```

---

## Bug #3: HMR Active in Development Mode

**File:** `src/index.ts`
**Lines:** 71-78

### Current behavior:
```typescript
Bun.serve({
  port: PORT,
  idleTimeout: 120,
  development: isDevelopment && {
    hmr: true,
    console: true,
  },
  // ...
});
```

### The problem:
If running with `NODE_ENV=development` (likely during testing on iPhone), Bun's HMR establishes a WebSocket to push hot updates. iOS WKWebView has limited/buggy WebSocket support in some contexts, and any file change on the server triggers a page reload signal. Even without file changes, the HMR WebSocket itself may disconnect/reconnect on iOS, triggering reloads.

### Fix:
Either:
1. Run in production mode on iPhone: `NODE_ENV=production`
2. Or disable HMR for WebView clients (detect via User-Agent or query param)

---

## Bug #4: No `visibilitychange` Handling

**Files:** All frontend components with SSE connections

### Current behavior:
Zero `visibilitychange`, `pagehide`, or `pageshow` event listeners in the entire frontend codebase.

### The problem:
iOS WebView aggressively suspends pages when:
- A notification appears
- The user briefly switches apps
- The system reclaims resources
- The screen locks

When suspended, SSE connections die silently (no `onerror` fired during suspension). When the WebView resumes, the EventSource discovers the dead connection and fires `onerror` on ALL THREE streams simultaneously. This triggers:
1. All three SSE streams reconnect at once
2. State gets cleared (`setSessionActive(false)`, `setIsProcessing(false)`)
3. UI flashes blank before new data arrives

### Fix:
Add a visibility change handler that gracefully manages SSE connections:

```typescript
// In a shared hook or in each SSE useEffect:
const handleVisibilityChange = () => {
  if (document.hidden) {
    // Page is being suspended — proactively close SSE to prevent stale connections
    eventSource?.close();
  } else {
    // Page resumed — reconnect immediately instead of waiting for error detection
    connect();
  }
};

document.addEventListener('visibilitychange', handleVisibilityChange);

return () => {
  document.removeEventListener('visibilitychange', handleVisibilityChange);
  // ... rest of cleanup
};
```

---

## Bug #5: Photo/Transcription Streams Have No Heartbeat

**File:** `src/server/api/stream.ts`
**Lines:** 50-52 (photo), 86-88 (transcription)

### Current behavior:
```typescript
// Both streams do this:
while (true) {
  await stream.sleep(30000);  // 30 seconds of SILENCE
}
```

### The problem:
These streams send zero data for 30 seconds at a time. iOS network stack and intermediate proxies aggressively kill idle connections. The chat stream has a 15s heartbeat, but photo and transcription streams are silent — they get killed, which triggers `onerror` on the frontend, which triggers reconnection cascades.

### Fix:
Add heartbeats to both streams:
```typescript
// In photo stream and transcription stream
while (true) {
  await stream.writeSSE({ data: JSON.stringify({ type: "heartbeat" }) });
  await stream.sleep(15000);  // Send heartbeat every 15s
}
```

And on the frontend, ignore heartbeat events:
```typescript
eventSource.onmessage = (event) => {
  try {
    const data = JSON.parse(event.data);
    if (data.type === "connected" || data.type === "heartbeat") return;
    // ... rest of handler
  } catch {}
};
```

---

## Why iPhone But Not Android?

| Factor | iOS WKWebView | Android WebView (Chromium) |
|--------|--------------|---------------------------|
| Background suspension | Aggressive — suspends after seconds | Lenient — keeps running longer |
| Idle connection timeout | Kills silent SSE in ~10-20s | Tolerates 30s+ silence |
| WebSocket support (HMR) | Buggy in WKWebView | Full Chromium support |
| Resource reclaim | Kills background processes aggressively | More permissive |
| EventSource impl | WebKit — stricter error handling | Chromium — more forgiving |

---

## Implementation Plan

### Phase 1: Fix the leaking timers (Bug #1) — HIGH IMPACT, LOW RISK
**Files:** `src/frontend/pages/home/HomePage.tsx`
- Store `setTimeout` return values in both photo and transcription stream useEffects
- Clear them in cleanup functions
- This alone may fix the refresh loop

### Phase 2: Fix broadcastChatEvent await (Bug #2) — MEDIUM IMPACT, LOW RISK
**Files:** `src/server/api/chat.ts`
- Add `.catch()` to writer.write() calls to properly handle disconnected clients
- Keep function sync to avoid breaking callers

### Phase 3: Add heartbeats to all streams (Bug #5) — HIGH IMPACT, LOW RISK
**Files:** `src/server/api/stream.ts`, `src/frontend/pages/home/HomePage.tsx`
- Replace `stream.sleep(30000)` with heartbeat + sleep pattern
- Frontend ignores heartbeat events

### Phase 4: Add visibility change handling (Bug #4) — HIGH IMPACT, MEDIUM RISK
**Files:** `src/frontend/pages/home/HomePage.tsx`, `src/frontend/pages/ChatInterface.tsx`
- Add `visibilitychange` listener to gracefully close/reopen SSE on suspend/resume
- Prevents simultaneous reconnect storms

### Phase 5: Disable HMR for WebView (Bug #3) — CONDITIONAL
**Files:** `src/index.ts` or deployment config
- Only needed if running dev mode on iPhone
- Can be fixed by setting `NODE_ENV=production` for iPhone testing

---

## Files Summary

| File | Changes |
|------|---------|
| `src/frontend/pages/home/HomePage.tsx` | Store reconnect timers, add cleanup, add visibility handling, ignore heartbeat events |
| `src/frontend/pages/ChatInterface.tsx` | Add visibility change handling for SSE |
| `src/server/api/chat.ts` | Add `.catch()` to writer.write() in broadcastChatEvent |
| `src/server/api/stream.ts` | Add 15s heartbeat to photo and transcription streams |
| `src/index.ts` | (Optional) Disable HMR for WebView or production |

---

## Edge Cases & What Could Go Wrong

### Fix #1 (Leaking timers) — Edge Cases

| Edge Case | Risk | Mitigation |
|-----------|------|------------|
| `onerror` fires multiple times before cleanup | Each call overwrites `reconnectTimer`, orphaning the previous timeout | **REAL RISK.** The EventSource spec says `onerror` can fire multiple times. We need to `clearTimeout` the previous timer before setting a new one: `if (reconnectTimer) clearTimeout(reconnectTimer);` before `reconnectTimer = setTimeout(...)` |
| Component unmounts DURING an active `connect()` call | `connect()` creates a new EventSource that immediately sets handlers on a dead component | Low risk — React state setters on unmounted components are no-ops in React 19. The orphaned EventSource will fire `onerror`, but the cleanup already closed it, so the browser handles it. The key fix is clearing the timeout. |
| `addLog` identity changes causing useEffect to re-run | `addLog` is wrapped in `useCallback([], [])` with empty deps, so its identity is stable | No risk — already correct. |
| Server returns 404 (user session not found) on reconnect | Photo/transcription streams require an active session. If glasses disconnected, the endpoint returns 404. EventSource treats non-200 as error → immediate `onerror` → 3s retry → 404 again → infinite 3s loop | **REAL RISK.** Should add a max retry count or back off. But this is existing behavior, not introduced by our fix. Note for future improvement. |

**Action needed:** Add `clearTimeout` before setting new timer in `onerror` handler.

### Fix #2 (broadcastChatEvent .catch) — Edge Cases

| Edge Case | Risk | Mitigation |
|-----------|------|------------|
| `.catch()` fires and deletes client from Set while iterating | Modifying a Set during `for...of` iteration is safe in JS — the deleted element won't be visited again, but the iteration continues | No risk — JS spec guarantees this. |
| Multiple `.catch()` callbacks fire concurrently for same client | If two broadcasts happen in quick succession, both try to delete the same writer | No risk — `Set.delete()` is idempotent. Deleting an already-deleted item is a no-op. |
| `.catch()` is async — client gets a broadcast between failure and cleanup | The `.catch()` callback runs on the microtask queue. Another `broadcastChatEvent` call could run before the `.catch()` resolves, sending to the dead client again | **LOW RISK.** The second write will also fail and `.catch()` will clean it up. Worst case: one extra failed write attempt, no user-visible impact. |
| Making function `async` would change return type from `void` to `Promise<void>` | All 7 callers (QueryProcessor ×4, MentraAI ×2, debug ×1) call it fire-and-forget | **We chose `.catch()` approach specifically to avoid this.** Function stays sync, callers don't change. |
| The `.catch()` swallows the error — no logging | We lose visibility into write failures | Acceptable — the old code also swallowed errors. Could add `console.debug` inside `.catch()` if we want observability. |

**Decision: Use `.catch()` approach (keep function sync).** This is safer than making it `async` because:
- No caller changes needed
- No risk of unintentionally changing ordering semantics (the session-heartbeat issue.md specifically designed `broadcastChatEvent` to be called before `sessions.remove()` with ordering guarantees based on sync behavior)
- The MentraAI.ts `onStop` calls `broadcastChatEvent(userId, { type: "session_ended" })` then `sessions.remove(userId)` on the next line — if we made broadcast async without awaiting, the remove would still run immediately after, which is the current behavior. Making it async AND awaiting would delay the cleanup, which is unnecessary.

### Fix #3 (Stream heartbeats) — Edge Cases

| Edge Case | Risk | Mitigation |
|-----------|------|------------|
| `stream.writeSSE()` throws if connection already closed | The `while(true)` loop would crash with an unhandled error, potentially crashing the stream handler | **REAL RISK.** Need try/catch inside the loop: `try { await stream.writeSSE(...) } catch { break; }` |
| Heartbeat JSON adds bandwidth | `{"type":"heartbeat"}` is ~20 bytes every 15s per stream × 2 streams = ~40 bytes/15s per user | Negligible — less than 3 bytes/second per user. |
| Frontend receives heartbeat before "connected" event | The frontend handler already returns early on `type === "connected"`, and we add `type === "heartbeat"` to the same check | No risk — heartbeat is filtered out before any state updates. |
| Heartbeat interferes with `stream.onAbort()` | `stream.onAbort()` is registered before the heartbeat loop begins. If the client disconnects, `onAbort` fires and the next `writeSSE` in the loop will throw, which we catch and break | No risk — cleanup is handled by `onAbort`, and the loop exits cleanly. |
| 15s heartbeat + 15s chat heartbeat = double network traffic at same interval | Both fire independently. They're on different SSE connections, so no interference | No risk — they're separate TCP connections. |

**Action needed:** Wrap heartbeat `writeSSE` in try/catch with break.

### Fix #4 (visibilitychange) — Edge Cases — **MOST COMPLEX**

| Edge Case | Risk | Mitigation |
|-----------|------|------------|
| `visibilitychange` fires but page isn't actually suspended (e.g., user pulls down notification center briefly) | We close SSE and immediately reopen — causes an unnecessary disconnect/reconnect flash | **REAL RISK.** Mitigation: don't close on `hidden`, only reconnect on `visible` if the connection is dead. Check `eventSource.readyState === EventSource.CLOSED` before reconnecting. |
| `visibilitychange` fires multiple times rapidly (iOS gesture bounce) | Multiple `connect()` calls create multiple EventSources | **REAL RISK.** Must close existing EventSource before creating a new one. The `connect()` function already assigns to `eventSource` variable, but the old one isn't closed first. Need: `eventSource?.close(); eventSource = new EventSource(...)` |
| ChatInterface `onerror` sets `setSessionActive(false)` — visibility reconnect triggers this | On visibility restore, the old EventSource fires `onerror` (sets sessionActive=false), then new connection opens and gets heartbeat (sets sessionActive=true) — brief flash of "disconnected" banner | **MODERATE RISK.** Could debounce the `setSessionActive(false)` with a short delay (200ms), or skip it if we know it's a visibility-triggered reconnect. Simpler approach: on `visibilitychange` to visible, set a flag to suppress the next `onerror`. |
| HomePage doesn't have `sessionActive` state — no banner flash issue there | Photo/transcription streams just reconnect silently | No risk for HomePage. |
| Android WebView also fires `visibilitychange` | Our handler would also run on Android, but it's harmless — it just adds an extra reconnect check on resume | No risk — the check `readyState === CLOSED` prevents unnecessary reconnects on Android where connections survive. |
| The visibility handler creates a NEW EventSource but the old one's `onerror` still fires | The old `onerror` handler references the old `eventSource` via closure. If we've already created a new one, the old `onerror` scheduling `setTimeout(connect, ...)` creates a THIRD connection | **REAL RISK.** Must nullify the old eventSource's handlers before creating a new one, or use a "generation counter" pattern to discard stale callbacks. Simpler: close old one and rely on the new one. The `onerror` handler checks `eventSource?.close()` using the outer variable — if we've already reassigned it, the closure still references the old one. Actually no — it uses the outer `let eventSource` variable. So after reassignment, `eventSource` in the closure points to the new one. **This is actually fine.** |

**Revised approach for visibilitychange:**

Instead of the aggressive close-on-hidden approach, use a lighter touch:

```typescript
const handleVisibilityChange = () => {
  if (!document.hidden) {
    // Page resumed — check if SSE is dead and reconnect if needed
    if (!eventSource || eventSource.readyState === EventSource.CLOSED) {
      connect();
    }
  }
};
```

This avoids the problems of:
- Unnecessary disconnects on brief visibility changes
- Race conditions between old onerror and new connection
- Double connections from rapid visibility toggles

The downside: if the connection is in a zombie state (readyState !== CLOSED but actually dead), this won't help. But the heartbeat fix (#5) handles that — the server heartbeat will eventually fail and trigger onerror.

### Fix #5 (HMR) — Edge Cases

| Edge Case | Risk | Mitigation |
|-----------|------|------------|
| Setting `NODE_ENV=production` disables other dev features | Bun's error overlay, console output, source maps | Known trade-off. Can keep `console: true` separately if needed. |
| HMR disabled but `import.meta.hot` still truthy in bundled code | Bun strips `import.meta.hot` when not in dev mode | No risk — Bun handles this. |

This is the lowest priority fix and only matters if dev mode is being used on iPhone.

---

## Revised Implementation Plan

Based on edge case analysis, here's the updated plan with specific attention to the risks identified:

### Phase 1: Fix leaking timers in HomePage.tsx
**Files:** `src/frontend/pages/home/HomePage.tsx`
**Changes:**
- Add `let reconnectTimer` variable to both SSE useEffects
- In `onerror`: clear previous timer before setting new one
- In cleanup: clear timer AND close eventSource
- **Key detail:** `if (reconnectTimer) clearTimeout(reconnectTimer)` BEFORE `reconnectTimer = setTimeout(connect, 3000)`

### Phase 2: Fix broadcastChatEvent error handling
**Files:** `src/server/api/chat.ts`
**Changes:**
- Replace `writer.write(...)` with `writer.write(...).catch(() => { clients.delete(writer); })`
- Keep function synchronous (don't make it async)
- Remove the now-unnecessary try/catch wrapper (the .catch handles it)

### Phase 3: Add heartbeats to photo/transcription streams
**Files:** `src/server/api/stream.ts`, `src/frontend/pages/home/HomePage.tsx`
**Server changes:**
- Replace `while(true) { await stream.sleep(30000); }` with:
  ```typescript
  while (true) {
    try {
      await stream.writeSSE({ data: JSON.stringify({ type: "heartbeat" }) });
    } catch {
      break; // Connection dead, exit loop
    }
    await stream.sleep(15000);
  }
  ```
**Frontend changes:**
- Add `data.type === "heartbeat"` to early-return checks in both onmessage handlers

### Phase 4: Add visibilitychange handling (light touch)
**Files:** `src/frontend/pages/home/HomePage.tsx`, `src/frontend/pages/ChatInterface.tsx`
**Changes:**
- On `visibilitychange` to visible: check if EventSource is closed, reconnect if so
- Do NOT close on hidden (avoids unnecessary disconnects)
- **Key detail:** check `eventSource.readyState === EventSource.CLOSED` before reconnecting
- In ChatInterface: same pattern, but also suppress the brief `sessionActive=false` flash by not setting it in `onerror` if we're about to reconnect from visibility change

### Phase 5: HMR (documentation only)
- Add a note in the project README/docs that iPhone testing should use `NODE_ENV=production`
- No code changes needed

---

## Verification

1. Open app on iPhone WebView
2. Observe console logs — should NOT see repeated "disconnected, reconnecting..." messages
3. Let it sit for 2+ minutes — no blank screen flashes
4. Lock phone, unlock — SSE reconnects gracefully (single reconnect per stream, not a storm)
5. Navigate between pages and back — no orphaned reconnects
6. Compare with Android — behavior should now be identical
7. Kill server while frontend is open — reconnect loop with backoff, no crash
8. Reconnect server — frontend recovers automatically
