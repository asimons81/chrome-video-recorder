# Cinematic Tab Recorder (MV3)

A Chrome Extension (Manifest V3) that records the active tab using an offscreen pipeline, captures cursor/click interaction metadata, and exports polished WebM with cinematic zoom-to-click overlays.

## Implemented

- MV3 architecture with service worker + offscreen document
- Current-tab capture via `chrome.tabCapture.getMediaStreamId`
- Optional mic + tab audio mixing in offscreen pipeline
- Chunked WebM recording to IndexedDB (1s chunks)
- Floating in-tab controller (pause/resume/stop + timer)
- Interaction metadata capture in content script:
  - cursor samples (~30Hz)
  - click targets + bbox + scroll context
  - viewport/scroll events
- Editor page:
  - session browser
  - instant preview canvas
  - non-destructive trim (`trimStartMs`/`trimEndMs`)
  - easing presets (`subtle`, `medium`, `spicy`)
  - rendered WebM export with zoom-to-click + cursor halo + click ripple
  - capability-gated rendered MP4 export (when `MediaRecorder` MP4 is supported)
  - raw WebM download
  - copy diagnostics (session summary + local logs)
- Options page for defaults

## Not Yet Implemented

- MP4 export path (WebCodecs + MP4 muxing)
- MP4 fallback mux path independent of `MediaRecorder` MP4 support
- advanced timeline segment editing
- cloud share link flow
- multi-pass render acceleration and robust fallback matrix

## Load in Chrome

1. Open `chrome://extensions`
2. Enable Developer mode
3. Click **Load unpacked**
4. Select this folder:
   - `/home/tony/.openclaw/workspace/projects/chrome-screen-recorder`

## Usage

1. Open extension popup and click **Start**
2. Use floating controller to pause/resume/stop
3. Open **Editor** from popup
4. Select session, set trim + preset
5. Export rendered WebM or download raw WebM

## Notes

- This is local-first; no network upload path is used.
- For best results, keep recording sessions moderate length on typical laptops.
- Rendered export currently focuses on visual polish; raw download preserves original capture output.
