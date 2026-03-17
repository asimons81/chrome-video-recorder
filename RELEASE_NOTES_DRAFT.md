# Release Notes Draft: v0.1.1

## Summary

`chrome-video-recorder` v0.1.1 delivers the first scoped release for local tab recording with interaction capture and rendered WebM export.

## Included

- Current-tab recording through an MV3 offscreen pipeline
- Optional microphone and tab-audio capture
- Cursor, click, scroll, and viewport event capture
- Floating in-page recording controller with live timer
- Session browser with preview and non-destructive trim
- Rendered WebM export with cinematic click-focus effects
- Raw WebM download and diagnostics copy
- Options page for default capture settings

## Hardening In This Pass (Initial RC)

- Popup now loads saved defaults and reports clearer recording states
- Starting on unsupported tabs now fails with a direct explanation instead of a vague error
- Recording failures now mark the saved session as errored
- The record → stop → finalize → persist → editor handoff path was repaired so stop waits for chunk persistence before marking a session ready
- Stop-path failures now surface as explicit popup/editor errors instead of hanging in `processing`
- The popup now opens the editor on the most recent relevant session, and the editor shows incomplete/missing-session diagnostics instead of a blank state
- Editor actions are disabled until a valid session is loaded
- Trim input validation now blocks invalid or too-short exports
- Raw download and diagnostics copy now show actionable error messages
- Options page now validates supported values before saving
- README and release docs now describe WebM-first scope and known limitations more accurately

## Functional Recovery Pass (2026-03-16)

A product-integrity audit identified the following failures preventing the release from being considered genuinely functional. All are fixed in this pass.

### Bug 1 — Double-stop corrupts session state (CRITICAL)
**Symptom:** Pressing Stop appeared to do nothing. Pressing it a second time left the session in error state.
**Root cause:** Stop button was not disabled during `processing` state. `active = recording || paused || processing`, so `stop.disabled = !active` kept Stop clickable while finalization was running. A second Stop message passed the guard check in the SW (`state !== IDLE`) and sent a second `OFFSCREEN_STOP`. The offscreen returned "Recorder not active" and the SW entered `ERROR`.
**Fix:** Stop is now only enabled for `recording` and `paused` states. The SW additionally guards `stopRecording()` against `PROCESSING` state and returns a clear "Stop already in progress" response.

### Bug 2 — No user-visible proof that recording is active (CRITICAL)
**Symptom:** Start appeared to do nothing. The popup looked identical in idle and recording states.
**Root cause:** The popup had a single `<p id="status">` with a fixed blue color. No CSS classes changed between states. No Chrome extension badge was ever set.
**Fix:**
- Added `data-state` attribute applied to `<main>` on every status refresh, driving state-specific CSS.
- Added a `#stateIndicator` banner that shows only during non-idle states, with a pulsing red dot during recording, orange during pause, blue during processing, green when ready, and red with the error message on failure.
- Status text color now changes per state.
- Service worker now calls `chrome.action.setBadgeText` and `setBadgeBackgroundColor` on every state change (REC/red during recording, ⏸ orange during pause, ... blue during processing, DONE green when ready, ERR red on error, blank when idle). Badge is visible even when the popup is closed.

### Bug 3 — Content script injection failure killed recording (MEDIUM)
**Symptom:** Recordings could fail to start for certain tabs even though the URL passed the `http(s)://` check.
**Root cause:** `ensureContentScript()` propagated `scripting.executeScript` errors up through `startRecording()`'s try/catch, causing the recording to be marked failed when the floating controller couldn't be injected.
**Fix:** Inner injection block is now wrapped in its own try/catch. Injection failure is logged but non-fatal — recording proceeds without the floating controller and interaction event capture.

### Bug 4 — Stale recording state after extension reload (MEDIUM)
**Symptom:** After reloading the extension during a recording, the popup showed "Recording in progress" with Start disabled and no way to recover without clearing extension storage.
**Root cause:** `init()` restored `runtimeState` from `chrome.storage.session` without verifying whether the offscreen document was still alive.
**Fix:** On init, if restored state is `recording`/`paused`/`processing`, the SW checks `chrome.offscreen.hasDocument()`. If the offscreen is gone, the session is marked as errored, `runtimeState` is reset to `ERROR`, and the badge reflects that state. User can start a fresh recording immediately.

## Known Limitations

- WebM is the supported export format for v0.1
- MP4 is not a release commitment
- No cloud upload or sharing flow
- No advanced timeline editing
- Best suited to moderate-length recordings
- Mic capture requires Chrome microphone permission to be granted to the extension

## Runtime-Trace Repair Pass (2026-03-16)

