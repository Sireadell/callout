import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, syncReply, until, E } from './harness.js';

let dueInMs = 600000;
let over = false;
const question = { id: 'q_1', text: 'How many people?', by: 'Sam', answers: ['None', '1'] };
const app = await startApp({
  routes: { '/api/sync': () => (over ? { status: 400, error: 'run ended' } : syncReply({ dueInMs, question })) },
});
after(() => app.done());

test('a check-in that falls due takes over from an open question', async () => {
  await until(() => app.glasses.list, 4000, 'question');
  dueInMs = -1000;
  await until(() => /Check-in due/.test(app.all()), 9000, 'say OK window');
  assert.equal(app.glasses.list, null);
  assert.equal(app.sent('/api/answer').length, 0);
});

test('when the run ends while the microphone is open, it closes', async () => {
  app.press(E.LONG_PRESS_EVENT);
  await until(() => app.glasses.mic, 4000, 'mic open');
  over = true;
  await until(() => /Run finished/.test(app.all()), 9000, 'run finished');
  await until(() => !app.glasses.mic, 2000, 'mic closed');
});
