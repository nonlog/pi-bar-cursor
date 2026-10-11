import assert from 'node:assert/strict';
import test from 'node:test';
import { flushPendingWrite, installOrderedWriter, SYNC_OUTPUT_BEGIN as B, SYNC_OUTPUT_END as E, TERMINAL_WRITE_STATE } from '../lib/terminal-write-order.ts';

function fixture(active = true) {
  const chunks: string[] = [];
  const terminal = { write: (data: string) => { chunks.push(data); } };
  const owner = { active };
  const state = installOrderedWriter(terminal, owner);
  return { terminal, owner, state, chunks, text: () => chunks.join('') };
}
const tick = () => new Promise<void>(resolve => queueMicrotask(resolve));
function assertBalanced(text: string) {
  let open = false;
  for (const m of text.matchAll(/\x1b\[\?2026([hl])/g)) {
    if (m[1] === 'h') { assert.equal(open, false, 'no nested frames'); open = true; }
    else { assert.equal(open, true, 'end belongs to an open frame'); open = false; }
  }
  assert.equal(open, false, 'frame must be closed without another input');
}

test('cursor positioning remains inside the rendered frame for IME', async () => {
  const f = fixture();
  f.terminal.write(B + 'frame' + E);
  assert.equal(f.state.pendingSyncEnd, E);
  f.terminal.write('\x1b[2A\x1b[5G');
  assert.equal(f.text(), B + 'frame\x1b[2A\x1b[5G' + E);
  await tick();
  assertBalanced(f.text());
  assert.equal(f.chunks.filter(c => c === E).length, 1);
});

test('cursorless overlay flushes by the end of the current turn', async () => {
  const f = fixture();
  f.terminal.write(B + 'Open TUI Settings' + E);
  // ProcessTerminal.hideCursor writes directly to stdout, bypassing write().
  f.chunks.push('\x1b[?25l');
  await tick();
  assert.equal(f.text(), B + 'Open TUI Settings\x1b[?25l' + E);
  assert.equal(f.state.pendingSyncEnd, '');
  assertBalanced(f.text());
});

test('every setting selection paints without waiting for another key', async () => {
  const f = fixture();
  for (let i = 0; i < 20; i++) {
    f.terminal.write(B + `selection-${i}` + E);
    await tick();
    assert.equal(f.state.pendingSyncEnd, '');
    assert.ok(f.text().endsWith(`selection-${i}` + E));
    assertBalanced(f.text());
  }
});

test('a synchronous new frame cannot absorb the previous frame end', async () => {
  const f = fixture();
  f.terminal.write(B + 'one' + E);
  f.terminal.write(B + 'two' + E);
  await tick();
  assert.equal(f.text(), B + 'one' + E + B + 'two' + E);
  assertBalanced(f.text());
});

test('split bounded writes preserve original content and cursor order', async () => {
  const f = fixture();
  f.terminal.write(B + 'first');
  f.terminal.write('second');
  f.terminal.write('third' + E);
  f.terminal.write('\x1b[1G');
  await tick();
  assert.equal(f.text(), B + 'firstsecondthird\x1b[1G' + E);
  assertBalanced(f.text());
});

test('a bare final frame marker is safely deferred and flushed', async () => {
  const f = fixture();
  f.terminal.write(B + 'body');
  f.terminal.write(E);
  await tick();
  assert.equal(f.text(), B + 'body' + E);
});

test('frames already followed by cursor output pass through verbatim', async () => {
  const f = fixture();
  const data = B + 'frame' + E + '\x1b[1G';
  f.terminal.write(data);
  await tick();
  assert.equal(f.text(), data);
});

test('inactive extension is transparent', async () => {
  const f = fixture(false);
  f.terminal.write(B + 'unchanged' + E);
  assert.equal(f.text(), B + 'unchanged' + E);
  await tick();
  assertBalanced(f.text());
});

test('deactivation cannot leave a pending synchronized frame', async () => {
  const f = fixture();
  f.terminal.write(B + 'last' + E);
  f.owner.active = false;
  await tick();
  assert.equal(f.state.pendingSyncEnd, '');
  assertBalanced(f.text());
});

test('shutdown flush is idempotent with the scheduled microtask', async () => {
  const f = fixture();
  f.terminal.write(B + 'last' + E);
  flushPendingWrite(f.state);
  flushPendingWrite(f.state);
  await tick();
  assert.equal(f.text(), B + 'last' + E);
});

test('reload reuses one writer and the current owner', async () => {
  const f = fixture();
  const originalWrapper = f.terminal.write;
  const nextOwner = { active: true };
  const again = installOrderedWriter(f.terminal, nextOwner);
  assert.equal(again, f.state);
  assert.equal(f.terminal.write, originalWrapper);
  f.owner.active = false;
  f.terminal.write(B + 'after-reload' + E);
  await tick();
  assertBalanced(f.text());
  assert.equal(again.owner, nextOwner);
});

test('upgrade flushes and replaces an existing v0.1.0 wrapper', async () => {
  const chunks: string[] = [B + 'old-overlay'];
  const terminal = { write: (_: string) => { throw new Error('legacy wrapper was called'); } };
  const legacy = { owner: { active: true }, originalWrite: (s: string) => chunks.push(s), pendingSyncEnd: E };
  Object.defineProperty(terminal, TERMINAL_WRITE_STATE, { value: legacy });
  const state = installOrderedWriter(terminal, { active: true });
  assert.equal(state, legacy);
  assert.equal(chunks.join(''), B + 'old-overlay' + E);
  terminal.write(B + 'fixed-overlay' + E);
  await tick();
  assert.equal(state.pendingSyncEnd, '');
  assertBalanced(chunks.join(''));
});

test('unrelated escape sequences and text remain byte-for-byte unchanged', async () => {
  const f = fixture();
  const data = '\x1b[5 q\x1b]12;#abcdef\x07\x1b_pi:c\x07abc\x1b[?25h';
  f.terminal.write(data);
  await tick();
  assert.equal(f.text(), data);
});
