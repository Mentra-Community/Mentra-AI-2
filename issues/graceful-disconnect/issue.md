# Graceful Disconnect: 1-Minute Reconnect Grace Period

## Problem

When the glasses disconnect from the cloud (network blip, app hiccup, momentary signal loss), `MentraAI.onStop()` fires immediately and **destroys the entire User session** — conversation history, photos, location cache, notifications, everything.

This is too aggressive. A 2-second network blip wipes out a full conversation. The user reconnects and starts from scratch with no context of what they were just talking about.

### Current flow (broken):

```
glasses disconnect (even for 1 second)
  → onStop fires
  → broadcastChatEvent("session_ended")
  → clearPendingEvents(userId)
  → sessions.remove(userId)
    → user.cleanup() — destroys ALL managers
    → users.delete(userId) — User object gone
  → frontend: clears messages, shows "Waiting for connection..."

glasses reconnect
  → onSession fires
  → sessions.getOrCreate(userId) — creates BRAND NEW User
  → fresh session, no history, no context
```

### What gets destroyed on disconnect:
- `ChatHistoryManager` — all conversation turns (`recentTurns = []`)
- `PhotoManager` — all captured photos (`photos.clear()`)
- `LocationManager` — GPS coordinates, geocoding cache, timezone
- `NotificationManager` — all phone notifications
- `TranscriptionManager` — unsubscribes, clears timers
- `AppSession` reference — set to null

### Root cause:
`onStop` in `MentraAI.ts` (line 154-160) calls `sessions.remove(userId)` with zero delay — no grace period.

---

## Solution

Add a **1-minute grace period** between disconnect and full cleanup. During the grace period:
- The `User` singleton stays alive in `SessionManager` (conversation, photos, everything preserved)
- Only the `AppSession` is detached (no glasses SDK calls possible)
- If the user reconnects within 1 minute → re-wire the new `AppSession` to the existing User
- If 1 minute passes with no reconnect → then do the full cleanup

### New flow (fixed):

**Brief disconnect (reconnects within 1 min):**
```
glasses disconnect → onStop
  → softRemove(userId): detach AppSession, start 60s timer
  → broadcast "session_reconnecting" to frontend
  → frontend: keeps messages, shows "Disconnected — attempting to reconnect" banner

glasses reconnect → onSession
  → cancelRemoval(userId): clear timer, return true (was reconnecting)
  → setAppSession(newSession): re-wire transcription/input listeners
  → broadcast "session_reconnected" to frontend
  → frontend: hides banner, conversation intact
```

**Permanent disconnect (no reconnect within 1 min):**
```
glasses disconnect → onStop
  → softRemove(userId): detach AppSession, start 60s timer
  → broadcast "session_reconnecting" to frontend

... 60 seconds pass, no reconnect ...

timer fires:
  → broadcast "session_ended" (reason: "grace period expired")
  → clearPendingEvents(userId)
  → remove(userId): full cleanup (destroy all managers, delete from Map)
  → frontend: clears messages, shows "Waiting for connection..."
```

---

## Files to Modify

| File | Change |
|------|--------|
| `src/server/manager/SessionManager.ts` | Add `softRemove()`, `cancelRemoval()`, and `pendingRemovals` timer map |
| `src/server/MentraAI.ts` | `onStop` → call `softRemove()` instead of `remove()`, `onSession` → call `cancelRemoval()` for reconnect detection |
| `src/server/session/User.ts` | No changes needed — `clearAppSession()` and `setAppSession()` already exist |
| `src/server/api/chat.ts` | Add `session_reconnecting` and `session_reconnected` to event type union |
| `src/frontend/pages/ChatInterface.tsx` | Handle new events — keep messages on `session_reconnecting`, restore on `session_reconnected` |

---

## Implementation Details

### 1. SessionManager — Grace period timer logic
**File:** `src/server/manager/SessionManager.ts`

Add a `pendingRemovals: Map<string, Timer>` to track grace period timers per user.

**New method: `softRemove(userId, gracePeriodMs = 60_000)`**
- Calls `user.clearAppSession()` — detaches glasses, kills transcription listeners, but keeps User alive
- Starts a `setTimeout` for 60 seconds, stored in `pendingRemovals`
- When timer fires: broadcasts `session_ended`, calls `clearPendingEvents(userId)`, then calls the existing `remove(userId)` for full cleanup

**New method: `cancelRemoval(userId): boolean`**
- Checks if `pendingRemovals` has a timer for this userId
- If yes: `clearTimeout(timer)`, delete from map, return `true` (this is a reconnect)
- If no: return `false` (this is a fresh session)

Existing `remove()` stays unchanged — still does full cleanup. Called by the timer or for a hard kill.

### 2. MentraAI.onStop — Soft remove
**File:** `src/server/MentraAI.ts`

Replace the current cleanup block:
```typescript
// BEFORE (aggressive)
broadcastChatEvent(userId, { type: "session_ended", reason, timestamp });
clearPendingEvents(userId);
sessions.remove(userId);
```

