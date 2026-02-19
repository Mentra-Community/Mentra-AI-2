# Issue: Frontend-Backend Sync Gaps

Audit of all scenarios where the frontend and backend get out of sync for a specific user, and whether each is handled gracefully.

---

## Issue 1: Chat SSE Has No Auto-Reconnect (CRITICAL)

### The Bug
The photo and transcription SSE streams auto-reconnect on error (3s delay in `HomePage.tsx`). The chat SSE stream — the most important one — **does not**. If the connection drops, the frontend goes permanently deaf.

### Current Code (`ChatInterface.tsx:302-305`)
```typescript
eventSource.onerror = (error) => {
  console.error('[ChatInterface] SSE error:', error);
};
// That's it. No reconnect. No UI feedback.
```

### What the user sees
- Chat stops updating silently
- Messages spoken by the glasses never appear
- Processing indicator may be stuck forever
- No indication anything is wrong (until heartbeat banner appears after 15s — if heartbeat was still working)

### Triggers
- Network blip (WiFi switch, cell handoff)
- Server restart (deploy)
- Browser backgrounding (mobile Safari kills SSE after ~30s)

### Proposed Fix

Replace the `onerror` handler with auto-reconnect + exponential backoff:

```typescript
// Inside the SSE useEffect:
let reconnectAttempts = 0;
const MAX_RECONNECT_DELAY = 30000; // 30s cap

const connect = () => {
  const sseUrl = `/api/chat/stream?userId=${encodeURIComponent(userId)}&recipientId=${encodeURIComponent(recipientId)}`;
  const eventSource = new EventSource(sseUrl);
  sseRef.current = eventSource;

  eventSource.onopen = () => {
    reconnectAttempts = 0; // Reset backoff on successful connect
    sessionStorage.setItem('mentra-session-connected', 'true');
  };

  eventSource.onmessage = (event) => {
    // ... existing handler unchanged
  };

  eventSource.onerror = () => {
    eventSource.close();
    const delay = Math.min(1000 * 2 ** reconnectAttempts, MAX_RECONNECT_DELAY);
    reconnectAttempts++;
    console.log(`[ChatInterface] SSE disconnected, reconnecting in ${delay}ms (attempt ${reconnectAttempts})`);
    setTimeout(connect, delay);
  };
};

connect();

return () => {
  sseRef.current?.close();
};
```

On reconnect, the server sends `connected` + `history` events automatically (already implemented in `chat.ts:94-124`). And the first `session_heartbeat` (within 15s) will restore `sessionActive` state.

### Files
| File | Change |
|------|--------|
| `src/frontend/pages/ChatInterface.tsx` | Wrap SSE setup in `connect()` function with exponential backoff reconnect |

---

## Issue 2: Glasses Reconnect Without Cleanup (CRITICAL)

### The Bug
When `onSession` fires for a userId that already has a `User` object in `SessionManager` (because `onStop` was never called — e.g., Bluetooth dropped without clean disconnect), `getOrCreate()` returns the **existing** User, and `setAppSession()` overwrites the old session.

But old transcription listeners from `TranscriptionManager.setup()` are never unsubscribed. The old `this.unsubscribe` callback is lost.

### Current Code
```typescript
// SessionManager.ts:13-20
getOrCreate(userId: string): User {
  let user = this.users.get(userId);
  if (!user) {
    user = new User(userId);
    this.users.set(userId, user);
  }
  return user; // ← Returns EXISTING user with stale listeners
}

// User.ts:85-90
setAppSession(session: AppSession): void {
  this.appSession = session; // ← Overwrites without cleanup
  this.transcription.setup(session); // ← Adds NEW listener, old one still active
  this.input.setup(session);
}
```

### What happens
1. User connects glasses → `onSession` → `getOrCreate` creates User → `setup()` adds listener A
2. Bluetooth drops (no clean `onStop`)
3. User reconnects → `onSession` → `getOrCreate` returns **same User** → `setup()` adds listener B
4. **Both listener A and B are now active** — listener A is on the dead session
5. Transcription events from old session may still arrive, listener A handles them
6. Duplicate queries, zombie processing, stale photo promises

### Proposed Fix

Call `clearAppSession()` before `setAppSession()` when user already exists:

```typescript
// User.ts
setAppSession(session: AppSession): void {
  // Clean up old session if exists (reconnect scenario)
  if (this.appSession) {
    this.clearAppSession();
  }
  this.appSession = session;
  this.transcription.setup(session);
  this.input.setup(session);
  console.log(`🔗 Session connected for ${this.userId}`);
}
```

`clearAppSession()` already exists and does `this.transcription.destroy()` + `this.appSession = null` — exactly what we need. It tears down old listeners before wiring new ones.

### Files
| File | Change |
|------|--------|
| `src/server/session/User.ts` | Add `clearAppSession()` guard at top of `setAppSession()` |