A second product-integrity audit — prompted by the observation that v0.1.1 was confirmed loaded but recording behavior was still visibly broken — performed a live runtime-path trace across all three execution contexts (popup → SW → offscreen). Two additional critical bugs were identified and fixed.

### Bug 5 — Recording never started in normal popup-open use (CRITICAL)

**Symptom:** Clicking Start appeared to do nothing. No badge changed. No offscreen document was ever created. The extension would silently fail on every Start attempt in the typical scenario where the user opens the popup and clicks Start.

**Root cause:** `chrome.tabs.query({ active: true, currentWindow: true })` is undefined behavior in a MV3 service worker context. When the extension popup is open, Chrome may treat the popup window as the "current window" and return zero normal tabs. The query returned `undefined` for `tab`, which caused the SW to return `{ ok: false, error: "No active tab found" }` on every Start attempt from the popup. The recording pipeline (tabCapture → offscreen → MediaRecorder) was never reached.

**Fix:** Changed query to `chrome.tabs.query({ active: true, lastFocusedWindow: true })` per the Chrome MV3 service worker guidance. Added a secondary fallback via `chrome.windows.getLastFocused({ populate: true, windowTypes: ["normal"] })` if `lastFocusedWindow` still returns a non-recordable tab (e.g. extension page). Both results are validated against `canRecordUrl()` before proceeding.

### Bug 6 — Error return paths in popup handlers skipped `refresh()` (CRITICAL)

**Symptom:** Even when the SW returned an error, `#stateIndicator`, `main[data-state]`, the badge, and button states were never updated. All state-indicator work from the first recovery pass was unreachable on any failure path.

**Root cause:** The popup's `start`, `stop`, and `pause` handlers called `return` immediately after setting `status.textContent` on an `{ ok: false }` response, before reaching `await refresh()`. `main.dataset.state` was never mutated from `"idle"`. The visual indicator system, despite being correctly wired in HTML and CSS, was effectively dead code for any non-success path.

**Fix:** All three button handlers (`start`, `stop`, `pause`) now unconditionally call `await refresh()` after the try/catch block completes, regardless of whether the SW returned success or error.

### Trace instrumentation added

Comprehensive `[SW ↻]`, `[POPUP ↻]`, and `[OFFSCREEN ↻]` console logging was added at every decision point across all three contexts. `LOADING.md` now contains the full expected console trace for Start and Stop paths, a failure diagnosis table, and instructions for accessing the offscreen DevTools via `chrome://inspect/#other`.

---

## Service Worker Registration Fix (2026-03-16)

This pass fixed the deepest bug in the stack: the service worker never registered at all.

### Bug 7 — Missing `"alarms"` permission crashed service worker registration (CRITICAL)

**Symptom:** Chrome Extensions panel → Errors showed "Service worker registration failed. Status code: 15" and "Uncaught TypeError: Cannot read properties of undefined (reading 'onAlarm')". The extension was completely non-functional — no recording, no badge, no popup state updates, nothing.

**Root cause:** `chrome.alarms.onAlarm.addListener(...)` appears at the top level of `src/service-worker.js` and executes synchronously during module evaluation. Without `"alarms"` in `manifest.json` permissions, `chrome.alarms` is `undefined`. Accessing `.onAlarm` on `undefined` throws a `TypeError` that aborts module evaluation, which Chrome surfaces as a registration failure (status 15). Every prior debugging session was working against a permanently dead service worker.

**Fix:** Added `"alarms"` to the `permissions` array in `manifest.json`. The alarms usage is intentional — a `recorder-heartbeat` alarm fires every minute to flush `runtimeState` to `chrome.storage.session`, which enables the stale-state recovery logic in `init()`.

---

## Release Verdict

**NOT READY before the functional recovery pass. NOT READY after that pass. NOT READY after the runtime-trace repair pass (Bug 7 — SW registration failure — still present). READY for manual verification after the alarms permission fix.**

Assessment of the original "working MVP" claim: **FALSE.** Bug 7 (missing `alarms` permission) meant the service worker never registered at all. Every prior test was running against a dead extension. The architecture was structurally correct, but the extension was non-functional at the most fundamental level.

After all seven bugs are fixed, the product is in a state where functional verification is possible for the first time. The `LOADING.md` trace-based verification procedure is the authoritative test protocol.

## Suggested Release Message

`Cinematic Tab Recorder v0.1.1 is a focused first release: record the current tab, capture cursor and click context, trim in the built-in editor, and export polished WebM locally. The extension badge shows recording state at all times. This version intentionally stays narrow and reliable: no cloud flow, no advanced editing, WebM is the supported export path.`
