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
5. Hides the hardware cursor and removes the marker while the agent is working,
   preventing a visible caret and stray IME composition previews near the
   `Working...` row.
6. Restores the cursor shape and color on quit with `DECSCUSR 0` and `OSC 112`.

## Install

```bash
pi install git:github.com/nonlog/pi-bar-cursor
```

Then run `/reload` or restart Pi.

Keep Pi's `showHardwareCursor` setting false. The extension enables the
hardware cursor only while the editor is idle/focused and hides it during
agent activity.

## Usage

No commands are required. While idle, the editor caret is a blinking,
accent-colored hardware bar. The underlying text is never replaced, tinted, or
shifted when moving the caret with the arrow keys.

During agent activity the caret is hidden. It returns when the agent reaches the
fully settled idle state.

The same fake-caret cleanup is applied to Pi's `Editor` and `Input` prototypes,
including editors created by `pi-claude-code-tui`.

## Customizing

To use a fixed cursor color, change the fallback `cursorColor` in
`extensions/bar-cursor.ts`. The extension normally derives the color from
`ctx.ui.theme.getFgAnsi("accent")`.

To use a steady bar instead of a blinking bar, change:

```ts
const CURSOR_SHAPE_BAR = "\x1b[5 q";
```

to:

```ts
const CURSOR_SHAPE_BAR = "\x1b[6 q";
```

## Notes

- Requires `@earendil-works/pi-coding-agent` / `@earendil-works/pi-tui` 0.84.x
  or a compatible version exposing `CURSOR_MARKER` and hardware-cursor control.
- The extension is designed to coexist with `pi-claude-code-tui`.
- Windows Terminal supports the DECSCUSR, OSC 12, and OSC 112 sequences used
  here.