With:
```typescript
// AFTER (graceful)
broadcastChatEvent(userId, { type: "session_reconnecting", reason, timestamp });
sessions.softRemove(userId);
```

Key: do NOT call `clearPendingEvents` here — events should be preserved in case the user reconnects and a frontend SSE client picks them up.

### 3. MentraAI.onSession — Reconnect detection
**File:** `src/server/MentraAI.ts`

At the start of `onSession`, after `getOrCreate(userId)`:

```typescript
const wasReconnect = sessions.cancelRemoval(userId);
```

If `wasReconnect === true`:
- Skip `user.initialize()` (already initialized, DB connection still alive)
- Call `user.setAppSession(session)` (re-wires transcription + input)
- Re-wire location, notifications, timezone, device model listeners (same as normal)
- Broadcast `session_reconnected` instead of `session_started`
- Optionally skip welcome sound/message on reconnect

If `wasReconnect === false`:
- Normal flow, unchanged

### 4. Chat API — New event types
**File:** `src/server/api/chat.ts`

Update the type union on `broadcastChatEvent` (line 63):
```typescript
type: '...' | 'session_reconnecting' | 'session_reconnected'
```

The heartbeat check (`heartbeatUser.appSession != null`) will correctly report `active: false` during the grace period since `clearAppSession()` sets `appSession = null`. This is good — the frontend heartbeat will reflect the disconnected state.

### 5. Frontend — Handle new events
**File:** `src/frontend/pages/ChatInterface.tsx`

**On `session_reconnecting` (line ~304):**
```typescript
} else if (data.type === 'session_reconnecting') {
  setSessionActive(false);
  setIsProcessing(false);
  // DO NOT clear messages — this is the key difference from session_ended
}
```

The existing "Disconnected — attempting to reconnect" banner already shows when `sessionActive === false` (line 371-385). Since we're NOT clearing messages, the chat stays visible behind the banner.

**On `session_reconnected` (line ~304):**
```typescript
} else if (data.type === 'session_reconnected') {
  setSessionActive(true);
  // Messages are already in state — nothing to reload
}
```

**On `session_ended` (unchanged):**
Still clears messages and shows "Waiting for connection..." — this only fires after the 1-minute grace period expires.

---

## Edge Cases That Will Break the Codebase (Must Fix)

### 1. CRITICAL: `TranscriptionManager.destroyed` flag never resets on reconnect

**Will break:** Yes — agent stops responding entirely after reconnect.

**Problem:** `clearAppSession()` calls `transcription.destroy()` which sets `this.destroyed = true` (`TranscriptionManager.ts:434`). When the user reconnects, `setAppSession()` calls `transcription.setup(session)` — but `setup()` never resets `destroyed` back to `false`. The zombie safety check at `TranscriptionManager.ts:285` will abort every single query after reconnect:

```
processCurrentQuery() → await pendingPhoto → if (this.destroyed) return  // ALWAYS TRUE
```

**Fix:** Add `this.destroyed = false;` at the top of `TranscriptionManager.setup()`:
```typescript
setup(session: AppSession): void {
  this.destroyed = false;  // <-- Reset zombie flag for reconnect
  this.unsubscribe = session.events.onTranscription(...)
}
```

**File:** `src/server/manager/TranscriptionManager.ts` (line 95)

---

### 2. TranscriptionManager SSE clients wiped on soft remove

**Will break:** No — but live transcript feed drops briefly.

**Problem:** `transcription.destroy()` calls `this.sseClients.clear()` (`TranscriptionManager.ts:438`). These are the transcription SSE clients (live transcript overlay on the frontend). After reconnect, the frontend's transcription `EventSource` will need to reconnect to get live transcript again.

**Impact:** Momentary loss of the live transcription feed on the frontend. The frontend `EventSource` auto-reconnects with exponential backoff, so it recovers on its own. No code fix needed — just be aware of the brief gap.

---

### 3. QueryProcessor mid-flight: SDK calls on dead `AppSession` will throw

**Will break:** No — caught by existing try/catch, but worth documenting.

**Problem:** `QueryProcessor.processQuery()` snapshots `const session = this.user.appSession` at pipeline start (line 30). If disconnect happens mid-pipeline, the `session` variable still points to the old dead `AppSession`. Subsequent SDK calls on it will throw:
- `session.location.getLatestLocation()` (line 103) — caught by try/catch at line 108
- `session.layouts.showTextWall()` (line 197 via `showStatus`) — caught by null check at line 196
- `session.audio.speak()` (line 310 via `outputResponse`) — caught by null check at line 296 (re-reads `this.user.appSession` which is now null)

**Impact:** The agent response still generates and broadcasts to the frontend via SSE (SSE is independent from the glasses session). The response just won't be spoken/displayed on the glasses. Chat history still gets saved (line 182). This is acceptable — the user gets the response on their phone at least.

**No fix needed** — existing null checks and try/catch handle this gracefully.

---

### 4. `loopProcessingSound` naturally exits on dead session

**Will break:** No.

