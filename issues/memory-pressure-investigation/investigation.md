# Server Memory Pressure Investigation

**Date:** 2026-02-20
**Symptom:** App freezes/slows with ~10 concurrent users
**Root cause:** Unbounded in-memory base64 photo storage + multiple redundant conversions + no session expiry

---

## TL;DR

The server holds **every photo ever taken** per user as raw Buffers in memory, converts them to base64 **3 separate times** per query, stores full base64 dataUrls in chat history (30 turns), and never cleans up sessions that disconnect ungracefully. With 10 users actively taking photos, the server can easily consume **2-8 GB of RAM** and trigger garbage collection pauses or OOM kills — which is exactly the freezing behavior you're seeing.

---

## Issue #1: Unbounded Photo Map (THE BIG ONE)

**File:** `src/server/manager/PhotoManager.ts:29,66`

```typescript
private photos: Map<string, StoredPhoto> = new Map();  // Line 29

// Every photo ever taken gets stored here forever:
this.photos.set(photo.requestId, stored);               // Line 66
```

**Problem:** Every single photo a user takes gets added to this Map and is **never removed** until the user session is fully destroyed. There is no eviction policy — no max count, no max age, no max total size.

**Impact math:**
- Average photo from glasses camera: ~2-5 MB as Buffer
- User takes 20 photos in a session: 40-100 MB just in this Map
- 10 concurrent users × 20 photos each: **400 MB - 1 GB** in this Map alone
- A power user taking 100+ photos: 200-500 MB for ONE user

**The `currentPhoto` + `previousPhotos` rotation (lines 85-96) is fine** — it caps at 3 photos. But the `this.photos` Map is a separate, unbounded store that only exists to serve the `/photo/:requestId` and `/photo-base64/:requestId` API endpoints.

---

## Issue #2: Base64 Triple-Conversion Per Query

**Files:** `QueryProcessor.ts:61`, `PhotoManager.ts:142`, `ChatHistoryManager.ts:46`

Every time a user asks a question with a photo, the same photo Buffer gets converted to base64 **3 separate times:**

| Where | Line | What happens |
|-------|------|-------------|
| `QueryProcessor.ts:61` | `prePhoto.buffer.toString("base64")` | Creates base64 for `photoDataUrl` → sent via SSE + stored in history |
| `PhotoManager.ts:142` | `photo.buffer.toString("base64")` | Creates base64 for SSE broadcast to photo stream clients |
| `photo.ts:69` | `photo.buffer.toString("base64")` | Creates base64 when frontend hits `/photo-base64/:requestId` |

**Impact:**
- A 3 MB photo → 4 MB as base64 string (base64 inflates ~33%)
- 3 conversions = 12 MB of temporary string allocations per query
- These are synchronous CPU-blocking operations on the main thread
- V8 has to allocate, copy, and then GC these large strings
- With 10 users querying simultaneously: **120 MB of transient base64 strings** competing for GC

**Why this causes freezing:** Large string allocations in V8 trigger stop-the-world garbage collection pauses. When 10 users hit this simultaneously, the event loop stalls.

---

## Issue #3: Chat History Stores Full Base64 DataUrls

**File:** `ChatHistoryManager.ts:23,46` + `QueryProcessor.ts:182`

```typescript
// ChatHistoryManager.ts:23
photoDataUrl?: string;  // Full "data:image/jpeg;base64,/9j/4AAQ..." string

// QueryProcessor.ts:182
await this.user.chatHistory.addTurn(query, response, hadPhoto, photoDataUrl);
```

**Problem:** Every conversation turn with a photo stores the FULL base64 dataUrl string in memory. This is the raw Buffer size × 1.33 (base64 inflation) per turn.

**Impact math:**
- 30 turns (max configured in `config.ts:37`) × 5 MB photo each = **~200 MB per user**
- 10 users = **~2 GB** just in chat history
- The `maxAgeMs: 60 * 60 * 1000` (1 hour) filter in `getRecentTurns()` only filters on READ, not on storage — old turns with huge photos sit in memory until the array is manually trimmed

---

## Issue #4: Pending Events Queue Can Accumulate Base64 Photos

**File:** `src/server/api/chat.ts:22,71-72`

```typescript
const pendingEvents = new Map<string, Array<string>>();  // Line 22

// When no SSE clients connected, events queue up:
pendingEvents.get(userId)!.push(data);                    // Line 72
```

**Problem:** When a user's glasses connect but the frontend SSE hasn't connected yet (race condition), all events get queued — including photo broadcasts that contain full base64 data. This queue has **no size limit**.

**Scenario:**
1. Glasses connect → session starts
2. User takes 5 photos before opening the web dashboard
3. Each photo broadcast (with base64) gets queued in `pendingEvents`
4. 5 photos × 5 MB base64 = **25 MB** sitting in a queue
5. If the user never opens the dashboard → this memory is never freed (only cleared on session end via `clearPendingEvents`)

---

## Issue #5: No Session Idle Timeout

**File:** `src/server/manager/SessionManager.ts`

```typescript
private users: Map<string, User> = new Map();  // Line 10
// Only removed on explicit remove() call — no timeout
```

