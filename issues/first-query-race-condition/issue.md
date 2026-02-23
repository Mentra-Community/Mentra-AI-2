# ISSUE: First Query Not Displaying on Initial Webview Load

**Status:** Open
**Severity:** High — affects every user's first interaction
**Date:** 2026-02-20

---

## Summary

When a user says "Hey Mentra" and quickly opens the webview to see the result, the first query + response **never appears** on screen. The user must exit and re-enter the webview to see it. This only happens on the **very first query** of a session.

## Steps to Reproduce

1. Say "Hey Mentra" (wake word triggers)
2. Ask a question (e.g., "What time is it?")
3. Immediately open the webview to see the result
4. **Expected:** User message + AI response appear in chat
5. **Actual:** Empty chat — shows "Say Hey Mentra" or loading state. No messages.
6. Exit webview, re-open it → now the messages appear (loaded from chat history)

---

## Root Cause: SSE Race Condition

The backend **broadcasts messages before the frontend SSE connection is established**. There is **no event buffering or queueing**, so the messages are lost.

### Timeline (what actually happens)

```
T=0ms     [GLASSES]  Wake word detected → photo capture starts
T=100ms   [GLASSES]  User finishes speaking
T=150ms   [GLASSES]  Silence timeout → processCurrentQuery()
T=250ms   [GLASSES]  QueryProcessor.processQuery() starts
T=260ms   [SERVER]   broadcastChatEvent(user message) → chatClients is EMPTY → early return
T=500ms   [SERVER]   Agent response ready
T=520ms   [SERVER]   broadcastChatEvent(AI response) → chatClients is STILL EMPTY → early return
T=800ms   [WEBVIEW]  HTML loads
T=1200ms  [WEBVIEW]  React mounts, auth starts
T=1800ms  [WEBVIEW]  Auth completes, userId available
T=1870ms  [WEBVIEW]  EventSource created → /api/chat/stream
T=1900ms  [SERVER]   addChatClient() registers the SSE writer
T=1910ms  [SERVER]   chatHistory.getRecentTurns() → [] (EMPTY — history saved AFTER broadcast)
T=1920ms  [WEBVIEW]  Receives session_heartbeat → shows empty chat
```

**The broadcasts at T=260ms and T=520ms fire into an empty `chatClients` map and are silently dropped.**

### Why Subsequent Loads Work

On re-open, `chatHistory.getRecentTurns()` returns the previous query/response (saved at the end of the pipeline), so the history replay sends them to the frontend.

---

## Code Locations

### 1. The broadcast that gets lost — `broadcastChatEvent()`

**File:** `src/server/api/chat.ts:51-68`

```typescript
export function broadcastChatEvent(userId: string, event: {...}) {
  const clients = chatClients.get(userId);
  if (!clients) return;  // ← EARLY EXIT: no connected clients = message lost forever
  // ...
}
```

### 2. The broadcasts in the query pipeline

**File:** `src/server/manager/QueryProcessor.ts`

- **Line 86-94:** Broadcasts user message (with photo) — fires ~260ms into pipeline
- **Line 97:** Broadcasts `processing` state
- **Line 155-162:** Broadcasts AI response — fires after agent generates response
- **Line 165:** Broadcasts `idle` state

### 3. History saved AFTER broadcasts

**File:** `src/server/manager/QueryProcessor.ts:182`

```typescript
await this.user.chatHistory.addTurn(query, response, hadPhoto, photoDataUrl);
```

This runs **after** all broadcasts. So when the frontend connects and requests history, the current query isn't in history yet.

### 4. Frontend SSE connection (delayed by auth + mount)

**File:** `src/frontend/pages/ChatInterface.tsx:222-338`

```typescript
useEffect(() => {
  if (!userId || !recipientId) return;  // ← waits for auth to resolve
  // ...
  const eventSource = new EventSource(sseUrl);  // ← connection happens here
}, [userId, recipientId]);
```

The `userId` dependency means SSE doesn't connect until `useMentraAuth()` resolves, adding ~500-1000ms delay.

### 5. History replay on connect (empty on first query)

**File:** `src/server/api/chat.ts:97-123`

```typescript
const recentTurns = user.chatHistory.getRecentTurns(30);
if (recentTurns.length > 0) {
  // ... send history
}
```

On first query, `recentTurns` is empty because `addTurn()` (line 182 in QueryProcessor) hasn't run yet.

---

## Proposed Fix: Event Queue Buffer in `chat.ts`

