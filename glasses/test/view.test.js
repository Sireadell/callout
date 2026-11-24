import { test } from 'node:test';
import assert from 'node:assert/strict';
import { glanceText, fmtClock, MENU, PRESET_CLUES, confirmText, listenText } from '../src/view.js';

test('clock formats and goes negative', () => {
  assert.equal(fmtClock(125000), '02:05');
  assert.equal(fmtClock(-5000), '-00:05');
});
test('unpaired screen tells you what to do', () => {
  assert.match(glanceText({}), /Not paired/);
});
test('overdue shows a warning glyph, no emoji, no alarm words', () => {
  const t = glanceText({ token: 't', syncedAt: 0, sync: { runName: 'Elm', area: 'A1', dueInMs: -1000, team: [] } }, 0);
  assert.match(t, /▲ OVERDUE/);
  assert.doesNotMatch(t, /SOS|emergency|\p{Extended_Pictographic}/u);
});
test('text stays under the container limit', () => {
  const t = glanceText({ token: 't', syncedAt: 0, flash: 'x'.repeat(2000), sync: { runName: 'E', area: 'A', dueInMs: 1000, team: [] } }, 0);
  assert.ok(t.length <= 900);
});
test('menu fits the 10 item and 32 byte limits', () => {
  assert.ok(MENU.length <= 10);
  MENU.forEach((m) => assert.ok(Buffer.byteLength(m.itemName) <= 32 && m.itemID !== 0));
});

test('quick clues fit the list limits and screens have no emoji or alarm words', () => {
  assert.ok(PRESET_CLUES.length <= 20);
  PRESET_CLUES.forEach((c) => assert.ok(Buffer.byteLength(c) <= 64));
  const all = [confirmText('Road blocked', 3), listenText(4), ...PRESET_CLUES].join(' ');
  assert.doesNotMatch(all, /SOS|emergency|\p{Extended_Pictographic}/u);
});
test('a long spoken clue is cut to fit the lens', () => {
  assert.ok(confirmText('x'.repeat(2000), 3).length < 450);
});