---

## Issue 3: Glasses Connect Before Frontend — `session_started` Lost (ANNOYING)

### The Bug
If glasses connect before the frontend opens the chat SSE stream, the `session_started` broadcast goes to an empty `chatClients` set. The frontend never learns the session is active until the first `session_heartbeat` (up to 15s later).

### What the user sees
- Opens the app, sees the red "Disconnected" banner for up to 15s
- Then banner disappears when heartbeat arrives with `active: true`

### Proposed Fix

When the chat SSE stream first connects, send the current session status immediately (alongside `connected` + `history`):

```typescript
// In chat.ts chatStream(), after sending connected + history:
const currentUser = sessions.get(userId);
const isActive = currentUser != null && currentUser.appSession != null;
await stream.write(`data: ${JSON.stringify({
  type: "session_heartbeat",
  active: isActive,
  timestamp: new Date().toISOString(),
})}\n\n`);
```

This gives the frontend instant session state on connect — no 15s wait.

### Files
| File | Change |
|------|--------|
| `src/server/api/chat.ts` | Send immediate `session_heartbeat` after `connected` + `history` events in `chatStream()` |

---

## Issue 4: Messages Lost If Chat SSE Drops Mid-Query (ANNOYING)

### The Bug
Backend broadcasts `message`, `processing`, `idle` events to `chatClients`. If the frontend's SSE connection dropped, those events are gone. When the frontend reconnects, it gets `history` — but `history` comes from `chatHistory.getRecentTurns()` which is **in-memory only** and may not include the turn that was just processed (it's added at the end of the pipeline in `QueryProcessor.ts:182`).

### Timeline
1. Frontend SSE connected, user asks "what's the weather?"
2. Backend broadcasts `message` (user query) → frontend receives it ✓
3. Backend broadcasts `processing` → frontend receives it ✓
4. **Frontend SSE drops** (network blip)
5. Backend generates response, broadcasts AI `message` → **nobody listening**
6. Backend broadcasts `idle` → **nobody listening**
7. Backend saves to history (`addTurn`) → ✓ (in memory)
8. Frontend SSE reconnects → server sends `history` event → user sees the turn

### The gap
Between steps 5-8, the user sees a frozen "processing" state. Once SSE reconnects, the history event fixes it — but only if Issue 1 (auto-reconnect) is also fixed.

### Assessment
This is **self-healing** once Issue 1 (chat SSE auto-reconnect) is implemented. On reconnect, the server sends the full history which includes the missed turn. The only cost is a few seconds of stale UI during the reconnect.

No additional fix needed beyond Issue 1.

---

## Issue 5: `sessionActive` Starts as `null` — Ambiguous Initial State (COSMETIC)

### The Bug
`sessionActive` initializes as `null` (unknown). The banner only shows when `sessionActive === false`. So on first load, there's no banner and no indication of session state until the first heartbeat arrives.

This is actually fine for most cases — but if the user opens the app with no glasses connected, they see the welcome screen with no indication they need glasses.

### Assessment
Low priority. The welcome screen ("Say Hey Mentra") already implies glasses should be connected. The heartbeat will set `sessionActive` within 15s (or instantly with Issue 3 fix). No action needed now.

---

## Issue 6: Photo/Transcription Streams 404 After Session Cleanup (HANDLED)

### Current behavior
When `sessions.remove(userId)` is called, the User object is deleted. Photo and transcription SSE endpoints check `sessions.get(userId)` — if undefined, they return 404.

The photo/transcription streams in `HomePage.tsx` already handle this with auto-reconnect (3s). When glasses reconnect and a new User is created, the next reconnect attempt succeeds.

### Assessment
Already handled gracefully. No fix needed.

---

## Priority Order

| # | Issue | Severity | Effort | Fix |
|---|-------|----------|--------|-----|
| 1 | Chat SSE no auto-reconnect | CRITICAL | Small | Add `connect()` wrapper with exponential backoff |
| 2 | Glasses reconnect without cleanup | CRITICAL | Tiny | Add `clearAppSession()` guard in `setAppSession()` |
| 3 | `session_started` lost if glasses first | ANNOYING | Tiny | Send immediate heartbeat on chat SSE connect |
| 4 | Messages lost mid-query | ANNOYING | None | Self-healing once Issue 1 is fixed |
| 5 | `sessionActive` null initial state | COSMETIC | None | No fix needed |
| 6 | Photo/transcription 404 | HANDLED | None | Already works |

## Files Summary

| File | Changes |
|------|---------|
| `src/frontend/pages/ChatInterface.tsx` | Issue 1: Wrap SSE in `connect()` with exponential backoff reconnect |
| `src/server/session/User.ts` | Issue 2: Add `clearAppSession()` guard at top of `setAppSession()` |
| `src/server/api/chat.ts` | Issue 3: Send immediate `session_heartbeat` after connect + history |
