# Changelog

## 0.1.1

- Fix invisible `/open-tui` overlays and delayed settings/questionnaire navigation in native Herdr while using Pi `regular` mode. The v0.1.0 cursor-ordering wrapper withheld `CSI ?2026l` until the next `terminal.write()`. A cursorless overlay only calls `ProcessTerminal.hideCursor()`, which writes directly to stdout, leaving Herdr waiting for the frame to finish.
- Preserve synchronous IME cursor ordering, but flush any deferred end marker in a microtask after the current render stack. A later frame can no longer inherit an unfinished earlier frame.
- Upgrade the live terminal-write wrapper on `/reload` without stacking wrappers; flush any pending legacy frame before replacing it.
- Keep bar shape/color, zero-width cursor marker, and regular/fullscreen settings unchanged. Do not remove screen clears or modify Pi/Herdr core packages.
- Add 13 protocol regression tests and 2 integration tests against the real Pi 1.1.0 regular renderer; GitHub Actions verifies Windows and Linux on Node 24.
