# pi-bar-cursor

Pi coding-agent extension that replaces the fake reverse-video block caret with
an accent-colored, blinking **hardware bar cursor**.

## Why

Pi's `Editor` and `Input` components render a fake caret as inverse video:

```text
ESC[7m<grapheme>ESC[0m
```

Replacing that span with a drawn `│` glyph works only when the caret is at the
end of the text. When the caret is on a character, inserting a glyph consumes a
new terminal column and shifts all following text. A terminal hardware cursor
is the correct overlay mechanism: it occupies no column and is positioned at
Pi's zero-width `CURSOR_MARKER`.

This extension therefore:

1. Removes only the fake reverse-video SGR codes, preserving the original
   grapheme and its exact width.
2. Keeps Pi's `CURSOR_MARKER` unchanged so `pi-tui` positions the hardware
   cursor at the logical caret location.
3. Sets the hardware cursor to a blinking bar (`CSI 5 SP q`).
4. Sets the hardware cursor color to the active Pi theme accent via `OSC 12`.
5. Keeps the editor focus, marker, and hardware cursor in place while the
   agent is working, so the normal caret remains available for continued input
   while the `Working...` row updates.
6. Restores the cursor shape and color on quit with `DECSCUSR 0` and `OSC 112`.

## Install

```bash
pi install git:github.com/nonlog/pi-bar-cursor
```

Then run `/reload` or restart Pi.

Keep Pi's `showHardwareCursor` setting false. The extension enables the
hardware cursor after the focused editor has rendered its marker and keeps it
visible during agent activity. The marker and editor focus remain available for
IME positioning and continued input.

## Usage

No commands are required. While idle, the editor caret is a blinking,
accent-colored hardware bar. The underlying text is never replaced, tinted, or
shifted when moving the caret with the arrow keys.

During agent activity the accent-colored hardware bar remains visible, while
the editor stays focused and accepts input. The marker remains in the rendered
output for IME anchoring. Windows Terminal does not expose its uncommitted TSF
composition state to the PTY client, so the plugin cannot reliably hide the bar
only during the pinyin phase.

The same fake-caret cleanup is applied to Pi's `Editor` and `Input` prototypes,
including editors created by `pi-open-tui`.

## Customizing

To use a fixed cursor color, change the fallback `cursorColor` in
`extensions/bar-cursor.ts`. The extension normally derives the color from
`ctx.ui.theme.getFgAnsi("accent")`.

The extension uses `CSI 5 SP q` and enables cursor blinking. The hardware
cursor remains visible during agent activity because Pi cannot observe
Windows Terminal's internal composition-start/end state. It restores the normal
blinking appearance after `agent_settled`.

For Windows Terminal IME positioning, synchronized TUI output is held open
until Pi's following hardware-cursor position command has been written. This
prevents the IME composition overlay from being painted at the last row written
by a `Working...` or footer refresh.

## Notes

- Requires `@earendil-works/pi-coding-agent` / `@earendil-works/pi-tui` 0.84.x
  or a compatible version exposing `CURSOR_MARKER` and hardware-cursor control.
- The extension is designed to coexist with `pi-open-tui` and other custom
  editors that preserve Pi's `CURSOR_MARKER`.
- Windows Terminal supports the DECSCUSR, `CSI ? 12 h/l`, OSC 12, and OSC 112
  sequences used here.