The idea is simple: when `broadcastChatEvent()` fires and there are **no connected SSE clients**, instead of silently dropping the event, we **queue it**. When the frontend finally connects and the SSE stream opens, we **flush the queue** and **skip history replay** (since the queued events already contain the current data).

### What changes (server only — no frontend changes)

**One file:** `src/server/api/chat.ts`

**Change 1 — Add a pending events buffer:**

```typescript
// Queued events for users with no connected SSE clients
// Cleared when the user session ends (onStop)
const pendingEvents = new Map<string, Array<string>>();
```

**Change 2 — `broadcastChatEvent()` queues instead of dropping:**

```typescript
export function broadcastChatEvent(userId: string, event: {...}) {
  const clients = chatClients.get(userId);
  const data = JSON.stringify(event);

  if (!clients || clients.size === 0) {
    // No SSE clients connected — queue for later
    if (!pendingEvents.has(userId)) pendingEvents.set(userId, []);
    pendingEvents.get(userId)!.push(data);
    return;
  }

  // Normal path — send directly
  for (const writer of clients) {
    try {
      writer.write(`data: ${data}\n\n`);
    } catch {
      clients.delete(writer);
    }
  }
}
```

**Change 3 — `chatStream()` flushes queue on connect, skips history if queue had data:**

```typescript
addChatClient(userId, customWriter);

// Send connected event (always — unchanged)
await stream.write(`data: ${JSON.stringify({ type: "connected" })}\n\n`);

// Flush any events that were broadcast before this client connected
const queued = pendingEvents.get(userId);
let flushedQueue = false;
if (queued && queued.length > 0) {
  for (const event of queued) {
    await stream.write(`data: ${event}\n\n`);
  }
  pendingEvents.delete(userId);
  flushedQueue = true;
}

// Only send history if we didn't flush queued events (avoids duplicates)
if (!flushedQueue) {
  const user = sessions.get(userId);
  if (user) {
    const recentTurns = user.chatHistory.getRecentTurns(30);
    // ... existing history replay code
  }
}

// Send session heartbeat (always — unchanged)
// ... existing heartbeat code
```

### How it plays out

```
T=260ms   broadcastChatEvent(user msg)    → no clients → QUEUED
T=270ms   broadcastChatEvent(processing)  → no clients → QUEUED
T=520ms   broadcastChatEvent(AI response) → no clients → QUEUED
T=530ms   broadcastChatEvent(idle)        → no clients → QUEUED
          ─── frontend loading ───
T=1900ms  Frontend SSE connects → chatStream() runs
T=1910ms  addChatClient() registers the writer
T=1920ms  Flush queue → sends user msg, processing, AI response, idle → frontend receives all 4
T=1930ms  flushedQueue=true → skip getRecentTurns() (no duplicates)
T=1940ms  Frontend shows the messages ✅
```

---

## Decisions Made

### Duplicate messages — queue flush + history replay
**Decision: Skip history replay if queue was flushed.**

If `pendingEvents` had data for this user, we skip `getRecentTurns()` entirely for this connection. The queued events already contain the current query — no need to also send history which could overlap.

### Queue flush ordering
**Decision: N/A — history is skipped when queue has data.**

Since we skip history replay when the queue flushes, ordering doesn't matter. The queue events are already in chronological order (they were queued in the order they were broadcast).

### Mid-flight pipeline
**No issue.** If the agent is still thinking when the frontend connects, the queue contains `[user message, processing]`. Those get flushed. Then when the agent finishes, `broadcastChatEvent` sends `[AI response, idle]` directly to the now-connected client. Works naturally.

### Memory cleanup
**Decision: Clear on session end only (no TTL).** Events stay queued as long as the session is alive. `clearPendingEvents(userId)` is called in `onStop()` (MentraAI.ts) and `killSession()` (debug.ts) when the glasses disconnect.

### Exit and re-enter flow
**Handled.** If a query comes in while webview is closed, events get queued. On re-open, queue flushes (skipping history). If the session ended, queue was already cleared.

---

## Alternative Approaches Considered

| Approach | Pros | Cons |
|----------|------|------|
| **Event queue buffer** (recommended) | Simple, server-only, handles all event types | Need to handle queue+history overlap |
| **Save history before broadcast** | Leverages existing replay | Only fixes history messages, not processing/idle states; changes pipeline ordering |
| **Frontend polling on connect** | No server changes | Adds latency, complexity, extra API endpoint |
| **Delay query processing until SSE connected** | Guarantees delivery | Terrible UX — adds seconds of latency to every query |
