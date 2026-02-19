# Feature: Hidden Debug Mode with Live Transcription Overlay

## Overview

A hidden debug mode activated by tapping anywhere on the Settings page 10 times. Shows a small floating pill overlay on all pages with live transcription data from the glasses.

---

## How It Works

### Activation
1. User opens Settings page
2. Taps anywhere on the settings page 10 times rapidly (within 3s)
3. Toast appears: "Debug mode enabled"
4. State saved to `localStorage` (`mentra-debug-mode: "true"`)
5. Floating debug pill appears immediately
6. If already enabled, 10-tap does nothing (only enables, never toggles off)

### Deactivation
1. User taps the X button on the floating debug pill (only way to disable)
2. Toast appears: "Debug mode disabled"
3. `localStorage` item removed
4. Pill disappears

### Persistence
- Debug mode survives page refresh (stored in `localStorage`)
- Survives tab close/reopen (same `localStorage`)
- Only cleared by explicit deactivation via the pill's X button

---

## Proposed Implementation (Three Parts)

### Part 1: Debug Mode State in App.tsx

Add `debugMode` state with `localStorage` persistence. Two functions: `enableDebugMode` (from Settings 10-tap) and `disableDebugMode` (from pill X button).

```typescript
const [debugMode, setDebugMode] = useState(() => {
  return localStorage.getItem('mentra-debug-mode') === 'true';
});

const enableDebugMode = useCallback(() => {
  if (debugMode) return; // Already enabled, no-op
  localStorage.setItem('mentra-debug-mode', 'true');
  setDebugMode(true);
  // show toast
}, [debugMode]);

const disableDebugMode = useCallback(() => {
  localStorage.removeItem('mentra-debug-mode');
  setDebugMode(false);
  // show toast
}, []);
```

Render `DebugOverlay` at the `App.tsx` level (sibling to `ChatInterface`) so it appears on ALL pages. Pass `enableDebugMode` down to ChatInterface → Settings.

**File:** `src/frontend/App.tsx`

### Part 2: 10-Tap Activation on Settings Page

Add a tap counter to the Settings page. Tapping anywhere on the outermost div 10 times within 3 seconds calls `onEnableDebugMode()`.

```typescript
const tapCountRef = useRef(0);
const tapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

const handleSettingsTap = () => {
  tapCountRef.current++;

  if (tapTimerRef.current) clearTimeout(tapTimerRef.current);
  tapTimerRef.current = setTimeout(() => {
    tapCountRef.current = 0;
  }, 3000);

  if (tapCountRef.current >= 10) {
    tapCountRef.current = 0;
    onEnableDebugMode?.();
  }
};
```

The `onClick` goes on the outermost `<div>` wrapping the settings page. Toggle switches and buttons inside will also count taps (event bubbles up). This is fine — it's a hidden feature, and accidentally toggling a setting during rapid tapping is harmless.

**File:** `src/frontend/pages/Settings.tsx`

### Part 3: Floating Debug Pill Component

New `DebugOverlay.tsx` component. Connects to `/api/transcription-stream` SSE and shows live text.

**Position:** `bottom-[108px]` — above the `BottomHeader` component which is 92px tall at `z-[200]`. The pill sits at `z-[60]` and positioned above the bottom nav area.

**SSE behavior:**
- Connects to `/api/transcription-stream?userId=...`
- If no glasses connected → 404 → `onerror` → retries every 3s (shows "Listening...")
- If glasses disconnect → SSE breaks → retries every 3s
- If glasses reconnect → retry succeeds, live data flows again

