# Release Notes Draft: v0.1.0

## Summary

`chrome-video-recorder` v0.1.0 delivers the first scoped release for local tab recording with interaction capture and rendered WebM export.

## Included

- Current-tab recording through an MV3 offscreen pipeline
- Optional microphone and tab-audio capture
- Cursor, click, scroll, and viewport event capture
- Floating in-page recording controller
- Session browser with preview and non-destructive trim
- Rendered WebM export with cinematic click-focus effects
- Raw WebM download and diagnostics copy
- Options page for default capture settings

## Hardening In This Pass

- Popup now loads saved defaults and reports clearer recording states
- Starting on unsupported tabs now fails with a direct explanation instead of a vague error
- Recording failures now mark the saved session as errored
- Editor actions are disabled until a valid session is loaded
- Trim input validation now blocks invalid or too-short exports
- Raw download and diagnostics copy now show actionable error messages
- Options page now validates supported values before saving
- README and release docs now describe WebM-first scope and known limitations more accurately

## Known Limitations

- WebM is the supported export format for v0.1
- MP4 is not a release commitment
- No cloud upload or sharing flow
- No advanced timeline editing
- Best suited to moderate-length recordings

## Suggested Release Message

`Cinematic Tab Recorder v0.1.0 is a focused first release: record the current tab, capture cursor and click context, trim in the built-in editor, and export polished WebM locally. This version intentionally stays narrow and reliable: no cloud flow, no advanced editing, and WebM is the supported export path.`
