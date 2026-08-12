# pi-bar-cursor

Pi coding-agent extension that replaces the filled reverse-video **block** caret with an accent-colored **bar** cursor (`│`).

## Why

Pi draws a fake caret with inverse video (`\x1b[7m...\x1b[0m`). That looks like a solid box. This extension:

1. Strips the fake block from `Editor` / `Input` renders (prototype patch so it survives editor rebinds)
2. Replaces it with a `│` glyph colored with the theme's **accent** color (same color family as the `pi-claude-code-tui` caret)
3. Self-draws the **blink**: while the editor is focused, a 530ms timer flips the caret on/off and triggers `tui.requestRender()` (v3)

## Why not the hardware cursor / DECSCUSR?

The first version enabled the hardware cursor and asserted a bar shape via DECSCUSR (`CSI 6 SP q`). That produced two problems in practice:

- While the agent streams output and the screen scrolls, the visible hardware caret appears at the wrong spot and "jumps" (and can show stray IME composition previews).
- Windows Terminal does not reliably re-apply its configured default cursor shape after a DECSCUSR override, leaving a block caret after quitting pi.

The fake-glyph approach avoids all of that: the caret is drawn only inside the editor's own render output, so it never escapes into the scrolling transcript, and nothing is written to the terminal on quit.

## Install

```bash
pi install git:github.com/nonlog/pi-bar-cursor
```

Then `/reload` (or restart Pi).

No `showHardwareCursor` setting is needed. In fact, keep it **false** (the default) so the hardware caret stays hidden during agent activity.

## Usage

No commands. After install, the input caret is an accent-colored bar (`│`) inside the editor and all input dialogs. The caret **blinks** while the editor is focused, and stops while the agent streams.

The accent color tracks the active theme: switching themes re-reads `theme.getFgAnsi("accent")` on `session_start`.

### Caret-on-glyph behavior

- At the end of the input the caret is a `│` bar.
- When the caret sits **on** a grapheme (e.g. arrow keys into a word), the grapheme itself is shown in accent reverse-video — the character under the caret is never replaced or hidden, so moving left/right never "covers" or drops a character.
- The blink swaps bar↔space and reverse-video↔plain, so the column width never changes (no jump/flicker).

## Customizing

To use a plain ASCII `|` instead of the box-drawing `│`, change the `\u2502` escape in `extensions/bar-cursor.ts` to `"|"`. To pick a fixed color instead of the theme accent, replace `accentFg`'s fallback value.

## Notes

- Compatible with `@earendil-works/pi-coding-agent` / `@earendil-works/pi-tui`.
- Coexists with `pi-claude-code-tui`: both patch the fake cursor at render time; whichever patches later wins per line, and both render an accent-colored caret.
- The caret is static (does not blink) because it is a drawn glyph, not the terminal's hardware cursor.
