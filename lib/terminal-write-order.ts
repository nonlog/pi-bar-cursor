/**
 * Keep Pi's synchronous cursor-position write inside its synchronized frame,
 * but NEVER leave a frame waiting for a future key, timer, or render.
 *
 * Cursorless overlays call ProcessTerminal.hideCursor(), which writes directly
 * to stdout instead of terminal.write(). A microtask closes those frames after
 * the current render stack, preserving IME ordering without freezing Herdr.
 */
export const SYNC_OUTPUT_BEGIN = "\x1b[?2026h";
export const SYNC_OUTPUT_END = "\x1b[?2026l";
export const TERMINAL_WRITE_STATE = Symbol.for("pi-bar-cursor.terminal-write-state");
const ORDERING_VERSION = 2;

export type TerminalLike = { write: (data: string) => void };
export type TerminalWriteState = {
  owner: { active: boolean };
  originalWrite: (data: string) => void;
  pendingSyncEnd: string;
  flushScheduled?: boolean;
  orderingVersion?: number;
};

export function flushPendingWrite(state: TerminalWriteState): void {
  const pending = state.pendingSyncEnd;
  if (!pending) return;
  state.pendingSyncEnd = "";
  state.originalWrite(pending);
}

function writeOrdered(state: TerminalWriteState, data: string): void {
  if (state.pendingSyncEnd) {
    if (data.includes(SYNC_OUTPUT_BEGIN)) {
      // A second render may occur synchronously. Its opening frame marker is
      // not a cursor position command: finish the previous frame first.
      flushPendingWrite(state);
    } else {
      // Pi's positionHardwareCursor() normally reaches this path in the same
      // call stack as rendering. Cursor motion stays inside synchronized output.
      try {
        state.originalWrite(data);
      } finally {
        flushPendingWrite(state);
      }
      return;
    }
  }

  if (!state.owner.active || !data.endsWith(SYNC_OUTPUT_END)) {
    state.originalWrite(data);
    return;
  }

  const body = data.slice(0, -SYNC_OUTPUT_END.length);
  if (body) state.originalWrite(body);
  state.pendingSyncEnd = SYNC_OUTPUT_END;
  if (!state.flushScheduled) {
    state.flushScheduled = true;
    queueMicrotask(() => {
      state.flushScheduled = false;
      flushPendingWrite(state);
    });
  }
}

/** Reuse the original writer and shared symbol across Pi /reload operations. */
export function installOrderedWriter(terminal: TerminalLike, owner: { active: boolean }): TerminalWriteState {
  const holder = terminal as TerminalLike & Record<PropertyKey, unknown>;
  let state = holder[TERMINAL_WRITE_STATE] as TerminalWriteState | undefined;
  if (state) {
    state.owner = owner;
    if (state.orderingVersion === ORDERING_VERSION) return state;
    // Upgrade a live v0.1.0 wrapper instead of retaining its buggy closure.
    flushPendingWrite(state);
  } else {
    state = { owner, originalWrite: terminal.write.bind(terminal), pendingSyncEnd: "" };
    Object.defineProperty(holder, TERMINAL_WRITE_STATE, {
      configurable: false, enumerable: false, writable: false, value: state,
    });
  }
  state.orderingVersion = ORDERING_VERSION;
  state.flushScheduled = false;
  const current = state;
  terminal.write = (data: string): void => writeOrdered(current, data);
  return state;
}
