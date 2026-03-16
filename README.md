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
- Major architecture rewrites

## What Works

- MV3 service worker + offscreen recording pipeline
- Current-tab capture via `chrome.tabCapture.getMediaStreamId`
- Optional mic and tab-audio capture
- IndexedDB chunk storage for recorded WebM data
- Floating in-page controller with pause, resume, stop, and timer
- Editor session list, scrubber, non-destructive trim, and preset selection
- Raw WebM download
- Diagnostics copy for troubleshooting
- Options page for default mic, audio, resolution, quality, and easing values

## Install

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this repository folder:
   `/home/tony/.openclaw/workspace/repos/chrome-video-recorder`
5. Pin the extension if you want faster access while testing.

## First Run

1. Open a normal website tab (`http://` or `https://`).
2. Open the extension popup.
3. Confirm mic, tab audio, and resolution settings.
4. Click **Start** and approve Chrome capture permissions if prompted.
5. Use the floating controller on the page to pause, resume, or stop.
6. Open **Editor** from the popup after the recording finishes processing.

## Editor Workflow

1. Select a saved session.
2. Preview the capture in the canvas player.
3. Adjust `Trim Start` and `Trim End` in milliseconds.
4. Click **Save Trim** to persist the non-destructive trim.
5. Click **Export Rendered WebM** for the supported release export.
6. Use **Download Raw WebM** if you need the original capture output.

## Known Limitations

- Only the active browser tab is supported.
- Chrome internal pages, the Chrome Web Store, and extension pages cannot be recorded.
- WebM is the supported export format for v0.1.
- MP4 may appear only if a Chrome build exposes `MediaRecorder` MP4 support, but it is not part of the release promise.
- Long recordings can consume substantial IndexedDB storage and export time.
- Diagnostics copy depends on clipboard permission being available in the editor page context.

## Troubleshooting

- If recording fails immediately, retry from a normal website tab instead of a Chrome or extension page.
- If you enabled mic capture, make sure Chrome microphone access is allowed.
- If export fails or produces an empty file, retry with a shorter trim range and export WebM.
- If you need support data, open the editor and use **Copy Diagnostics**.

## Release Readiness

The repo now has basic validation and clearer failure states for popup start/stop flow, trim/export actions, settings persistence, and unsupported-tab errors.

Before tagging v0.1, run the manual checklist in [RELEASE_SCOPE.md](/home/tony/.openclaw/workspace/repos/chrome-video-recorder/RELEASE_SCOPE.md).
