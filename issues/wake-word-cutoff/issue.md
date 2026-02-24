# Issue: "Hey Mentra" Wake Word Not Stripped Cleanly — Leaves "a," Residue

**Date:** 2026-02-23
**Symptom:** User says "hey mentra, how much is the Alcatraz ticket?" but the query becomes `"a, how much is that Alcatraz ticket..."` — the wake word is partially stripped, leaving a trailing `"a,"` at the start.

---

## TL;DR

The wake word detection uses **exact substring matching** (`indexOf("hey mentra")`) but Deepgram's speech-to-text frequently produces variant transcriptions like `"hey mentr a"`, `"hey mentor"`, `"hey mantra"`, etc. When the exact string `"hey mentra"` isn't found, the wake word isn't stripped, and partial residue leaks into the query.

---

## The Bug — Step by Step

### How it works now

**File:** `src/server/utils/wake-word.ts:85-107`

```typescript
export function detectWakeWord(text: string): WakeWordResult {
  const lowerText = text.toLowerCase().trim();

  for (const wakeWord of WAKE_WORDS) {
    const index = lowerText.indexOf(wakeWord);  // EXACT MATCH ONLY
    if (index !== -1) {
      let query = text.slice(index + wakeWord.length).trim();
      query = query.replace(/^[,.\s]+/, '').trim();
      return { detected: true, query, wakeWordUsed: wakeWord };
    }
  }

  return { detected: false, query: text.trim() };
}
```

`WAKE_WORDS = ["hey mentra"]` — only one exact string to match.

### What happens with Deepgram

Deepgram sends **interim** transcriptions (partial, updating in real-time) and **final** transcriptions. These often differ:

| What user said | Interim transcription | Final transcription |
|---|---|---|
| "hey mentra, how much..." | `"hey mentr a, how much..."` | `"hey mentra, how much..."` |
| "hey mentra, what is..." | `"hey mentor, what is..."` | `"hey mentra, what is..."` |
| "hey mentra, look at..." | `"hey mantra, look at..."` | `"hey mentra, look at..."` |

The problem: **wake word detection runs on EVERY transcription event** (interim AND final). The first interim event triggers the wake word flow:

### The exact sequence that produces "a,"

