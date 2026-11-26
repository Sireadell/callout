import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, until, wait, E } from './harness.js';

const app = await startApp();
after(() => app.done());
await until(() => /Next check-in/.test(app.all()), 4000, 'main screen');
const closed = () => app.requests.filter((r) => r.body.app === 'closed');

test('leaving the app sends one closed note, then nothing more, with the microphone off', async () => {
  app.press(E.LONG_PRESS_EVENT);
  await until(() => app.glasses.mic, 2000, 'mic');
  app.press(E.FOREGROUND_EXIT_EVENT);
  await until(() => closed().length === 1, 2000, 'closed note');
  assert.deepEqual(closed()[0].body, { token: 'tok', app: 'closed', reason: 'foreground_exit' });
  assert.equal(closed()[0].keepalive, true);
  const after = app.requests.length;
  await wait(6500);
  assert.equal(app.requests.length, after);
  assert.equal(app.glasses.mic, false);
});

test('coming back syncs and sends a heartbeat again', async () => {
  const before = app.requests.length;
  const imu = app.glasses.imu;
  app.press(E.FOREGROUND_ENTER_EVENT);
  await until(() => app.requests.slice(before).some((r) => r.path === '/api/heartbeat') && app.requests.slice(before).some((r) => r.path === '/api/sync'), 3000, 'back');
  assert.equal(app.glasses.imu, imu + 1);
});

test('each way of closing has its own reason', async () => {
  app.press(E.ABNORMAL_EXIT_EVENT);
  await until(() => closed().length === 2);
  app.press(E.FOREGROUND_ENTER_EVENT);
  app.press(E.SYSTEM_EXIT_EVENT);
  await until(() => closed().length === 3);
  assert.deepEqual(closed().slice(1).map((r) => r.body.reason), ['abnormal_exit', 'system_exit']);
});

test('the exit the menu sends after a pick is not a closed app, and the backup question stays', async () => {
  app.press(E.FOREGROUND_ENTER_EVENT);
  await wait(50);
  const before = closed().length;
  app.menu(8);
  app.press(E.FOREGROUND_EXIT_EVENT);
  await until(() => /Ask the team for backup\?/.test(app.all()), 2000, 'backup question');
  await wait(300);
  assert.equal(closed().length, before);
  assert.match(app.all(), /Ask the team for backup\?/);
  app.tap();
  await until(() => app.sent('/api/backup').length === 1, 2000, 'backup sent');
});

test('a real exit a few seconds after a menu pick still counts', async () => {
  const before = closed().length;
  await wait(2100);
  app.press(E.FOREGROUND_EXIT_EVENT);
  await until(() => closed().length === before + 1, 2000, 'closed note');
});
