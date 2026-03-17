# Cinematic Tab Recorder v0.1

Chrome Extension (Manifest V3) for local-first tab recording with captured interaction data and a lightweight editor that exports rendered WebM.

## v0.1 Scope

This release is intentionally narrow:

- Record the current `http://` or `https://` tab
- Capture cursor, clicks, scroll, and viewport changes during recording
- Trim and preview sessions in the editor
- Export a rendered WebM with zoom-to-click, cursor halo, and click ripple overlays
- Save default recording options from the options page

Explicitly out of scope for v0.1:

- MP4 as a supported release path
- Cloud upload or sharing
- Advanced timeline editing or multi-segment edits

## What Works

- MV3 service worker + offscreen recording pipeline
- Current-tab capture via `chrome.tabCapture.getMediaStreamId`
- Optional mic and tab-audio capture
- IndexedDB chunk storage for recorded WebM data
- Chrome extension icon badge showing recording state at all times (REC/paused/processing/ready/error/idle)
- Popup state indicator banner with pulsing dot during active recording
- State-specific visual styling for all six states in the popup
- Floating in-page controller with pause, resume, stop, and timer
- Editor session list, scrubber, non-destructive trim, and preset selection
- Raw WebM download
- Diagnostics copy for troubleshooting
- Options page for default mic, audio, resolution, quality, and easing values

## Install

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this repository folder.
5. Pin the extension. The icon badge will show recording state even when the popup is closed.

## First Run

1. Open a normal website tab (`http://` or `https://`).
2. Open the extension popup.
3. Confirm mic, tab audio, and resolution settings.
4. Click **Start**. The icon badge shows **REC** and a pulsing red banner appears in the popup.
5. Use the floating controller on the page or the popup to pause, resume, or stop.
6. After stopping, the badge shows **DONE** and the popup shows "Recording ready".
7. Click **Open Editor** to access the recorded session.

## Editor Workflow

1. Select a saved session.
2. Preview the capture in the canvas player.
3. Adjust `Trim Start` and `Trim End` in milliseconds.
4. Click **Save Trim** to persist the non-destructive trim.
5. Click **Export Rendered WebM** for the supported release export.
6. Use **Download Raw WebM** if you need the original capture output.

## Recording State Reference

| Badge | Color | Meaning |
|-------|-------|---------|
| *(blank)* | — | Idle, ready to record |
| `REC` | Red | Recording active |
| `\|\|` | Orange | Recording paused |
| `...` | Blue | Finalizing / processing |
| `DONE` | Green | Recording ready in editor |
| `ERR` | Red | Recording failed — see popup for details |

## Known Limitations

- Only the active browser tab is supported.
- Chrome internal pages, the Chrome Web Store, and extension pages cannot be recorded.
- WebM is the supported export format for v0.1.
- MP4 may appear only if a Chrome build exposes `MediaRecorder` MP4 support, but it is not part of the release promise.
- Long recordings can consume substantial IndexedDB storage and export time.
- Diagnostics copy depends on clipboard permission being available in the editor page context.
- Mic capture requires Chrome microphone permission to be granted to the extension.

## Troubleshooting

- If recording fails immediately, confirm you are on a normal `http://` or `https://` tab.
- If you enabled mic capture, ensure Chrome microphone access is allowed for the extension.
- If the badge shows **ERR**, the popup state indicator will show the specific error. Open the editor and use **Copy Diagnostics** to capture full logs.
- If the editor opens to a session with no playable media, it will show whether the session is missing, incomplete, or errored — not a blank state.
- If the extension is reloaded or crashes during recording, the next popup open will show an **ERR** state. The interrupted session will be marked as failed; start a new recording.
- If export fails or produces an empty file, retry with a shorter trim range and export WebM.

## Manual Verification

Before tagging v0.1, run the full checklist in [RELEASE_SCOPE.md](./RELEASE_SCOPE.md).