**Problem:** Sessions are only removed when `remove(userId)` is explicitly called (on glasses `onStop` event). If a user's app crashes, phone dies, or loses connectivity without a clean disconnect:
- The session stays in memory forever
- All photos, chat history, SSE clients remain allocated
- The server slowly accumulates zombie sessions

**Impact:** After a day of operation with users connecting/disconnecting, you could have 50+ zombie sessions each holding 50-200 MB.

---

## Issue #6: SSE Client Leaks on Frontend Reconnects

**Files:** `PhotoManager.ts:30`, `chat.ts:18`

```typescript
// PhotoManager
private sseClients: Set<SSEWriter> = new Set();

// chat.ts
const chatClients = new Map<string, Set<SSEWriter>>();
```

**Problem:** SSE clients are only removed via `stream.onAbort()`. But if the frontend reconnects (page refresh, network blip, React re-render), the old SSE connection may not fire `onAbort` immediately — resulting in orphaned connections. Each photo broadcast then sends to ALL clients including orphans, multiplying memory usage.

**Impact:**
- 3 orphaned connections per user × 5 MB base64 per photo = 15 MB wasted per broadcast
- The failed `write()` calls in `broadcastPhoto` do clean up on error (line 158), but only after attempting the write — meaning the base64 string is already allocated

---

## Combined Memory Estimate: 10 Active Users

```
Per user (moderate usage, 15 photos, 20 chat turns with photos):

  Photos Map (15 × 3MB Buffer):          45 MB
  Chat history (20 × 4MB base64):        80 MB
  Current + previous photos (3 × 3MB):    9 MB
  Per-query base64 conversions (peak):    12 MB
  SSE client overhead:                   ~0.1 MB
  Location + notifications:              ~0.1 MB
                                        --------
  Total per user:                       ~146 MB

× 10 users:                            ~1.46 GB
+ Zombie sessions (5 stale):            ~400 MB
+ Pending event queues:                  ~50 MB
+ V8 GC overhead (~30% fragmentation):  ~570 MB
                                        --------
TOTAL SERVER MEMORY:                    ~2.5 GB
```

With heavy photo users (50+ photos each), this easily hits **4-8 GB**.

Bun's default heap limit is ~4 GB. Once you approach that, V8's garbage collector starts doing frequent full GC sweeps (stop-the-world pauses of 100-500ms), which is exactly the "freezing" behavior reported.

---

## Why It Freezes Specifically Around 10 Users

1. **GC pressure:** ~1.5 GB of live objects means V8 is constantly trying to reclaim memory. Full GC pauses block the event loop.
2. **Base64 conversion is synchronous:** `Buffer.toString("base64")` is a CPU-bound synchronous operation. A 5 MB buffer takes ~5-10ms to convert. With 3 conversions × 10 concurrent queries = 150-300ms of blocked event loop.
3. **SSE fan-out amplification:** Broadcasting base64 to multiple clients means the serialized JSON string (containing the base64) gets copied for each `write()` call.
4. **No backpressure:** If an SSE client is slow to consume, writes queue up in the kernel buffer. The server doesn't know the client is slow — it just keeps allocating and writing.

---

## Recommended Fixes (Priority Order)

### P0 — Stop storing photos you don't need
- Add a max size to `PhotoManager.photos` Map (e.g., keep last 5)
- Or better: remove the Map entirely and serve photos from `currentPhoto` + `previousPhotos` only

### P0 — Stop storing base64 in chat history
- Store a photo reference ID instead of the full dataUrl
- Frontend can fetch via `/photo/:requestId` on demand
- This alone saves ~80 MB per active user

### P1 — Convert base64 once, reuse
- Convert to base64 once in QueryProcessor, pass the string to both SSE broadcast and chat history
- Avoid the redundant conversion in PhotoManager.broadcastPhoto

### P1 — Add session idle timeout
- If no glasses activity for 30 minutes, auto-cleanup the session
- Use a `setInterval` in SessionManager to sweep stale sessions

### P2 — Cap the pending events queue
- Add a max size (e.g., 50 events) and drop oldest when full
- Or: don't queue photo-heavy events, only queue lightweight status events

### P2 — Add SSE client limits
- Max 2-3 SSE clients per user per stream type
- Close oldest connection when limit exceeded

### P3 — Stream photos instead of base64
- Serve photos as binary via `/photo/:requestId` (already exists!)
- Send only the photo URL/ID over SSE, not the full base64
- Frontend fetches the image via `<img src="/photo/:id">` — browser handles caching

---

## Questions for You

1. **Do we actually need the `photos` Map at all?** The API endpoints (`/photo/:requestId`, `/photo-base64/:requestId`) rely on it, but if the frontend only ever shows the current/recent photos, we could remove it entirely and save the biggest chunk of memory.

2. **How long should sessions stay alive after glasses disconnect?** Right now it's forever. A 15-30 minute idle timeout would prevent zombie session accumulation.

3. **Is there a reason photo base64 is sent over SSE instead of just a photo ID + URL?** Switching to URL-based photo loading would eliminate the biggest memory spike (base64 broadcast to all clients).

4. **Do we want to persist chat history to disk/DB for this?** Right now it's all in RAM. Even a simple file-based cache would let us evict old turns from memory while keeping them accessible.
