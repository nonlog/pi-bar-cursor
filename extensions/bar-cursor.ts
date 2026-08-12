/**
 * Keep Pi's input caret as an accent-colored bar cursor (not reverse-video block).
 *
 * v2 changes:
 * - Replace the reverse-video fake block with an accent-colored `│` glyph
 *   (theme accent foreground). No hardware-cursor dependency, so the caret
 *   never "jumps" or flickers while the agent streams / the screen scrolls.
 * - Do NOT force showHardwareCursor. A visible hardware caret during agent
 *   activity produced a flickering bar + stray IME preview at the wrong spot.
 *   Hidden hardware cursor still gets positioned for IME via CURSOR_MARKER.
 * - Keep stripping fake blocks on Editor and Input prototypes so all
 *   editors/dialogs show the same accent bar.
 */
import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Input } from "@earendil-works/pi-tui";

// Editor uses \x1b[0m; Input uses \x1b[27m. Match both.
const FAKE_BLOCK_CURSOR = /\x1b\[7m([\s\S]*?)\x1b\[(?:0|27)m/g;

let patched = false;
let accentFg = "\x1b[38;2;138;190;183m"; // fallback: dark theme accent (#8abeb7)

function makeBarCursor(): string {
	return `${accentFg}\u2502\x1b[0m`;
}

function stripFakeBlock(lines: string[]): string[] {
	const bar = makeBarCursor();
	return lines.map((line) => line.replace(FAKE_BLOCK_CURSOR, () => bar));
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
	editorProto.render = function (this: unknown, width: number): string[] {
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
