import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, syncReply, until, E } from './harness.js';

let voiceNotes;
const app = await startApp({
  routes: {
    '/api/sync': () => syncReply({ voiceNotes }),
    '/api/voice': () => ({ text: 'Gate locked', intent: { type: 'clue' } }),
  },
});
after(() => app.done());
await until(() => /Next check-in/.test(app.all()), 4000, 'main screen');

const speakAndSend = async () => {
  const before = app.sent('/api/clue').length;
  await app.say();
  await until(() => /Gate locked/.test(app.all()), 4000, 'confirm');
  const screen = app.all();
  await app.tap();
  await until(() => app.sent('/api/clue').length === before + 1, 4000, 'clue sent');
  return { screen, body: app.sent('/api/clue').at(-1).body };
};

test('with voice notes off no recording leaves with the clue', async () => {
  const { screen, body } = await speakAndSend();
  assert.doesNotMatch(screen, /with your voice/);
  assert.equal(body.audio, undefined);
});

test('with voice notes on the confirm screen says so and the recording goes with the clue', async () => {
  voiceNotes = true;
  await app.menu(1); // a check-in syncs at once
  await until(() => app.sent('/api/checkin').length === 1);
  await new Promise((r) => setTimeout(r, 200));
  const { screen, body } = await speakAndSend();
  assert.match(screen, /with your voice/);
  assert.equal(Buffer.from(body.audio, 'base64').length, 3200);
});

test('a cancelled clue sends nothing at all', async () => {
  const before = app.sent('/api/clue').length;
  await app.say();
  await until(() => /with your voice/.test(app.all()), 4000, 'confirm');
  app.press(E.SCROLL_BOTTOM_EVENT);
  await until(() => /Cancelled/.test(app.all()));
  await new Promise((r) => setTimeout(r, 3500));
  assert.equal(app.sent('/api/clue').length, before);
});