**Problem:** The while loop at `QueryProcessor.ts:217` checks `this.user.appSession` each iteration. After `clearAppSession()` sets it to null, the loop breaks on the next iteration. `playAudio()` on the dead session will throw, caught by the `catch` which also breaks the loop.

**No fix needed.**

---

### 5. Rapid disconnect/reconnect cycles — timer leaks

**Will break:** No, if implemented correctly.

**Problem:** If the user disconnects 5 times in 10 seconds, we'd have 5 timers stacking up.

**Fix:** `softRemove()` must clear any existing pending timer before starting a new one:
```typescript
softRemove(userId: string, gracePeriodMs = 60_000): void {
  // Clear any existing grace period timer (prevents stacking)
  const existingTimer = this.pendingRemovals.get(userId);
  if (existingTimer) clearTimeout(existingTimer);

  // ... detach session, start new timer
}
```

**File:** `src/server/manager/SessionManager.ts`

---

### 6. Multiple `onStop` calls for same user

**Will break:** No, if `softRemove` is idempotent.

**Problem:** The SDK might fire `onStop` multiple times for the same disconnect event. If `softRemove` already detached the session (`appSession` is already null), calling `clearAppSession()` again should be safe — `transcription.destroy()` is idempotent (sets `destroyed = true` again, clears already-empty timers).

**Fix:** `softRemove` should check if user exists before operating:
```typescript
softRemove(userId: string, gracePeriodMs = 60_000): void {
  const user = this.users.get(userId);
  if (!user) return;  // Already fully removed or doesn't exist
  // ...
}
```

---

### 7. Server restart during grace period

**Will break:** No — same as current behavior.

All in-memory state (User objects, timers, conversation history) is lost on server restart regardless. No regression from this change.

---

### 8. Debug `kill-session` endpoint needs updating

**Will break:** No, but testing will be incomplete.

**Problem:** The existing `src/server/api/debug.ts` `killSession` handler calls `sessions.remove(userId)` directly (hard kill). After this change, it won't test the grace period flow.

**Fix:** Update `killSession` to use `softRemove()` by default, add a `?mode=hard` query param for immediate kill:
```typescript
export async function killSession(c: Context) {
  const mode = c.req.query("mode") || "soft";
  if (mode === "hard") {
    sessions.remove(userId);
  } else {
    sessions.softRemove(userId);
  }
}
```

**File:** `src/server/api/debug.ts`

---

### 9. Welcome sound plays again on reconnect

**Will break:** No, but bad UX.

**Problem:** `onSession` calls `this.playWelcome(session, sessionId)` every time. After a 2-second network blip, the user hears "Welcome to Mentra AI" again — feels broken.

**Fix:** Skip welcome on reconnect:
```typescript
if (!wasReconnect) {
  this.playWelcome(session, sessionId);
}
```

**File:** `src/server/MentraAI.ts`

---

## Summary: What Must Be Fixed During Implementation

| # | Issue | Severity | Fix Required |
|---|-------|----------|-------------|
| 1 | `destroyed` flag never resets | **CRITICAL** — breaks all queries after reconnect | Reset in `setup()` |
| 2 | Transcription SSE clients wiped | Low — auto-recovers | None |
| 3 | SDK calls on dead AppSession | Low — caught by try/catch | None |
| 4 | Processing sound loop | None — exits naturally | None |
| 5 | Timer stacking on rapid cycles | Medium — memory leak | Clear existing timer in `softRemove` |
| 6 | Multiple onStop calls | Low — needs idempotency | Null check in `softRemove` |
| 7 | Server restart | None — same as current | None |
| 8 | Debug endpoint outdated | Low — testing only | Update to use `softRemove` |
| 9 | Welcome sound on reconnect | Low — UX annoyance | Skip on reconnect |

---

## Verification

### Automated
```bash
# Update the existing disconnect test to verify grace period
bun test src/server/test/unit-tests/session-disconnect.test.ts
```

### Manual with real glasses
```
1. bun run dev
2. Open frontend on phone
3. Connect glasses, send a few queries (build up conversation)
4. Kill session: curl -X POST "http://localhost:3000/api/debug/kill-session?userId=paryan28@gmail.com"
   → Frontend shows "Disconnected" banner but messages STAY
5. Reconnect glasses within 60s
   → Banner hides, conversation intact, can keep chatting
6. Kill session again, wait >60s
   → Frontend clears messages, shows "Waiting for connection..."
```

### What to verify
- [ ] Brief disconnect: conversation persists across reconnect
- [ ] Grace period expiry: full cleanup happens after 60s
- [ ] No timer leaks on rapid disconnect/reconnect cycles
- [ ] Mid-query disconnect: response still reaches frontend
- [ ] Heartbeat correctly reports `active: false` during grace period
- [ ] Frontend banner shows/hides correctly for reconnecting vs reconnected
- [ ] **`destroyed` flag resets — queries work after reconnect**
- [ ] Welcome sound does NOT play on reconnect
- [ ] Debug kill-session endpoint works in both soft and hard mode
