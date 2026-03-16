# Release Scope: v0.1.0

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

---

## Not Included in v0.1.0 (Deferred)

| Feature | Reason |
|---------|--------|
| MP4 export as a supported release path | Browser support is inconsistent and not promised for v0.1 |
| MP4 fallback (WebCodecs + muxer) | Requires additional library, complexity |
| Advanced timeline segment editing | UI complexity, defer to future release |
| Cloud share link flow | Not in scope for v0.1 (local-first) |
| Multi-pass render acceleration | Performance optimization, defer |

---

## v0.1.0 Definition

**Focus:** Core recording + editor workflow with WebM export.

- Local-first (no cloud, no network upload)
- WebM is the supported export path
- Clear errors for unsupported tabs and failed capture startup
- Basic validation around trim and settings values

---

## Hardening Completed In This Pass

- Popup now loads saved defaults and reports clearer status text
- Unsupported Chrome or extension tabs are rejected before recording starts
- Session failures are marked as errored instead of silently failing
- Editor actions stay disabled until a valid session is loaded
- Invalid trim ranges are blocked before save/export
- Options save path validates allowed values

---

## Next Steps After v0.1

1. **MP4 export**: Re-evaluate only when browser support is stable enough to promise.
2. **Advanced editing**: Add richer timeline controls without weakening the simple export flow.
3. **Performance**: Improve export speed and storage behavior for longer captures.
4. **Sharing**: Add cloud or local share flows only after the core local workflow is stable.

---

## Verification Checklist

- [ ] Extension loads in Chrome without console errors after hardening
- [ ] Popup renders and loads saved defaults
- [ ] Starting on an unsupported tab shows the expected user-facing error
- [ ] Recording starts, pauses, resumes, and stops on a normal website tab
- [ ] Editor loads at least one recorded session
- [ ] Invalid trim input is rejected with a clear message
- [ ] Rendered WebM export produces a playable file
- [ ] Raw WebM download works
- [ ] Options persist after closing and reopening the popup

*Last reviewed: 2026-03-16*
