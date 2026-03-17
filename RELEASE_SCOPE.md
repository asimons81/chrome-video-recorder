# Release Scope: v0.1.1

## Included In v0.1

### Core Recording
- [x] MV3 architecture (service worker + offscreen document)
- [x] Current-tab capture via `chrome.tabCapture.getMediaStreamId`
- [x] Optional mic + tab audio mixing
- [x] Chunked WebM recording to IndexedDB (1s chunks)
- [x] Floating in-tab controller (pause/resume/stop + timer)

### Interaction Capture (Content Script)
- [x] Cursor samples (~30Hz)
- [x] Click targets + bbox + scroll context
- [x] Viewport/scroll events

### Editor Page
- [x] Session browser
- [x] Instant preview canvas
- [x] Non-destructive trim (`trimStartMs`/`trimEndMs`)
- [x] Easing presets (`subtle`, `medium`, `spicy`)
- [x] Rendered WebM export with zoom-to-click + cursor halo + click ripple
- [x] Raw WebM download
- [x] Copy diagnostics

### Settings
- [x] Options page for defaults
- [x] Validation for supported settings values

### State Visibility (added in functional recovery pass)
- [x] Chrome extension badge reflects recording state at all times
- [x] Popup `#stateIndicator` banner with pulsing dot for recording state
- [x] State-specific CSS styling for all six states (idle/recording/paused/processing/ready/error)
- [x] Status text color changes per state

---

## Not Included in v0.1.1 (Deferred)

| Feature | Reason |
|---------|--------|
| MP4 export as a supported release path | Browser support is inconsistent and not promised for v0.1 |
| MP4 fallback (WebCodecs + muxer) | Requires additional library, complexity |
| Advanced timeline segment editing | UI complexity, defer to future release |
| Cloud share link flow | Not in scope for v0.1 (local-first) |
| Multi-pass render acceleration | Performance optimization, defer |
| Processing watchdog / timeout | Deferred to v0.2; current stop path resolves in <5s under normal conditions |

---

## v0.1.1 Definition

**Focus:** Core recording + editor workflow with WebM export.

- Local-first (no cloud, no network upload)
- WebM is the supported export path
- Clear errors for unsupported tabs and failed capture startup
- Basic validation around trim and settings values
- Unmistakable recording state indicators at icon and popup level

---

## Bug History

### 2026-03-16: Stop/Finalize Pipeline Blocker (RESOLVED)

**Severity:** Release-blocking

**Original reported symptoms**
- Recording appeared to start, but no usable visual capture reached the editor
- Stop hung in the popup as `stopping` / `finalizing`
- Editor opened without playable media after stop

**Fix applied:** Stop waits for chunk persistence, fails cleanly with missing chunks, preserves session identity for handoff.

---

### 2026-03-16: Functional Recovery Pass (RESOLVED)

**Severity:** Release-blocking — product failed manual verification

**Reported symptoms (post-RC1 audit)**
- Pressing Start gave no visual evidence recording began
- Pressing Stop appeared to do nothing; pressing it again caused an error state
- No persistent recording indicator at icon or popup level
- Content script injection failures killed recording start
- Extension reload during recording left state stuck with no recovery path

**Root causes identified and fixed**
1. Stop button enabled during `processing` + no SW guard → double-stop race → ERROR state
2. No badge, no CSS state classes, no state-specific indicator → invisible to user
3. `ensureContentScript()` propagated fatal errors for non-critical injection failures
4. `init()` restored stale `recording` state without verifying offscreen document was alive

**Files changed**
- `src/service-worker.js` — double-stop guard, non-fatal content script injection, stale-state cleanup on init, badge update on every state change
- `src/ui/popup/popup.js` — stop button disabled during processing, `data-state` applied on refresh, `#stateIndicator` text updated per state, `SESSION_STATE` imported
- `src/ui/popup/popup.html` — `#stateIndicator` element added, `data-state="idle"` default on `<main>`
- `src/ui/popup/popup.css` — state-specific indicator styles, pulsing recording animation, status text color per state

**Current status**
- All four bugs fixed in code.
- Manual end-to-end Chrome verification required before release signoff.

---

### 2026-03-16: Runtime-Trace Repair Pass (RESOLVED)

**Severity:** Release-blocking — recording never started in normal use; visual indicators were dead code on any failure path

**Reported symptoms (post-functional-recovery audit)**
- Extension showed v0.1.1 loaded from correct directory, but behavior unchanged
- Clicking Start did nothing visible — no badge, no state indicator, no offscreen activity
- Even on error paths, `#stateIndicator` and `main[data-state]` never changed

**Root causes identified and fixed**

5. `chrome.tabs.query({ active: true, currentWindow: true })` returns no tabs from SW context when popup is open → SW always returned "No active tab found" → recording never started
6. Popup `start`/`stop`/`pause` handlers returned before calling `refresh()` on `{ ok: false }` response → `main.dataset.state` never updated → all state-indicator UI was unreachable for failure paths

