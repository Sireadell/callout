import { test } from 'node:test';
import assert from 'node:assert/strict';
import { glanceView, view, fit, BOXES, COLS, fmtClock, MENU, PRESET_CLUES, quickClues, confirmScreen, listenScreen, holdScreen, thinkScreen, isOk, okScreen, stillScreen, backupScreen, warnLine } from '../src/view.js';

const all = (v) => Object.values(v).join(' ');
const glanceText = (state, now) => all(glanceView(state, now));
const textOf = (sc) => [...sc.main, sc.hint].join(' ');

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
const fits = (v) => BOXES.forEach((b) => {
  const lines = v[b.key].split('\n');
  assert.ok(lines.length <= b.lines, `${b.key} has ${lines.length} lines`);
  lines.forEach((l) => assert.ok(l.length <= COLS, `${b.key} line too wide: ${l}`));
});

test('worst case: every box stays inside its line cap', () => {
  const long = 'word '.repeat(400);
  const state = {
    token: 't', syncedAt: 0, flash: long, queue: Array(20).fill({}), device: { batteryLevel: 3 },
    reply: { id: 'r', by: long, text: long, tappable: true },
    sync: { runName: long, area: long, dueInMs: -1000, team: Array(30).fill({ state: 'ok' }) },
  };
  fits(glanceView(state, 60000));
  fits(glanceView({ ...state, reply: null }, 60000));
  fits(glanceView({ ...state, reply: null, flash: '' }, 60000));
  [confirmScreen(long, 3), confirmScreen('x'.repeat(2000), 3), listenScreen(4), holdScreen(), thinkScreen(), okScreen(1), stillScreen(3), backupScreen()]
    .forEach((screen) => fits(view({ ...state, mode: 'x', screen, flash: '' }, 60000)));
  const v = glanceView(state, 60000);
  assert.match(v.main, /^▲ OVERDUE/);
  assert.match(v.main, /word/);
});

test('a reply takes the main box and the countdown moves underneath', () => {
  const state = { token: 't', syncedAt: 0, reply: { id: 'r', by: 'Sam', text: 'Return to base', tappable: true }, sync: { runName: 'E', area: 'A1', dueInMs: 60000, team: [] } };
  const v = glanceView(state, 0);
  assert.equal(v.main, 'Sam: Return to base');
  assert.match(v.status, /Next check-in 01:00/);
  assert.match(v.hint, /got it/);
  assert.match(glanceView({ ...state, reply: null }, 0).main, /^Next check-in 01:00\n\nA1/);
});

test('exactly one box takes input and the boxes do not overlap', () => {
  assert.equal(BOXES.filter((b) => b.capture === 1).length, 1);
  BOXES.slice(1).forEach((b, i) => assert.ok(b.y >= BOXES[i].y + BOXES[i].height));
  assert.ok(BOXES.at(-1).y + BOXES.at(-1).height <= 288);
  BOXES.forEach((b) => assert.ok(b.brightness >= 0 && b.brightness <= 4));
});

test('fit says when it cuts', () => {
  assert.match(fit(['a '.repeat(200)], 2), /\.\.\.$/);
  assert.equal(fit(['short'], 2), 'short');
});
test('menu fits the 10 item and 32 byte limits', () => {
  assert.ok(MENU.length <= 10);
  MENU.forEach((m) => assert.ok(Buffer.byteLength(m.itemName) <= 32 && m.itemID !== 0));
});

test('quick clues fit the list limits and screens have no emoji or alarm words', () => {
  assert.ok(PRESET_CLUES.length <= 20);
  PRESET_CLUES.forEach((c) => assert.ok(Buffer.byteLength(c) <= 64));
  const words = [textOf(confirmScreen('Road blocked', 3)), textOf(listenScreen(4)), textOf(holdScreen()), ...PRESET_CLUES].join(' ');
  assert.doesNotMatch(words, /SOS|emergency|\p{Extended_Pictographic}/u);
});
test('a long spoken clue is cut to fit the lens', () => {
  assert.ok(textOf(confirmScreen('x'.repeat(2000), 3)).length < 320);
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
  assert.doesNotMatch(textOf(okScreen(1)), /SOS|emergency|\p{Extended_Pictographic}/u);
});

