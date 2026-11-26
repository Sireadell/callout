import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, until, wait, E } from './harness.js';
import { voiceAction } from '../src/view.js';

let heard = { text: '' };
const app = await startApp({ routes: { '/api/voice': () => heard } });
after(() => app.done());
await until(() => /Next check-in/.test(app.all()), 4000, 'main screen');

test('the words and the server intent decide the action, and a denial never checks in', () => {
  const act = (text, type, clue) => voiceAction({ text, intent: type && { type, clue } });
  assert.deepEqual(act('OK', 'checkin'), { type: 'checkin' });
  assert.equal(act("I'm not OK", 'checkin').type, 'clue');
  assert.deepEqual(act('road is blocked', 'quick_clue', 'Road blocked'), { type: 'clue', text: 'Road blocked' });
  assert.equal(act('backup', 'backup').type, 'backup');
  assert.equal(act('', 'none').type, 'none');
  assert.equal(act('Cancel.').type, 'cancel');
  assert.deepEqual(act('Person inside'), { type: 'clue', text: 'Person inside' });
});

test('hold, say OK, let go: checks in', async () => {
  heard = { text: 'All good.', intent: { type: 'checkin' } };
  const before = app.sent('/api/checkin').length;
  await app.say();
  await until(() => app.sent('/api/checkin').length === before + 1, 4000, 'check-in');
  await until(() => /Checked in/.test(app.all()));
  assert.equal(app.sent('/api/clue').length, 0);
  assert.equal(app.glasses.mic, false);
});

test('saying backup only opens the confirm screen', async () => {
  heard = { text: 'I need backup', intent: { type: 'backup' } };
  await app.say();
  await until(() => /Ask the team for backup\?/.test(app.all()), 4000, 'backup screen');
  await wait(300);
  assert.equal(app.sent('/api/backup').length, 0);
  app.press(E.SCROLL_BOTTOM_EVENT);
  await until(() => /Cancelled/.test(app.all()));
  assert.equal(app.sent('/api/backup').length, 0);
});

test('a quick clue by voice shows the list words and sends on a tap', async () => {
  heard = { text: 'the road is blocked', intent: { type: 'quick_clue', clue: 'Road blocked' } };
  await app.say();
  await until(() => /"Road blocked"/.test(app.all()), 4000, 'confirm screen');
  app.tap();
  await until(() => app.sent('/api/clue').length === 1, 4000, 'clue');
  assert.equal(app.sent('/api/clue')[0].body.text, 'Road blocked');
});

test('nothing heard says so and sends nothing', async () => {
  heard = { text: '', intent: { type: 'none' } };
  await app.say();
  await until(() => /Heard nothing/.test(app.all()));
  assert.equal(app.sent('/api/clue').length, 1);
});

test('a very short hold is not sent', async () => {
  const before = app.sent('/api/voice').length;
  app.press(E.LONG_PRESS_EVENT); await wait(80); app.press(E.LONG_PRESS_RELEASE_EVENT);
  await until(() => /Too short/.test(app.all()));
  assert.equal(app.sent('/api/voice').length, before);
  assert.equal(app.glasses.mic, false);
});

test('double press on the main screen opens only the exit dialog', async () => {
  const before = app.requests.filter((r) => r.path !== '/api/sync' && r.path !== '/api/heartbeat').length;
  app.press(E.DOUBLE_CLICK_EVENT);
  await wait(100);
  assert.deepEqual(app.glasses.exits, [1]);
  assert.equal(app.requests.filter((r) => r.path !== '/api/sync' && r.path !== '/api/heartbeat').length, before);
});
