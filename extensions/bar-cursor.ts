/**
 * Keep Pi's input caret as an accent-colored, self-blinking bar cursor
 * (not the default reverse-video block).
 *
 * v4 changes:
 * - Caret on a grapheme now inserts the accent `│` bar BEFORE the glyph
 *   instead of reverse-video-tinting the glyph. The character stays visible
 *   and uncolored, so arrow-key movement no longer shows an accent block
 *   "covering" the character, and IME composition text (pinyin) is never
 *   tinted with the accent color.
 * - Blink still swaps bar↔space (or bar+glyph ↔ space+glyph) so the column
 *   width never changes — nothing jumps or shifts.
 * - v3 had: caret-on-glyph → accent reverse-video of that glyph, which
 *   looked like a covering accent block and tinted pinyin under the caret.
 * - Do NOT force showHardwareCursor. A visible hardware caret during agent
 *   activity produced a flickering bar + stray IME preview at the wrong spot.
 *   Hidden hardware cursor still gets positioned for IME via CURSOR_MARKER.
 * - Keep stripping fake blocks on Editor and Input prototypes so all
 *   editors/dialogs show the same accent caret.
 */
import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Input, type TUI } from "@earendil-works/pi-tui";

// Editor uses \x1b[0m; Input uses \x1b[27m. Match both.
const FAKE_BLOCK_CURSOR = /\x1b\[7m([\s\S]*?)\x1b\[(?:0|27)m/g;

/** Blink cadence (ms) — matches typical terminal caret blink (~530ms half-period). */
const CURSOR_BLINK_MS = 530;

let patched = false;
let accentFg = "\x1b[38;2;138;190;183m"; // fallback: dark theme accent (#8abeb7)

// Self-drawn blink state.
let blinkOn = true;
let blinkTimer: ReturnType<typeof setInterval> | null = null;
/** Editor instance last rendered while focused — target for re-renders. */
let focusedEditor: (TUI & { focused?: boolean }) | null = null;
let focusedEditorTui: TUI | null = null;

function makeBarCursor(): string {
	return `${accentFg}\u2502\x1b[0m`;
}

/**
 * Replace pi's fake reverse-video block caret with our accent caret.
 * The caret column width never changes between blink phases (bar↔space),
 * so nothing jumps or shifts while blinking.
 * Returns the same array (mutated in place).
 */
function stripFakeBlock(lines: string[]): string[] {
	const bar = makeBarCursor();
	for (let i = 0; i < lines.length; i++) {
		lines[i] = lines[i].replace(FAKE_BLOCK_CURSOR, (_match, captured: string) => {
			if (blinkOn) {
				// On phase: show the accent caret.
				if (captured.trim() === "") {
					// Caret at end-of-text (block is an inverted space) → accent bar.
					return bar;
				}
				// Caret on a grapheme → accent bar inserted BEFORE the glyph, so the
				// character under the caret stays visible and uncolored (no reverse-video
				// block over it, and IME composition text like pinyin is never tinted).
				return `${bar}${captured}`;
			}
			// Off phase: a space takes the bar's column so the caret's column width
			// never changes (no jump/flicker) — the glyph itself stays untouched.
			if (captured.trim() === "") {
				return " ";
			}
			return ` ${captured}`;
		});
	}
	return lines;
}

function startBlink(): void {
	if (blinkTimer) return;
	blinkTimer = setInterval(() => {
		blinkOn = !blinkOn;
		// Re-render the focused editor so the new phase shows up.
		if (focusedEditorTui && focusedEditor?.focused) {
			focusedEditorTui.requestRender();
		}
	}, CURSOR_BLINK_MS);
}

function stopBlink(): void {
	if (blinkTimer) {
		clearInterval(blinkTimer);
		blinkTimer = null;
	}
}

function patchEditorRender(): void {
	if (patched) return;
	patched = true;

	// Patch the Editor class that CustomEditor actually extends in THIS process.
	// This survives setEditorComponent(undefined) restoring the default editor.
	const editorProto = Object.getPrototypeOf(CustomEditor.prototype) as {
		render: (width: number) => string[];
	};
	const originalEditorRender = editorProto.render;
	editorProto.render = function (this: any, width: number): string[] {
		focusedEditor = this;
		focusedEditorTui = this.tui ?? null;
		if (this.focused) {
			startBlink();
		} else {
			stopBlink();
		}
		return stripFakeBlock(originalEditorRender.call(this, width));
	};

	const inputProto = Input.prototype as {
		render: (width: number) => string[];
	};
	const originalInputRender = inputProto.render;
	inputProto.render = function (this: unknown, width: number): string[] {
		return stripFakeBlock(originalInputRender.call(this, width));
	};
}

export default function (pi: ExtensionAPI) {
	// Patch as early as possible (module evaluate + extension bind)
	patchEditorRender();

	pi.on("session_start", (_event, ctx) => {
		patchEditorRender();
		// Capture the current theme's accent foreground for the fake caret.
		try {
			const theme = (ctx.ui as any)?.theme;
			if (theme?.getFgAnsi) {
				accentFg = theme.getFgAnsi("accent");
			}
		} catch {
			// keep fallback
		}
	});
}
