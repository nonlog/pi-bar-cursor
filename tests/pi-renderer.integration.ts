import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { flushPendingWrite, installOrderedWriter, SYNC_OUTPUT_BEGIN as B, SYNC_OUTPUT_END as E } from '../lib/terminal-write-order.ts';

const modulePath = process.env.PI_TUI_MODULE || '.ci-runtime/node_modules/@earendil-works/pi-tui/dist/index.js';
const { TuiMainScreen, Text } = await import(pathToFileURL(resolve(modulePath)).href);
const tick = () => new Promise<void>(resolve => queueMicrotask(resolve));
function setup() {
  const out: string[] = [];
  // Real ProcessTerminal helpers bypass write(), which is the important part
  // of the regression, not a mock that routes every helper through our wrapper.
  const terminal = {
    columns: 94, rows: 29,
    write: (s: string) => { out.push(s); },
    hideCursor: () => { out.push('\x1b[?25l'); },
    showCursor: () => { out.push('\x1b[?25h'); },
    start() {}, stop() {},
  };
  const tui = new TuiMainScreen(terminal, true);
  const state = installOrderedWriter(terminal, { active: true });
  tui.addChild(new Text('Stable transcript\nEditor', 0, 0));
  return { terminal, tui, state, out };
}
function assertClosed(out: string[]) {
  const text = out.join('');
  assert.equal(text.split(B).length, text.split(E).length, 'every sync frame has an end');
  assert.ok(text.includes(E));
}

test('real Pi regular renderer closes cursorless overlays immediately', async () => {
  const f = setup();
  f.tui.doRender();
  await tick();
  let selected = 0;
  const overlay = {
    render: () => ['Open TUI Settings', selected === 0 ? '> Enabled' : '  Enabled', selected === 1 ? '> Language' : '  Language'],
    invalidate() {},
    handleInput: () => { selected = 1 - selected; },
  };
  f.tui.showOverlay(overlay, { width: 30, anchor: 'center' });
  f.tui.doRender();
  await tick();
  assert.equal(f.state.pendingSyncEnd, '');
  assert.ok(f.out.join('').includes('Open TUI Settings'));
  assertClosed(f.out);
  for (let i = 0; i < 12; i++) {
    overlay.handleInput();
    f.tui.doRender();
    await tick();
    assert.equal(f.state.pendingSyncEnd, '', `selection ${i} is fully published`);
    assertClosed(f.out);
  }
  assert.equal(f.tui.mode, 'regular');
  flushPendingWrite(f.state);
});

test('real positionHardwareCursor(null) bypass does not strand a frame', async () => {
  const f = setup();
  f.terminal.write(B + 'settings frame' + E);
  f.tui.positionHardwareCursor(null, 9);
  await tick();
  assert.equal(f.state.pendingSyncEnd, '');
  assert.equal(f.out.join(''), B + 'settings frame\x1b[?25l' + E);
});
