/**
 * Keep Pi's input caret as an accent-colored, blinking hardware bar cursor.
 *
 * Pi renders a fake reverse-video caret in the Editor/Input output. A text
 * glyph cannot be drawn on top of a character without consuming a column, so
 * the extension removes only the fake SGR styling and leaves the original
 * grapheme in place. The terminal's hardware cursor then draws the bar at the
 * CURSOR_MARKER column, overlaying the same cell without shifting any text.
 *
 * While the agent is active, the hardware cursor and marker are suppressed:
 * this prevents a visible caret and prevents Windows IME composition previews
 * from being repeatedly repositioned into the scrolling transcript/Working
 * row. When the agent settles, the marker and blinking hardware bar return.
 */
import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Input, type TUI } from "@earendil-works/pi-tui";

// Editor uses \x1b[0m; Input uses \x1b[27m. Match both.
const FAKE_BLOCK_CURSOR = /\x1b\[7m([\s\S]*?)\x1b\[(?:0|27)m/g;
const CURSOR_MARKER = "\x1b_pi:c\x07";

// DECSCUSR: 5 = blinking bar, 0 = terminal's configured default shape.
const CURSOR_SHAPE_BAR = "\x1b[5 q";
const CURSOR_SHAPE_DEFAULT = "\x1b[0 q";
const SHOW_CURSOR = "\x1b[?25h";

// OSC 12 sets the terminal cursor color; OSC 112 restores its configured color.
const CURSOR_COLOR_RESET = "\x1b]112\x07";

let patched = false;
let stdoutPatched = false;
let active = false;
let agentActive = false;
let lastTui: TUI | null = null;
let cursorColor = "#8abeb7"; // dark theme accent fallback
let rawStdoutWrite: ((chunk: any, encoding?: any, callback?: any) => any) | null = null;

function writeRaw(data: string): void {
	try {
		if (rawStdoutWrite) {
			rawStdoutWrite(data);
		} else {
			process.stdout.write(data);
		}
	} catch {
		// Ignore non-TTY/shutdown writes.
	}
}

function captureCursorColor(fgAnsi: string): void {
	const rgb = /\x1b\[38;2;(\d+);(\d+);(\d+)m/.exec(fgAnsi);
	if (rgb) {
		cursorColor = `#${Number(rgb[1]).toString(16).padStart(2, "0")}${Number(rgb[2])
			.toString(16)
			.padStart(2, "0")}${Number(rgb[3]).toString(16).padStart(2, "0")}`;
	}
}

function applyCursorAppearance(): void {
	if (!active) return;
	writeRaw(`\x1b]12;${cursorColor}\x07${CURSOR_SHAPE_BAR}`);
}

function setHardwareCursorVisible(visible: boolean): void {
	if (!lastTui) return;
	try {
		if (lastTui.getShowHardwareCursor() !== visible) {
			lastTui.setShowHardwareCursor(visible);
		}
	} catch {
		// TUI may already be tearing down during reload/quit.
	}
}

function requestCursorRender(): void {
	try {
		lastTui?.requestRender();
	} catch {
		// TUI may already be tearing down during reload/quit.
	}
}

/**
 * Strip only Pi's fake caret styling. The captured grapheme/space is kept at
 * exactly its original width. The hardware cursor overlays the marker column.
 */
function stripFakeBlock(lines: string[]): string[] {
	return lines.map((line) => {
		const withoutFakeStyle = line.replace(FAKE_BLOCK_CURSOR, (_match, captured: string) => captured);
		return agentActive ? withoutFakeStyle.split(CURSOR_MARKER).join("") : withoutFakeStyle;
	});
}

function patchStdoutShowCursor(): void {
	if (stdoutPatched) return;
	stdoutPatched = true;

	const stdout = process.stdout as NodeJS.WriteStream & {
		write: (...args: any[]) => any;
	};
	rawStdoutWrite = stdout.write.bind(stdout);

	stdout.write = ((chunk: any, encoding?: any, callback?: any) => {
		let output = chunk;
		if (active && chunk != null) {
			if (typeof chunk === "string") {
				if (chunk.includes(SHOW_CURSOR)) {
					output = chunk.split(SHOW_CURSOR).join(`${SHOW_CURSOR}${CURSOR_SHAPE_BAR}`);
				}
			} else if (Buffer.isBuffer(chunk)) {
				const text = chunk.toString("utf8");
				if (text.includes(SHOW_CURSOR)) {
					output = Buffer.from(text.split(SHOW_CURSOR).join(`${SHOW_CURSOR}${CURSOR_SHAPE_BAR}`), "utf8");
				}
			}
		}
		return rawStdoutWrite?.(output, encoding, callback);
	}) as typeof stdout.write;
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
		if (this.tui) {
			lastTui = this.tui as TUI;
			// Keep each newly-created TUI in the correct lifecycle state too. This
			// matters after reloads/session switches while an agent is active.
			if (active) {
				setHardwareCursorVisible(!agentActive);
			}
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

	patchStdoutShowCursor();
}

export default function (pi: ExtensionAPI) {
	// Patch as early as possible (module evaluate + extension bind).
	patchEditorRender();

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		active = true;
		agentActive = false;
		try {
			captureCursorColor(ctx.ui.theme.getFgAnsi("accent"));
		} catch {
			// Keep the dark-theme fallback.
		}
		applyCursorAppearance();
		setHardwareCursorVisible(true);
		requestCursorRender();
	});

	pi.on("agent_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		agentActive = true;
		setHardwareCursorVisible(false);
		// If the setting was already false, setShowHardwareCursor() is a no-op;
		// explicitly repaint so the marker is still removed from the current frame.
		requestCursorRender();
	});

	// Keep the cursor hidden through agent_end: automatic retry/compaction or
	// queued continuation can still run. agent_settled is the true idle point.
	pi.on("agent_settled", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		agentActive = false;
		applyCursorAppearance();
		setHardwareCursorVisible(true);
		requestCursorRender();
	});

	pi.on("session_shutdown", (event) => {
		if (!active) return;
		active = false;
		agentActive = false;
		if (event.reason === "quit") {
			// Return both properties to Windows Terminal's profile defaults.
			writeRaw(`${CURSOR_SHAPE_DEFAULT}${CURSOR_COLOR_RESET}`);
		}
	});
}
