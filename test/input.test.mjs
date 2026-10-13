import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseKey } from '../dist/browser.js';
import { InputParser } from '../dist/input.js';
import { applyReply } from '../dist/tty.js';

function collect(chunks) {
  const events = [];
  const p = new InputParser((e) => events.push(e), 5);
  for (const c of chunks) p.feed(c);
  return new Promise((resolve) => setTimeout(() => resolve(events), 20));
}

test('plain keys, arrows and alt combos', async () => {
  const ev = await collect(['ab\x1b[A\x1bb\r']);
  assert.deepEqual(
    ev.map((e) => e.seq),
    ['a', 'b', '\x1b[A', '\x1bb', '\r'],
  );
});

test('lone escape is flushed after the timeout', async () => {
  const ev = await collect(['\x1b']);
  assert.deepEqual(ev, [{ type: 'key', seq: '\x1b' }]);
});

test('sequences split across reads are reassembled', async () => {
  const ev = await collect(['\x1b[', '<0;12;', '7M', '\x1b[<0;12;7m']);
  assert.deepEqual(ev, [
    { type: 'mouse', code: 0, col: 12, row: 7, release: false },
    { type: 'mouse', code: 0, col: 12, row: 7, release: true },
  ]);
});

test('bracketed paste spanning chunks, with escapes inside', async () => {
  const ev = await collect(['x\x1b[200~line1\n\x1b[A', 'line2\x1b[20', '1~y']);
  assert.deepEqual(ev, [
    { type: 'key', seq: 'x' },
    { type: 'paste', text: 'line1\n\x1b[Aline2' },
    { type: 'key', seq: 'y' },
  ]);
});

test('terminal replies are separated from keys', async () => {
  const ev = await collect(['\x1b[6;32;16t\x1b_Gi=31337;OK\x1b\\\x1b]11;rgb:1e1e/1e1e/2020\x1b\\\x1b[?62;22c']);
  assert.ok(ev.every((e) => e.type === 'reply'));
  const caps = { fileTransfer: false };
  const kinds = ev.map((e) => applyReply(caps, e.seq));
  assert.deepEqual(kinds, ['cell', 'graphics', 'bg', 'da1']);
  assert.deepEqual(caps, { fileTransfer: false, cellH: 32, cellW: 16, graphics: true, background: [30, 30, 32] });
});

test('iTerm2 cell size: points times the reported scale, in either reply order', () => {
  for (const order of [[0, 1], [1, 0]]) {
    const replies = ['\x1b[6;17;8t', '\x1b]1337;ReportCellSize=17;7.83;2\x1b\\'];
    const caps = { fileTransfer: false };
    for (const i of order) assert.equal(applyReply(caps, replies[i]), 'cell');
    assert.deepEqual(caps, { fileTransfer: false, scale: 2, cellH: 34, cellW: 15.66 });
  }
});

test('emoji arrive as one key', async () => {
  const ev = await collect(['👍']);
  assert.deepEqual(ev, [{ type: 'key', seq: '👍' }]);
});

test('parseKey maps terminal sequences to browser keys', () => {
  assert.deepEqual(parseKey('\r'), { key: 'Enter', mods: [] });
  assert.deepEqual(parseKey('\x7f'), { key: 'Backspace', mods: [] });
  assert.deepEqual(parseKey('\x01'), { key: 'a', mods: ['Control'] });
  assert.deepEqual(parseKey('\x1b[1;5C'), { key: 'ArrowRight', mods: ['Control'] });
  assert.deepEqual(parseKey('\x1b[5~'), { key: 'PageUp', mods: [] });
  assert.deepEqual(parseKey('\x1bOA'), { key: 'ArrowUp', mods: [] });
  assert.deepEqual(parseKey('\x1b[Z'), { key: 'Tab', mods: ['Shift'] });
  assert.deepEqual(parseKey('\x1bx'), { text: 'x', mods: ['Alt'] });
  assert.deepEqual(parseKey('é'), { text: 'é', mods: [] });
});