**Files changed**
- `src/service-worker.js` — changed tab query to `lastFocusedWindow: true`, added `windows.getLastFocused` fallback, added full `[SW ↻]` trace logging throughout
- `src/ui/popup/popup.js` — all three button handlers now unconditionally call `await refresh()` after try/catch; added full `[POPUP ↻]` trace logging
- `src/offscreen/offscreen.js` — added full `[OFFSCREEN ↻]` trace logging at every recording lifecycle point
- `LOADING.md` — complete trace-based verification guide with expected console output, failure diagnosis table, offscreen DevTools access instructions

**Current status**
- All six bugs fixed in code.
- Manual end-to-end Chrome verification using LOADING.md trace procedure required before release signoff.
- Previous "working MVP" claim: **FALSE**. Recording never started in typical popup-open scenario prior to this pass.

---

### 2026-03-16: Service Worker Registration Failure (RESOLVED)

**Severity:** Release-blocking — extension completely non-functional; service worker never registered

**Observed error (Chrome Extensions panel → Errors)**
- Service worker registration failed. Status code: 15
- Uncaught TypeError: Cannot read properties of undefined (reading 'onAlarm')

**Root cause**
`chrome.alarms.onAlarm.addListener(...)` at line 72 of `src/service-worker.js` executes synchronously at module-evaluation time. Without the `"alarms"` permission in `manifest.json`, `chrome.alarms` is `undefined`. Accessing `.onAlarm` on `undefined` throws a `TypeError` during module evaluation, which causes Chrome to abort service worker registration with status code 15. The entire extension is dead: no message handling, no badge, no recording, no popup state — nothing.

The `alarms` API is intentionally used: `chrome.alarms.create("recorder-heartbeat", { periodInMinutes: 1 })` fires a periodic heartbeat to flush `runtimeState` to `chrome.storage.session`, enabling stale-state recovery after SW restarts. The permission was simply omitted from the manifest.

**Fix**
Added `"alarms"` to the `permissions` array in `manifest.json`.

**Files changed**
- `manifest.json` — added `"alarms"` permission

**Additional startup analysis**
Full audit of all top-level (synchronous) expressions in `src/service-worker.js` confirmed no other crash risks. All other `chrome.*` API calls (`tabCapture`, `offscreen`, `action`, `tabs`, `scripting`, `storage`) are invoked only inside async function bodies reached via message handlers — they produce per-operation errors, not registration failures.

**Current status**
- All seven bugs fixed in code.
- Manual end-to-end Chrome verification using LOADING.md trace procedure required before release signoff.

---

## Manual Verification Checklist

### Baseline

- [ ] Load the unpacked extension in Chrome. Confirm extension icon shows no badge (idle state).
- [ ] Open the popup. Confirm saved defaults render correctly. Confirm no state indicator banner is visible at idle.
- [ ] On an unsupported tab (`chrome://`, Chrome Web Store, or extension page), click `Start` and confirm the popup shows the expected unsupported-tab error with no badge change.

### State Indicator Verification

- [ ] Open a normal `http://` or `https://` page.
- [ ] Open the popup and click `Start`. Confirm the state indicator banner appears immediately with a pulsing red dot and "Recording in progress" text.
- [ ] Confirm the extension icon badge shows **REC** with a red background.
- [ ] Close the popup. Confirm the badge persists at the icon level.
- [ ] Reopen the popup. Confirm it shows the recording state correctly without requiring any user action.
- [ ] Click `Pause` in the popup or floating controller. Confirm badge changes to **||** (orange) and indicator shows "Paused".
- [ ] Click `Resume`. Confirm badge returns to **REC** (red) and indicator shows "Recording in progress".

### Stop/Finalize Verification

- [ ] Click `Stop`. Confirm Stop button becomes disabled immediately and stays disabled through finalization. Confirm badge briefly shows **...** (blue) during processing.
- [ ] Confirm the popup does NOT allow clicking Stop again while "Finalizing…" is shown.
- [ ] Confirm final popup state becomes `ready` — badge shows **DONE** (green), indicator shows "Recording ready".
- [ ] Click `Open Editor`. Confirm the just-recorded session opens automatically and loads a playable preview.
- [ ] Confirm `Download Raw WebM` produces a playable file.
- [ ] Confirm `Export Rendered WebM` produces a playable file.

### Error State Verification

- [ ] If a recording is intentionally interrupted (force-close offscreen, storage failure), confirm popup badge shows **ERR** (red) and indicator shows the specific error message.
- [ ] Confirm editor shows explicit incomplete/error message for sessions without playable media.
- [ ] Confirm `Copy Diagnostics` remains functional for incomplete or errored sessions.
- [ ] Reload the extension while a recording is active. Reopen the popup. Confirm state resets to **ERR** (not stuck in "Recording in progress") and a new recording can be started immediately.

### Double-Stop Regression

- [ ] Start a recording. Click Stop. While the badge shows **...** (processing), attempt to click Stop again. Confirm the button is disabled and cannot be clicked.

### Regression Checks

- [ ] Editor loads at least one recorded session after reopening the extension/editor.
- [ ] Invalid trim input is rejected with a clear message.
- [ ] Options persist after closing and reopening the popup.
- [ ] Content script injection failure (simulate by recording a tab that disallows scripting) does not prevent recording from starting — it should proceed without the floating controller.

*Last reviewed: 2026-03-16*
