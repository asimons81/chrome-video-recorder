# Loading, Reloading, and Runtime Verification

## IMPORTANT: Pre-load Check

Before loading the extension, confirm the Chrome Extensions panel (chrome://extensions → "Cinematic Recorder" → **Errors**) shows no prior "Service worker registration failed" error. If it does, you are working with a stale load. The fix for this (missing `"alarms"` permission) is already applied in the current source — a fresh remove+re-add will clear it.

## Reload Procedure (WSL2 + Chrome on Windows)

Chrome's file-watcher does not emit events for WSL2 filesystem mutations. Use full remove+re-add for every test cycle. The manifest changed (permissions added), so Chrome requires a remove+re-add — clicking the reload button (↻) on an already-loaded extension will NOT pick up permission changes.

### Step 1 — Remove and re-add

1. `chrome://extensions` → Remove "Cinematic Recorder"
2. Click **Load unpacked** → navigate to:
   ```
   \\wsl$\Ubuntu\home\tony\.openclaw\workspace\repos\chrome-video-recorder
   ```
   or on newer Windows:
   ```
   \\wsl.localhost\Ubuntu\home\tony\.openclaw\workspace\repos\chrome-video-recorder
   ```
3. Confirm version shows **0.1.1** in chrome://extensions
4. Confirm the **Errors** button does NOT appear next to the extension name. If it does, click it — there must be zero errors before proceeding.

### Step 2 — Verify service worker console

1. Click **"Service Worker"** under the extension in chrome://extensions
2. Select the **Console** tab
3. You must see:
   ```
   [SW ↻ load] service-worker module evaluated
   [SW ↻ init] starting
   [SW ↻ init] complete — state=idle
   ```
   If absent: wrong directory or caching issue. Remove and re-add.

### Step 3 — Verify popup console

1. Click extension icon to open popup
2. Right-click popup → **Inspect** → **Console**
3. You must see:
   ```
   [popup] v0.1.1 loaded
   [POPUP ↻ dom] stateIndicator=true main=true start=true
   [POPUP ↻ init] start
   [POPUP ↻ refresh] called
   [POPUP ↻ refresh] state=idle lastError=null
   [POPUP ↻ init] complete
   ```
   If `stateIndicator=false` or `main=false`: popup.html is stale. Remove and re-add.

---

## Runtime Trace — Start

Must be on an `http://` or `https://` tab before clicking Start.

### Expected SW console output on Start click:

```
[SW ↻ msg] received type=START_RECORDING
[SW ↻ startRecording] state=idle
[SW ↻ startRecording] tabs.query(lastFocusedWindow) → tabId=<N> url=https://...
[SW ↻ startRecording] sessionId=<uuid> tabId=<N>
[SW ↻ startRecording] requesting stream id for tab <N>
[SW ↻ getTabStreamId] ok, streamId prefix=<prefix>
[SW ↻ contentScript] ...
[SW ↻ ensureOffscreen] hasDocument=false
[SW ↻ ensureOffscreen] created new offscreen document
[SW ↻ startRecording] routeToOffscreen OFFSCREEN_START
[SW ↻ startRecording] offscreen acknowledged start — broadcasting
[SW ↻ broadcast] state=recording
[SW ↻ badge] text="REC" color=#ef4444
```

### Expected offscreen console output (visible at chrome://inspect → Other):

```
[OFFSCREEN ↻ load] offscreen module evaluated
[OFFSCREEN ↻ msg] type=OFFSCREEN_START
[OFFSCREEN ↻ startRecorder] sessionId=<uuid> tabId=<N>
[OFFSCREEN ↻ startRecorder] calling getUserMedia streamId=<prefix>…
[OFFSCREEN ↻ startRecorder] captureStream ok — videoTracks=1 audioTracks=1
[OFFSCREEN ↻ startRecorder] mixedStream ok — tracks=2
[OFFSCREEN ↻ startRecorder] mimeType=video/webm;codecs=vp9,opus
[OFFSCREEN ↻ startRecorder] calling recorder.start(1000)
[OFFSCREEN ↻ startRecorder] recorder.state=recording
[OFFSCREEN ↻ startRecorder] OFFSCREEN_STARTED sent to SW
[OFFSCREEN ↻ chunk] first chunk bytes=<N>     ← appears ~1 second after start
```

### Expected popup console output after Start:

```
[POPUP ↻ start] click
[POPUP ↻ start] response ok=true error=undefined
[POPUP ↻ refresh] called
[POPUP ↻ refresh] state=recording lastError=null
```

### Expected visible result:
- Pulsing red banner in popup: "Recording in progress"
- Extension icon badge: **REC** (red)
- Start button disabled, Stop button enabled

---

## Runtime Trace — Stop

### Expected SW console:
```
[SW ↻ msg] received type=STOP_RECORDING
[SW ↻ stopRecording] state=recording sessionId=<uuid>
[SW ↻ broadcast] state=processing
[SW ↻ badge] text="..." color=#3b82f6
[SW ↻ stopRecording] routing OFFSCREEN_STOP
[SW ↻ stopRecording] offscreen acknowledged stop
```

### Expected offscreen console:
```
[OFFSCREEN ↻ msg] type=OFFSCREEN_STOP
[OFFSCREEN ↻ stopRecorder] sessionId=<uuid> recorderState=recording
[OFFSCREEN ↻ stopRecorder] recorder.stop() called — onstop will fire async
[OFFSCREEN ↻ recorder.onstop] fired
[OFFSCREEN ↻ recorder.onstop] chunks flushed — finalizing
[OFFSCREEN ↻ finalizeSession] chunks=<N> bytes=<N> durationMs=<N>
[OFFSCREEN ↻ recorder.onstop] finalized chunkCount=<N> bytes=<N>
```

### Expected SW console (after finalize):
```
[SW ↻ msg] received type=OFFSCREEN_STOPPED
[SW ↻ offscreen-stopped] setting READY
[SW ↻ broadcast] state=ready
[SW ↻ badge] text="DONE" color=#22c55e
```

### Expected visible result:
- Blue "Finalizing…" banner while processing (brief)
- Green "Recording ready" banner
- Extension icon badge: **DONE** (green)
- Stop button disabled, Start re-enabled

---

## Diagnosing Failures From Trace

| Missing trace line | Likely cause |
|-------------------|-------------|
| `tabs.query → tabId=undefined` | Not on a normal http/https tab |
| `tabs.query → url=chrome-extension://...` | On extension page — close popup and test from website tab |
| `getTabStreamId error: ...` | tabCapture permission issue or tab closed |
| `getUserMedia` line missing | OFFSCREEN_START message didn't reach offscreen |
| `captureStream ok` missing | getUserMedia failed — check offscreen errors above |
| `recorder.state=recording` missing | MediaRecorder construction or mimeType failure |
| `OFFSCREEN_STARTED sent` missing | SW message send from offscreen failed |
| `onstop fired` missing | MediaRecorder did not stop — check for track-ended events |
| `chunks=0 bytes=0` | ondataavailable never fired (tab lost capture before first interval) |

---

## Accessing Offscreen DevTools

The offscreen document does not appear in chrome://extensions. To inspect it:

1. Open `chrome://inspect/#other`
2. Look for a target with URL ending in `src/offscreen/offscreen.html`
3. Click **inspect**
4. This opens a DevTools window attached to the offscreen document

All `[OFFSCREEN ↻ ...]` logs appear here.
