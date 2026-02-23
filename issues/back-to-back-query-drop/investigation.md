# Query Overwrite During Listening Window — First Query Lost When User Continues Speaking

**Date:** 2026-02-23
**Symptom:** User says "Hey Mentra, what time is it", pauses briefly, then adds "what's the weather" — only "what's the weather" gets processed. The first part is lost.

---

## The Intended Behavior

The 1.5-second silence timeout exists so users can **add to their query** — pause to think, then keep talking. The system should accumulate everything said during the listening window into one combined query.

**Expected:** "Hey Mentra, what time is it... what's the weather" → processes as `"what time is it what's the weather"`

**Actual:** Only `"what's the weather"` gets processed. `"what time is it"` is gone.

---

## Root Cause

**File:** `src/server/manager/TranscriptionManager.ts`, line 125

```typescript
// We're listening - accumulate transcript
this.currentTranscript = removeWakeWord(text);   // ← REPLACES, not appends
```

The word "accumulate" in the comment is a lie — it's doing assignment (`=`), not accumulation (`+=`).

Here's why this matters: the Mentra SDK sends **cumulative** transcriptions. Each `onTranscription` event's `text` field contains the full utterance so far, not just new words. So within a single utterance, assignment is correct — each event is a more complete version of the same speech.

**But when there's a pause and the user starts a NEW utterance**, the SDK starts a fresh `text`. That's when the overwrite kills the first query.

---

## The Timeline

```
T=0ms      SDK event: text="Hey Mentra"                    isFinal=false
           → wake word detected → startListening()
           → currentTranscript = ""  (wake word removed)

T=300ms    SDK event: text="Hey Mentra what time is it"    isFinal=false
           → currentTranscript = "what time is it"          ✓ correct (cumulative)

T=800ms    SDK event: text="Hey Mentra what time is it"    isFinal=true
           → currentTranscript = "what time is it"          ✓ still correct
           → silence timer resets (1.5s)

           [User pauses ~1 second, then continues speaking]
           [SDK starts a NEW utterance — text resets]

T=1800ms   SDK event: text="what's the weather"            isFinal=false
           → currentTranscript = "what's the weather"       ✗ OVERWRITES "what time is it"
           → silence timer resets (1.5s)

T=2200ms   SDK event: text="what's the weather"            isFinal=true
           → currentTranscript = "what's the weather"       (still overwritten)
           → silence timer resets (1.5s)

T=3700ms   1.5s silence → processCurrentQuery()
           → Processes: "what's the weather"
           → "what time is it" is GONE
```

The problem is at T=1800ms. The SDK sends `text="what's the weather"` as a **new utterance** (not cumulative with the previous one). Line 125 replaces the transcript entirely.

---

## Why It Happens

The SDK's transcription streaming works per-utterance:
- Within an utterance, `text` is cumulative (builds up as the user speaks)
- When the user pauses and starts speaking again, a new utterance begins
- The new utterance's `text` starts fresh — it doesn't include text from the previous utterance

The current code treats every `text` as the full state of the query, which is only true within a single utterance. Across utterances, it needs to accumulate.

---

## The Fix

The key challenge: we need to **append** text from new utterances while still allowing **cumulative updates** within the same utterance to overwrite (since they're progressively more complete versions of the same speech).

The SDK provides `utteranceId` on each transcription event (defined in the SDK types). This is the discriminator:

- **Same utteranceId** as the last event → cumulative update, replace current utterance portion
- **New utteranceId** → new utterance, append to what we already have

Alternatively, if `utteranceId` isn't reliably sent, we can use `isFinal=true` as the boundary:
- When we receive `isFinal=true`, snapshot that text as "confirmed"
- New transcription events after a final → append to the confirmed text

---

## Relevant Code Locations

| What | File | Line |
|------|------|------|
| The overwrite | TranscriptionManager.ts | 125 |
| Silence timeout (1.5s) | TranscriptionManager.ts | 55, 176-186 |
| Wake word removal | utils/wake-word.ts | 114-117 |
| SDK TranscriptionData type | @mentra/sdk types | `utteranceId`, `isFinal`, `text` |
| startListening | TranscriptionManager.ts | 145-171 |
| processCurrentQuery | TranscriptionManager.ts | 191-239 |

---

## Implementation Plan

The fix uses `isFinal=true` as the utterance boundary (more reliable than `utteranceId` which may not always be present).

### New State Variables

Add to `TranscriptionManager`:
- `confirmedTranscript: string` — finalized text from completed utterances
- `currentUtteranceText: string` — live text from the in-progress utterance

Replace `currentTranscript` with a getter that returns `confirmedTranscript + currentUtteranceText`.

### New Logic in `handleTranscription()`

```
1. Remove wake word from incoming text
2. If isFinal=true:
   - Append this text to confirmedTranscript (with space separator)
   - Clear currentUtteranceText
   - Reset silence timer
3. If isFinal=false:
   - Set currentUtteranceText = this text (overwrite is fine — it's cumulative within utterance)
   - Reset silence timer
4. When silence timeout fires:
   - Process confirmedTranscript + currentUtteranceText as the full query
```

### The Fixed Timeline

```
T=0ms      text="Hey Mentra"                    isFinal=false
           → wake word detected → startListening()
           → currentUtteranceText = ""

T=300ms    text="Hey Mentra what time is it"    isFinal=false
           → currentUtteranceText = "what time is it"

T=800ms    text="Hey Mentra what time is it"    isFinal=true
           → confirmedTranscript = "what time is it"
           → currentUtteranceText = ""

T=1800ms   text="what's the weather"            isFinal=false
           → currentUtteranceText = "what's the weather"
           → full query = "what time is it what's the weather"  ✓ BOTH KEPT

T=2200ms   text="what's the weather"            isFinal=true
           → confirmedTranscript = "what time is it what's the weather"
           → currentUtteranceText = ""

T=3700ms   silence timeout → process "what time is it what's the weather"  ✓
```

### Changes Required

1. **TranscriptionManager.ts** — Only file that needs changes:
   - Replace `currentTranscript` with `confirmedTranscript` + `currentUtteranceText`
   - Update `handleTranscription()` to use isFinal-based accumulation
   - Update `resetState()` to clear both new fields
   - Update `processCurrentQuery()` to use combined transcript
   - Update HUD display (line 129-134) to show combined transcript

2. **No other files change** — the rest of the pipeline just receives the final query string from `processCurrentQuery()`.

---

## Status: IMPLEMENTED

**Date:** 2026-02-23

Changed `TranscriptionManager.ts` only. Replaced single `currentTranscript` field with utterance-aware accumulation:
- `confirmedTranscript` — finalized text from completed utterances (`isFinal=true`)
- `currentUtteranceText` — live text from in-progress utterance (overwritten per cumulative update)
- `lastConfirmedUtteranceId` — prevents double-appending if same utterance sends `isFinal` twice
- `getFullTranscript()` — combines both for the full query

Type-checks pass. No other files affected.
