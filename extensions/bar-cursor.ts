/**
 * Keep Pi's input caret as an accent-colored, blinking hardware bar cursor.
 *
 * Pi renders a fake reverse-video caret in the Editor/Input output. A text
 * glyph cannot be drawn on top of a character without consuming a column, so
 * the extension removes only the fake SGR styling and leaves the original
 * grapheme in place. The terminal's hardware cursor then draws the bar at the
 * CURSOR_MARKER column, overlaying the same cell without shifting any text.
 *
 * While the agent is active, the hardware cursor remains visible, and the
 * editor stays focused with CURSOR_MARKER in the rendered output. This keeps
 * the normal caret available for continued input while Windows Terminal keeps
 * any IME composition anchored at the real editor position. Windows Terminal
 * does not expose its TSF composition state to the PTY client, so the plugin
 * cannot safely hide the cursor only during the uncommitted pinyin phase.
 */
import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Input, type TUI } from "@earendil-works/pi-tui";

// Editor uses \x1b[0m; Input uses \x1b[27m. Match both.
const FAKE_BLOCK_CURSOR = /\x1b\[7m([\s\S]*?)\x1b\[(?:0|27)m/g;

// DECSCUSR: 5 = blinking bar, 0 = terminal default.
const CURSOR_SHAPE_BLINKING_BAR = "\x1b[5 q";
const CURSOR_BLINK_ENABLE = "\x1b[?12h";
const CURSOR_SHAPE_DEFAULT = "\x1b[0 q";

// OSC 12 sets the terminal cursor color; OSC 112 restores its configured color.
const CURSOR_COLOR_RESET = "\x1b]112\x07";
const SHARED_STATE = Symbol.for("pi-bar-cursor.shared-state");
const TERMINAL_WRITE_STATE = Symbol.for("pi-bar-cursor.terminal-write-state");
const SYNC_OUTPUT_END = "\x1b[?2026l";

type RenderMethod = (this: any, width: number) => string[];
type TerminalLike = {
	write: (data: string) => void;
};
type TerminalWriteState = {
	owner: CursorState;
	originalWrite: (data: string) => void;
	pendingSyncEnd: string;
};

type CursorState = {
	active: boolean;
	generation: number;
	lastTui: TUI | null;
	cursorColor: string;
	exitCleanupInstalled: boolean;
	visibilityTui: TUI | null;
	visibilityGeneration: number;
	terminalWriteStates: Set<TerminalWriteState>;
	editorOriginalRender?: RenderMethod;
	inputOriginalRender?: RenderMethod;
};

const DARK_THEME_ACCENT = "#8abeb7";
let state: CursorState;
let boundGeneration = 0;

function getOrCreateSharedState(proto: object): CursorState {
	const holder = proto as Record<PropertyKey, unknown>;
	const existing = holder[SHARED_STATE] as CursorState | undefined;
	if (existing) {
		existing.terminalWriteStates ??= new Set();
		return existing;
	}

	const created: CursorState = {
		active: false,
		generation: 0,
		lastTui: null,
		cursorColor: DARK_THEME_ACCENT,
		exitCleanupInstalled: false,
		visibilityTui: null,
		visibilityGeneration: -1,
		terminalWriteStates: new Set(),
	};
	Object.defineProperty(holder, SHARED_STATE, {
		configurable: false,
		enumerable: false,
		writable: false,
		value: created,
	});
	return created;
}

function attachSharedState(proto: object, shared: CursorState): CursorState {
	const holder = proto as Record<PropertyKey, unknown>;
	const existing = holder[SHARED_STATE] as CursorState | undefined;
	if (existing) return existing;
	Object.defineProperty(holder, SHARED_STATE, {
		configurable: false,
		enumerable: false,
		writable: false,
		value: shared,
	});
	return shared;
}

function writeRaw(data: string): void {
	try {
		process.stdout.write(data);
	} catch {
		// Ignore non-TTY/shutdown writes.
	}
}

function captureCursorColor(fgAnsi: string): void {
	const rgb = /\x1b\[38;2;(\d+);(\d+);(\d+)m/.exec(fgAnsi);
	if (rgb) {
		state.cursorColor = `#${Number(rgb[1]).toString(16).padStart(2, "0")}${Number(rgb[2])
			.toString(16)
			.padStart(2, "0")}${Number(rgb[3]).toString(16).padStart(2, "0")}`;
	}
}

function applyCursorAppearance(): void {
	if (!state.active) return;
	writeRaw(`\x1b]12;${state.cursorColor}\x07${CURSOR_SHAPE_BLINKING_BAR}${CURSOR_BLINK_ENABLE}`);
}

function restoreCursorAppearance(): void {
	writeRaw(`${CURSOR_SHAPE_DEFAULT}${CURSOR_COLOR_RESET}`);
}

function installTerminalWriteOrdering(tui: TUI): void {
	const terminal = (tui as any).terminal as TerminalLike | undefined;
	if (!terminal || typeof terminal.write !== "function") return;

	const holder = terminal as TerminalLike & Record<PropertyKey, unknown>;
	const existing = holder[TERMINAL_WRITE_STATE] as TerminalWriteState | undefined;
	if (existing) {
		existing.owner = state;
		state.terminalWriteStates.add(existing);
		return;
	}

	const writeState: TerminalWriteState = {
		owner: state,
		originalWrite: terminal.write.bind(terminal),
		pendingSyncEnd: "",
	};
	Object.defineProperty(holder, TERMINAL_WRITE_STATE, {
		configurable: false,
		enumerable: false,
		writable: false,
		value: writeState,
	});

	terminal.write = (data: string): void => {
		if (writeState.pendingSyncEnd) {
			const pending = writeState.pendingSyncEnd;
			writeState.pendingSyncEnd = "";
			writeState.originalWrite(data);
			writeState.originalWrite(pending);
			return;
		}

		if (!writeState.owner.active) {
			writeState.originalWrite(data);
			return;
		}

		const end = data.lastIndexOf(SYNC_OUTPUT_END);
		if (end !== -1 && end + SYNC_OUTPUT_END.length === data.length) {
			// TUI currently releases synchronized output before positioning the
			// hardware cursor. Windows Terminal can paint IME composition at the
			// last screen-write position during that gap. Keep the frame open until
			// the following position command has been written.
			writeState.originalWrite(data.slice(0, end));
			writeState.pendingSyncEnd = SYNC_OUTPUT_END;
			return;
		}

		writeState.originalWrite(data);
	};

	state.terminalWriteStates.add(writeState);
}

function flushPendingTerminalWrites(): void {
	for (const writeState of state.terminalWriteStates) {
		if (!writeState.pendingSyncEnd) continue;
		const pending = writeState.pendingSyncEnd;
		writeState.pendingSyncEnd = "";
		writeState.originalWrite(pending);
	}
}

function setHardwareCursorVisible(visible: boolean, tui = state.lastTui): void {
	if (!tui) return;
	state.lastTui = tui;
	installTerminalWriteOrdering(tui);
	try {
		if (tui.getShowHardwareCursor() !== visible) {
			tui.setShowHardwareCursor(visible);
		}
	} catch {
		// TUI may already be tearing down during reload/quit.
	}
}

/**
 * Pi starts with the hardware cursor hidden. Re-enable it only after a
 * focused Editor render has emitted CURSOR_MARKER, and do it in a microtask
 * so the current TUI render has completed before the follow-up repaint.
 */
function ensureHardwareCursorVisible(tui: TUI): void {
	if (!state.active) return;
	const generation = state.generation;
	if (state.visibilityTui === tui && state.visibilityGeneration === generation) return;

	state.visibilityTui = tui;
	state.visibilityGeneration = generation;
	queueMicrotask(() => {
		if (!state.active || state.lastTui !== tui || state.generation !== generation) return;
		try {
			if (!tui.getShowHardwareCursor()) tui.setShowHardwareCursor(true);
		} catch {
			// TUI may already be tearing down during reload/quit.
		}
	});
}

function installExitCleanup(): void {
	if (state.exitCleanupInstalled) return;
	state.exitCleanupInstalled = true;
	process.once("exit", () => {
		flushPendingTerminalWrites();
		if (state.active) restoreCursorAppearance();
	});
}

/**
 * Strip only Pi's fake caret styling. The captured grapheme/space is kept at
 * exactly its original width. The hardware cursor overlays the marker column.
 *
 * Do not remove CURSOR_MARKER here. pi-tui must continue to see it so the
 * hardware cursor remains at the editor position for Windows IME anchoring.
 */
function stripFakeBlock(lines: string[]): string[] {
	return lines.map((line) => line.replace(FAKE_BLOCK_CURSOR, (_match, captured: string) => captured));
}

function patchEditorRender(): void {
	const editorProto = Object.getPrototypeOf(CustomEditor.prototype) as {
		render: RenderMethod;
	};
	const inputProto = Input.prototype as {
		render: RenderMethod;
	};

	state = getOrCreateSharedState(editorProto);
	attachSharedState(inputProto, state);

	// /reload re-evaluates this module while keeping pi-tui's prototypes alive.
	// Capture each native render once, then replace the current wrapper from that
	// native method on every load so wrappers never accumulate or retain stale
	// module state.
	if (!state.editorOriginalRender) {
		state.editorOriginalRender = editorProto.render;
	}
	const originalEditorRender = state.editorOriginalRender;
	editorProto.render = function (this: any, width: number): string[] {
		const lines = originalEditorRender.call(this, width);
		if (this.tui) {
			const tui = this.tui as TUI;
			state.lastTui = tui;
			installTerminalWriteOrdering(tui);
			const hasMarker = lines.some((line: string) => line.includes("\x1b_pi:c\x07"));
			if (state.active && this.focused && hasMarker) {
				// Keep the hardware cursor visible during agent activity as well.
				// Windows Terminal does not send an observable composition-start event
				// to the PTY client, so hiding it based on agent activity would hide
				// the caret even when the user is not entering Chinese pinyin.
				ensureHardwareCursorVisible(tui);
			}
		}
		return stripFakeBlock(lines);
	};

	if (!state.inputOriginalRender) {
		state.inputOriginalRender = inputProto.render;
	}
	const originalInputRender = state.inputOriginalRender;
	inputProto.render = function (this: unknown, width: number): string[] {
		return stripFakeBlock(originalInputRender.call(this, width));
	};
}

export default function (pi: ExtensionAPI) {
	// Patch as early as possible (module evaluate + extension bind).
	patchEditorRender();

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		boundGeneration = ++state.generation;
		state.active = true;
		state.lastTui = null;
		state.visibilityTui = null;
		state.visibilityGeneration = -1;
		installExitCleanup();
		try {
			captureCursorColor(ctx.ui.theme.getFgAnsi("accent"));
		} catch {
			// Keep the dark-theme fallback.
		}
		applyCursorAppearance();
	});

	pi.on("agent_start", (_event, ctx) => {
		if (ctx.mode !== "tui" || boundGeneration !== state.generation || !state.active) return;
		// Keep the editor focused, marker-bearing, and visibly caret-bearing while
		// the model works. Windows Terminal does not expose composition state to
		// the PTY client, so agent activity alone must not hide the caret.
		setHardwareCursorVisible(true);
	});

	// Keep the hardware cursor visible through agent_end: automatic retry/compaction
	// or queued continuation can still run. agent_settled restores its appearance.
	pi.on("agent_settled", (_event, ctx) => {
		if (ctx.mode !== "tui" || boundGeneration !== state.generation || !state.active) return;
		applyCursorAppearance();
		setHardwareCursorVisible(true);
	});

	pi.on("session_shutdown", (event) => {
		if (!state.active || boundGeneration !== state.generation) return;
		flushPendingTerminalWrites();
		setHardwareCursorVisible(false);
		state.active = false;
		state.lastTui = null;
		state.visibilityTui = null;
		state.visibilityGeneration = -1;
		if (event.reason === "quit") {
			// Return both properties to Windows Terminal's profile defaults.
			restoreCursorAppearance();
		}
	});
}