1. **Interim arrives:** `"hey mentr a, how much is the Alcatraz ticket"`
2. **`detectWakeWord("hey mentr a, how much...")`** runs:
   - Lowercases: `"hey mentr a, how much..."`
   - `indexOf("hey mentra")` → **-1** (not found! there's a space between "mentr" and "a")
   - Returns `{ detected: false, query: "hey mentr a, how much..." }`
3. **But wait** — the wake word WAS actually detected on a *previous* interim event (e.g., a shorter partial like `"hey mentra"` before Deepgram corrected it). So `this.isListening = true` already.
4. **Since we're already listening**, `removeWakeWord(text)` is called at line 137:
   - Calls `detectWakeWord("hey mentr a, how much...")`
   - Again returns the text unchanged because exact match fails
   - `cleanText = "hey mentr a, how much..."`
5. **Text accumulates:** `confirmedTranscript = "hey mentr a, how much is the Alcatraz ticket"`
6. **Silence timeout fires** → `processCurrentQuery()` → `getFullTranscript()` returns the dirty text
7. **Log shows:** `Query ready: "a, how much is that Alcatraz ticket in San Francisco for Alcatraz tour?"`

The "hey mentr " was likely partially removed by a later `removeWakeWord` call on a subsequent interim that DID match `"hey mentra"`, but by then the `confirmedTranscript` already had the broken version baked in.

### Why it's flaky

It depends on **Deepgram's exact transcription timing**:
- Sometimes the interim text has `"hey mentra"` (exact) → works fine
- Sometimes it has `"hey mentr a"` or `"hey mentor"` → fails
- The race between interim/final events and the accumulation logic makes it inconsistent

---

## Root Cause

**`indexOf("hey mentra")` is too brittle for real-world speech-to-text output.** Deepgram frequently produces:

1. **Split words:** `"hey mentr a"` (space inserted mid-word)
2. **Phonetic variants:** `"hey mentor"`, `"hey mantra"`, `"hey mental"`
3. **Missing spaces:** `"heymentra"`
4. **Punctuation variants:** `"hey, mentra"`, `"hey mentra."`

The current code handles NONE of these.

---

## Proposed Fix

### Option A: Flexible regex matching (recommended — simple, covers most cases)

Replace `indexOf` with a regex that handles whitespace variance and common Deepgram variants:

```typescript
export const WAKE_WORDS = ["hey mentra"];

// Build flexible patterns from wake words
const WAKE_PATTERNS = WAKE_WORDS.map(ww => {
  // "hey mentra" → "h\s*e\s*y\s+m\s*e\s*n\s*t\s*r\s*a"
  // This handles: "hey mentra", "hey mentr a", "heymentra", "hey  mentra"
  const chars = ww.split('');
  const pattern = chars.map((ch, i) => {
    if (ch === ' ') return '\\s+';  // word boundary = one or more whitespace
    // Between consecutive letters within same word, allow optional whitespace
    const next = chars[i + 1];
    if (next && next !== ' ') return ch + '\\s*';
    return ch;
  }).join('');
  return new RegExp(pattern, 'i');
});

export function detectWakeWord(text: string): WakeWordResult {
  const lowerText = text.toLowerCase().trim();

  for (let i = 0; i < WAKE_PATTERNS.length; i++) {
    const match = lowerText.match(WAKE_PATTERNS[i]);
    if (match && match.index !== undefined) {
      let query = text.slice(match.index + match[0].length).trim();
      query = query.replace(/^[,.\s]+/, '').trim();
      return {
        detected: true,
        query,
        wakeWordUsed: WAKE_WORDS[i],
      };
    }
  }

  return { detected: false, query: text.trim() };
}
```

**What this handles:**
- `"hey mentra"` → match (exact)
- `"hey mentr a"` → match (space in "mentra")
- `"hey  mentra"` → match (double space)
- `"heymentra"` → match (no space)

**What this does NOT handle:**
- `"hey mentor"` → no match (different letters)
- `"hey mantra"` → no match (different letters)

### Option B: Regex + common Deepgram variants

Extend WAKE_WORDS to include known Deepgram mis-transcriptions:

```typescript
export const WAKE_WORDS = [
  "hey mentra",
  "hey mentor",
  "hey mantra",
  "hey mental",
  "hey mendra",
  "hey mentera",
  "a mentra",
  "hey mentor a",
];
```

Then use the flexible regex from Option A on each.

**Pros:** Catches phonetic variants that regex alone can't.
**Cons:** Need to maintain a list of variants. Can add false positives.

### Option C: Combined — regex with variant list (most robust)

```typescript
// Known Deepgram variants of "hey mentra"
const WAKE_WORD_VARIANTS = [
  "hey mentra",
  "hey mentor",
  "hey mantra",
  "hey mental",
  "hey mendra",
];

// Build flexible patterns that allow whitespace variance within each variant
const WAKE_PATTERNS = WAKE_WORD_VARIANTS.map(variant => {
  const pattern = variant.replace(/([a-z])/g, '$1\\s*').replace(/\s\*\\s\+/g, '\\s+').replace(/\\s\*$/, '');
  return new RegExp(pattern, 'i');
});
```

---

## Additional Issue: removeWakeWord on already-accumulated text

Even after fixing the detection, there's a subtler problem at `TranscriptionManager.ts:137`:

```typescript
const cleanText = removeWakeWord(text);
```

This runs on EVERY transcription event (interim and final). But `confirmedTranscript` accumulates across events:

```typescript
this.confirmedTranscript = (this.confirmedTranscript + ' ' + cleanText).trim();
```

If the wake word was successfully removed from a final event but the interim had already been appended with the residue, the confirmed transcript has garbage in it.

**Fix:** The `confirmedTranscript` should REPLACE (not append) when a new final event arrives for the same utterance. Looking at the code, this IS handled by the `utteranceId` check at line 142-147 — but only if Deepgram provides consistent `utteranceId` values. If the utteranceId changes between interim and final, the broken interim text gets baked in.

**Simpler fix:** Run `removeWakeWord` on the FULL accumulated transcript in `getFullTranscript()` instead of (or in addition to) on each individual event:

```typescript
private getFullTranscript(): string {
  const raw = (this.confirmedTranscript + ' ' + this.currentUtteranceText).trim();
  return removeWakeWord(raw);  // Final cleanup pass
}
```

This is a safety net — even if individual event stripping fails, the final query always has the wake word removed.

---

## Files Summary

| File | Changes |
|------|---------|
| `src/server/utils/wake-word.ts` | Replace `indexOf` with flexible regex matching, optionally add variant list |
| `src/server/manager/TranscriptionManager.ts` | Add final `removeWakeWord` pass in `getFullTranscript()` as safety net |

## Verification

1. Say "hey mentra, what time is it?" — query should be "what time is it?" (no residue)
2. Check server logs for `Query ready:` — should never start with "a," or partial wake word
3. Test multiple times — flakiness should be gone
4. Test variant pronunciations — "hey mentor", "hey mantra" should also work (if Option B/C chosen)
