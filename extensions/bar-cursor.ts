/**
 * Keep Pi's input caret as a terminal bar cursor (not reverse-video block).
 *
 * Why the first version regressed after output/commands:
 * - Pi always draws a fake cursor with inverse video (\x1b[7m...\x1b[0m)
 * - Custom editor factories get cleared on reload / session rebind
 * - Hardware cursor is hidden/shown every render; shape can fall back to block
 *
 * Fix:
 * 1. Patch Editor.prototype.render (via CustomEditor's prototype chain) so ALL
 *    editors — default and custom — strip the fake block
 * 2. Also patch Input.prototype for dialogs
 * 3. Re-assert DECSCUSR bar shape after every show-cursor sequence
 * 4. Keep showHardwareCursor enabled
 */
import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Input } from "@earendil-works/pi-tui";

// Steady vertical bar. Alternatives: 5 blink bar, 4 steady underline, 2 steady block
const CURSOR_SHAPE_BAR = "\x1b[6 q";
const CURSOR_SHAPE_BLOCK = "\x1b[2 q";
const SHOW_CURSOR = "\x1b[?25h";

// Editor uses \x1b[0m; Input uses \x1b[27m. Match both.
const FAKE_BLOCK_CURSOR = /\x1b\[7m([\s\S]*?)\x1b\[(?:0|27)m/g;

let patched = false;
let stdoutPatched = false;
let active = false;
let lastShapeAt = 0;

function requestBarShape(force = false): void {
	if (!active && !force) return;
	const now = Date.now();
	// Avoid spamming the terminal every paint; still re-assert often enough
	// that hide/show + big redraws can't leave us stuck on block for long.
	if (!force && now - lastShapeAt < 80) return;
	lastShapeAt = now;
	try {
		process.stdout.write(CURSOR_SHAPE_BAR);
	} catch {
		// ignore non-TTY
	}
}

function stripFakeBlock(lines: string[]): string[] {
	requestBarShape();
	return lines.map((line) => line.replace(FAKE_BLOCK_CURSOR, "$1"));
}

function patchStdoutShowCursor(): void {
	if (stdoutPatched) return;
	stdoutPatched = true;

	const stdout = process.stdout as NodeJS.WriteStream & {
		write: (...args: any[]) => any;
	};
	const originalWrite = stdout.write.bind(stdout);

	stdout.write = ((chunk: any, encoding?: any, cb?: any) => {
		if (active && chunk != null) {
			if (typeof chunk === "string") {
				if (chunk.includes(SHOW_CURSOR)) {
					// Re-assert bar immediately after the terminal makes the caret visible.
					chunk = chunk.split(SHOW_CURSOR).join(SHOW_CURSOR + CURSOR_SHAPE_BAR);
					lastShapeAt = Date.now();
				}
			} else if (Buffer.isBuffer(chunk)) {
				const text = chunk.toString("utf8");
				if (text.includes(SHOW_CURSOR)) {
					chunk = Buffer.from(
						text.split(SHOW_CURSOR).join(SHOW_CURSOR + CURSOR_SHAPE_BAR),
						"utf8",
					);
					lastShapeAt = Date.now();
				}
			}
		}
		return originalWrite(chunk, encoding, cb);
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

	patchStdoutShowCursor();
}

function applyHardwareCursor(ctx: {
	ui: {
		setShowHardwareCursor?: (enabled: boolean) => void;
		setEditorComponent?: (factory: any) => void;
	};
}): void {
	ctx.ui.setShowHardwareCursor?.(true);
	requestBarShape(true);

	// Optional: keep a no-op custom editor so other extensions can still wrap us.
	// Primary protection is the prototype patch above.
	const current = (ctx.ui as any).getEditorComponent?.();
	if (!current) {
		ctx.ui.setEditorComponent?.((tui: any, theme: any, kb: any) => {
			tui.setShowHardwareCursor?.(true);
			requestBarShape(true);
			return new CustomEditor(tui, theme, kb);
		});
	}
}

export default function (pi: ExtensionAPI) {
	// Patch as early as possible (module evaluate + extension bind)
	patchEditorRender();

	pi.on("session_start", (_event, ctx) => {
		active = true;
		patchEditorRender();
		applyHardwareCursor(ctx);
	});

	// After agent activity / big UI churn, force shape again
	for (const event of ["agent_end", "agent_settled", "turn_end", "message_end"] as const) {
		pi.on(event as any, () => {
			if (!active) return;
			requestBarShape(true);
		});
	}

	pi.on("session_shutdown", (event) => {
		active = false;
		// Only restore block when leaving pi entirely; keep bar across /reload.
		if (event.reason === "quit") {
			try {
				process.stdout.write(CURSOR_SHAPE_BLOCK);
			} catch {
				// ignore
			}
		}
	});
}