test('menu offers backup and sign out, and no longer says End run', async () => {
  const names = MENU.map((m) => m.itemName);
  assert.ok(names.includes('Ask team for backup') && names.includes('Sign out'));
  assert.ok(!names.includes('End run'));
  assert.equal(new Set(MENU.map((m) => m.itemID)).size, MENU.length);
});
test('after the run ends the lens says so instead of "No signal"', async () => {
  assert.match(glanceText({ ended: true }), /Run finished/);
  assert.doesNotMatch(glanceText({ ended: true }), /No signal/);
});
test('backup and reply screens use team words, no alarm words', async () => {
  const text = [textOf(backupScreen()), glanceText({ token: 't', syncedAt: 0, reply: { by: 'Sam', text: 'Return to base' }, sync: { runName: 'E', area: 'A', dueInMs: 1000, team: [] } }, 0)].join(' ');
  assert.match(text, /Sam: Return to base/);
  assert.doesNotMatch(text, /SOS|emergency|urgent|help is coming|\p{Extended_Pictographic}/u);
});

test('the lens says how many items wait for signal', () => {
  const t = glanceText({ token: 't', syncedAt: 0, queue: [{}, {}], sync: { runName: 'E', area: 'A', dueInMs: 1000, team: [] } }, 0);
  assert.match(t, /2 waiting to send/);
});

test('an answer that denies or asks for help never checks in', () => {
  ["I'm not OK", 'not ok', 'Not okay.', "I'm not fine", 'no', 'No, not here', "I can't check in", 'I can’t, not fine', "this isn't ok", 'nope', 'never fine', 'help', 'OK help me', 'hurt but here', 'I am not here'].forEach((t) => assert.ok(!isOk(t), t));
  ['ok', 'OK.', 'yes', "I'm fine", 'okay now'].forEach((t) => assert.ok(isOk(t), t));
});

test('a gesture on a busy screen is answered on the hint line, and old messages do not leak onto it', () => {
  const state = { token: 't', syncedAt: 0, mode: 'think', screen: thinkScreen(), flash: '○ Still working...', flashMode: 'think', sync: { runName: 'E', area: 'A', dueInMs: 1000, team: [] } };
  assert.equal(view(state, 0).hint, '○ Still working...');
  assert.equal(view({ ...state, mode: 'listen', screen: holdScreen(), flashMode: 'glance' }, 0).hint, 'Let go to send.');
});

test('the first screen matches how the app was opened', () => {
  assert.match(glanceView({ launch: 'glassesMenu' }).main, /Take out your phone/);
  assert.match(glanceView({ launch: 'appMenu' }).main, /Enter your code/);
  assert.match(glanceView({}).main, /Enter your code/);
});

test("the run's quick clues replace the built in ones, at most 4 of 16 characters", () => {
  assert.ok(PRESET_CLUES.length <= 4 && PRESET_CLUES.every((c) => c.length <= 16));
  assert.deepEqual(quickClues(undefined), PRESET_CLUES);
  assert.deepEqual(quickClues([]), PRESET_CLUES);
  assert.deepEqual(quickClues(['Gate locked', ' ', 'x'.repeat(30), 'b', 'c', 'd']), ['Gate locked', 'x'.repeat(16), 'b', 'c']);
});

test('the join screens say what to send, and fit', () => {
  const waiting = glanceView({ join: { phase: 'waiting', code: '4821' } });
  assert.match(waiting.main, /Join code: 4821/);
  assert.match(waiting.main, /\/join 4821/);
  assert.match(glanceView({ join: { phase: 'claimed', name: 'Ana', team: 'Wardens' } }).main, /Hi Ana\./);
  assert.match(glanceView({ join: { phase: 'expired' } }).hint, /Tap: new code/);
  assert.match(glanceView({ join: { phase: 'error' } }).status, /Try again in a minute/);
  fits(glanceView({ join: { phase: 'claimed', name: 'x'.repeat(200), team: 'y'.repeat(200) }, flash: 'z '.repeat(100) }));
});

test('warnings that do not fit are left out whole, never cut mid-word', () => {
  assert.equal(warnLine(['▲ Glasses battery 9%', '○ No signal. Will retry.']), '▲ Glasses battery 9%');
  assert.equal(warnLine(['○ 2 waiting to send', '○ Question waiting']), '○ 2 waiting to send  ○ Question waiting');
  assert.equal(warnLine([]), '');
});
