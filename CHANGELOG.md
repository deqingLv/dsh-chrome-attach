# Changelog

All notable changes to this project. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.8] — 2026-10-27

### Added

- The `+` menu row now also writes the captured page's **title and URL** into the same draft as one plain-text line (`Chrome 标签页：<title> — <url>`), so the model can tell which page the screenshot shows. The host already returned `title`/`url`; until now they only reached a toast.

### Changed

- The page line goes through the composer's own `inputActions` façade, which the conversation publishes to session slots as a prop; the plugin registers a headless `conversation.input.dock` entry to hold on to it. Insertion therefore obeys the façade's phase and draft-revision guards, and the plugin still never touches the session directly.
- When the façade refuses (message being sent, no editable draft), the image still attaches and the toast reports the skipped line.

## [0.2.7] — 2026-10-27

### Added

- `cdp`: connect through Chrome's own **Remote debugging** switch (`chrome://inspect/#remote-debugging`). The normal profile — logins, tabs, extensions — stays untouched, and no `--user-data-dir` workaround is needed.

### Changed

- `cdp`: one browser-level WebSocket with flat sessions, reused across clicks, so the approval prompt appears once per DSH process instead of once per capture.
- README rewritten for the public repository, with an English and a Chinese edition.

### Fixed

- `cdp`: close the cached DevTools connection on plugin teardown instead of leaking a socket per DSH shutdown.

## [0.2.6] — 2026-10-27

First public snapshot.

### Added

- Composer `+` menu row **Attach Chrome** and the `/attach` command; the screenshot lands in the draft and is only sent on Enter.
- Three-tier capture with automatic degradation: `bridge` (`cb` CLI) → `cdp` (DevTools port) → `window` (macOS `screencapture`).
- Authenticated loopback route `POST /api/chrome-attach/shot`, including `{"full":true}` for full-page captures where the tier supports it.
- macOS window fallback with window bounds via Chrome's AppleScript dictionary, long-edge downscaling, and a Screen Recording permission hint.