```typescript
export function DebugOverlay({ userId, onClose }: { userId: string; onClose: () => void }) {
  const [transcription, setTranscription] = useState('Listening...');
  const [isFinal, setIsFinal] = useState(false);

  useEffect(() => {
    let eventSource: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      eventSource = new EventSource(
        `/api/transcription-stream?userId=${encodeURIComponent(userId)}`
      );

      eventSource.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === 'connected') return;
          setTranscription(data.text);
          setIsFinal(data.isFinal ?? false);
        } catch {}
      };

      eventSource.onerror = () => {
        eventSource?.close();
        reconnectTimer = setTimeout(connect, 3000);
      };
    };

    connect();
    return () => {
      eventSource?.close();
      if (reconnectTimer) clearTimeout(reconnectTimer);
    };
  }, [userId]);

  return (
    <div className="fixed bottom-[108px] left-4 right-4 z-[60] flex justify-center pointer-events-none">
      <div className="pointer-events-auto max-w-md w-full flex items-center gap-2 px-3 py-2 rounded-full bg-black/70 backdrop-blur-md border border-white/10">
        <span className="text-[11px]">🎤</span>
        <span className={`text-[12px] font-mono truncate flex-1 ${isFinal ? 'text-green-400' : 'text-white/70'}`}>
          {transcription}
        </span>
        <button onClick={onClose} className="text-white/40 hover:text-white/80 text-[12px] ml-1 flex-shrink-0">
          ✕
        </button>
      </div>
    </div>
  );
}
```

**File:** `src/frontend/components/DebugOverlay.tsx` (new file)

### Toast Notification

Show a brief toast when debug mode is enabled/disabled. Auto-dismiss after 2s.

Managed via a `debugToast` state in `App.tsx`. Set on enable/disable, cleared by `setTimeout(2000)`.

**File:** `src/frontend/App.tsx`

---

## Edge Cases

| Scenario | Behavior |
|----------|----------|
| 10-tap when already enabled | No-op — `enableDebugMode` checks `debugMode` first |
| No glasses connected | Transcription SSE returns 404 → retries every 3s → pill shows "Listening..." |
| Glasses disconnect while pill active | SSE breaks → retries every 3s → reconnects when glasses come back |
| Toggle switches count as taps | Event bubbles up from toggle → counts toward 10. Harmless — hidden feature |
| Pill overlaps BottomHeader | Pill at `bottom-[108px]`, BottomHeader is 92px at bottom. No overlap |
| Page refresh with debug on | `localStorage` persists → pill renders immediately on mount |
| Multiple browser tabs | `localStorage` shared → both tabs show pill. SSE connections independent (each tab has its own) |

## Data Flow

```
ACTIVATION:
  Settings page → 10 taps → enableDebugMode()
  → App.tsx sets debugMode=true, saves to localStorage
  → Toast: "Debug mode enabled" (auto-dismiss 2s)
  → DebugOverlay renders, connects to /api/transcription-stream SSE

LIVE USAGE:
  User speaks → Glasses → TranscriptionManager.broadcast() → SSE
  → DebugOverlay receives text
  → Pill updates: partial (white/gray) → final (green)

DEACTIVATION:
  Tap ✕ on pill → disableDebugMode()
  → App.tsx sets debugMode=false, removes localStorage
  → Toast: "Debug mode disabled" (auto-dismiss 2s)
  → DebugOverlay unmounts, SSE closed
```

## Files Summary

| File | Change |
|------|--------|
| `src/frontend/App.tsx` | Add `debugMode` state + `localStorage`. `enableDebugMode`/`disableDebugMode` functions. Render `DebugOverlay` + toast. Pass `enableDebugMode` to ChatInterface. |
| `src/frontend/pages/ChatInterface.tsx` | Accept `onEnableDebugMode` prop, pass to Settings |
| `src/frontend/pages/Settings.tsx` | Accept `onEnableDebugMode` prop, add 10-tap handler on root div |
| `src/frontend/components/DebugOverlay.tsx` | **New** — floating pill with SSE transcription + X close button |

## Verification

1. Open Settings → tap 10 times → toast "Debug mode enabled" → pill appears at bottom
2. Say something to glasses → pill shows live transcription (partial=gray, final=green)
3. Navigate back to chat → pill stays visible
4. Tap ✕ on pill → toast "Debug mode disabled" → pill disappears
5. Open Settings → tap 10 times again → pill re-appears
6. Refresh page with debug on → pill reappears immediately
7. No glasses connected → pill shows "Listening...", retries SSE silently
8. 10-tap when already enabled → nothing happens
