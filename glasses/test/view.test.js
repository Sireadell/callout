import { test } from 'node:test';
import assert from 'node:assert/strict';
import { glanceText, fmtClock, MENU, PRESET_CLUES, confirmText, listenText, isOk, okText } from '../src/view.js';

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

test('low battery and no signal show on the lens, plain glyphs only', () => {
  const base = { token: 't', syncedAt: 0, sync: { runName: 'E', area: 'A', dueInMs: 1000, team: [] } };
  assert.match(glanceText({ ...base, device: { batteryLevel: 9, isCharging: false } }, 0), /▲ Glasses battery 9%/);
  assert.doesNotMatch(glanceText({ ...base, device: { batteryLevel: 9, isCharging: true } }, 0), /battery/);
  assert.match(glanceText(base, 30000), /No signal/);
  assert.doesNotMatch(glanceText(base, 5000), /No signal/);
});

test('spoken OK accepts short answers only', () => {
  ['OK', 'Okay.', 'ok I am here', 'all good', 'Checking in'].forEach((t) => assert.ok(isOk(t), t));
  ['', 'Person inside', 'I think we should go back to the road and check it is okay for everyone'].forEach((t) => assert.ok(!isOk(t), t));
  assert.doesNotMatch(okText(1), /SOS|emergency|\p{Extended_Pictographic}/u);
});
