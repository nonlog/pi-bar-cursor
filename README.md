# pi-bar-cursor

Pi coding-agent extension that replaces the filled reverse-video **block** caret with a terminal **bar** cursor (`|`).

## Why

Pi draws a fake caret with inverse video (`\x1b[7m...\x1b[0m`). That looks like a solid box. This extension:

1. Strips the fake block from `Editor` / `Input` renders (prototype patch so it survives editor rebinds)
2. Enables the hardware cursor (`showHardwareCursor`)
3. Re-asserts a steady bar shape via DECSCUSR (`CSI 6 SP q`) after every show-cursor sequence and after agent turns

## Install

```bash
pi install npm:pi-bar-cursor
```

Or from git:

```bash
pi install git:github.com/nonlog/pi-bar-cursor
```

Then `/reload` (or restart Pi).

Also recommended in `~/.pi/agent/settings.json`:

```json
{
  "showHardwareCursor": true
}
```

## Usage

No commands. After install, the input caret should stay a bar.

### If it still looks like a block

Your terminal may ignore DECSCUSR. Set the terminal cursor shape to **Bar**:

- **Windows Terminal**: Settings → Appearance → Cursor shape → Bar  
  or `"cursorShape": "bar"` in the profile

## Notes

- On Pi quit, the extension restores a steady block shape so other apps are not stuck on bar.
- `/reload` keeps the bar shape (does not restore block).
- Compatible with `@earendil-works/pi-coding-agent` / `@earendil-works/pi-tui`.

## License

MIT
