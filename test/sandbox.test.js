import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeSandboxes, sandboxRequest } from '../server/sandbox.js';
import * as shim from '../server/public/try-sdk.js';
import { settle } from './helpers.js';

const clockAt = (t = 1_000_000) => ({ t, now() { return this.t; } });
async function open(sandboxes, caller = 'a') {
  const { id, code } = await sandboxes.create(caller);
  const call = async (path, body = {}, method = 'POST') => (await sandboxRequest(sandboxes, { method, path: `/try/s/${id}${path}`, caller, readBody: async () => body }))?.json;
  const joined = await call('/api/pair', { code });
  await settle();
  return { id, call, token: joined.token, area: joined.area };
}

test('a visitor gets a practice team: pair, check in, clue, button reply, back to the lens', async () => {
  const sandboxes = makeSandboxes({ clock: clockAt() });
  const { call, token, area } = await open(sandboxes);
  assert.equal(area, 'Area A1');
  await call('/api/checkin', { token });
  await call('/api/clue', { token, text: 'Gate is locked' });
  await settle();
  let view = await call('/chat', {}, 'GET');
  const clue = view.messages.find((m) => /Gate is locked/.test(m.text) && m.buttons.length);
  assert.ok(clue, 'the clue reaches the panel with buttons');
  view = await call('/chat', { press: clue.buttons[0].data, messageId: clue.message_id });
  assert.match(view.note, /Sent to Alex/);
  const lens = await call('/api/sync', { token });
  assert.equal(lens.replies[0].text, 'Stay where you are');
});

test('the coordinator box takes commands and replies, through the real bot', async () => {
  const sandboxes = makeSandboxes({ clock: clockAt() });
  const { call, token } = await open(sandboxes);
  await call('/chat', { say: '/ask Alex is the road open?' });
  const q = (await call('/api/sync', { token })).question;
  assert.equal(q.text, 'is the road open?');
  await call('/api/answer', { token, questionId: q.id, answer: q.answers[0] });
  await settle();
  const answer = (await call('/chat', {}, 'GET')).messages.find((m) => /answered/.test(m.text));
  await call('/chat', { say: 'Thanks, wait there', replyTo: answer.message_id });
  assert.equal((await call('/api/sync', { token })).replies.at(-1).text, 'Thanks, wait there');
});

test('typed words are read like speech', async () => {
  const sandboxes = makeSandboxes({ clock: clockAt() });
  const { call, token } = await open(sandboxes);
  assert.equal((await call('/api/voice', { token, devText: 'I am OK' })).intent.type, 'checkin');
  assert.equal((await call('/api/voice', { token, audio: 'AAAA' })).text, '', 'no speech service, no words');
});

test('real recordings go to speech to text only within the limits', async () => {
  let calls = 0;
  const sandboxes = makeSandboxes({ clock: clockAt(), voicePerSandbox: 2, voicePerDay: 3, stt: { transcribe: async () => { calls += 1; return 'House empty'; } } });
  for (const who of ['a', 'b']) {
    const { call, token } = await open(sandboxes, who);
    for (let i = 0; i < 4; i++) await call('/api/voice', { token, audio: 'AAAA' });
  }
  assert.equal(calls, 3);
});

test('practice teams are separate, expire, and are limited in number', async () => {
  const clock = clockAt();
  const sandboxes = makeSandboxes({ clock, max: 2, perCaller: 2, ttlMs: 1000 });
  const one = await open(sandboxes, 'a');
  const two = await open(sandboxes, 'b');
  await assert.rejects(() => two.call('/api/checkin', { token: one.token }), /unknown token/);
  await assert.rejects(() => sandboxes.create('c'), /in use/);
  clock.t += 1001;
  await assert.rejects(() => one.call('/chat', {}, 'GET'), /ended/);
  assert.equal(sandboxes.count(), 0);
  await sandboxes.create('a');
  await assert.rejects(() => sandboxes.create('a'), /too many/);
});

test('a practice team shows a missed check-in notice on its short timers', async () => {
  const clock = clockAt();
  const sandboxes = makeSandboxes({ clock });
  const { call } = await open(sandboxes);
  clock.t += 2 * 60_000 + 31_000;
  sandboxes.tick();
  await settle();
  const view = await call('/chat', {}, 'GET');
  assert.ok(view.messages.some((m) => /Missed check-in notice: Alex/.test(m.text)));
});

test('the page serves the real lens code and nothing else from disk', async () => {
  const sandboxes = makeSandboxes({ clock: clockAt() });
  const get = (path) => sandboxRequest(sandboxes, { method: 'GET', path, caller: 'a', readBody: async () => ({}) });
  const main = await get('/try/app/main.js');
  assert.equal(String(main.file), fs.readFileSync(new URL('../glasses/src/main.js', import.meta.url), 'utf8'));
  assert.ok((await get('/try')).file.length > 1000);
  assert.equal(await get('/try/app/../../.env'), null);
  assert.equal(await get('/try/../server/index.js'), null);
});

test('the stand-in kit gives the lens code every name it imports, with the real values', async () => {
  const main = fs.readFileSync(new URL('../glasses/src/main.js', import.meta.url), 'utf8');
  const wanted = main.match(/import \{([^}]+)\} from '@evenrealities\/even_hub_sdk'/)[1].split(',').map((s) => s.trim());
  for (const name of wanted) assert.ok(name in shim, `${name} is missing`);
  let real;
  try { real = await import('../glasses/node_modules/@evenrealities/even_hub_sdk/dist/index.js'); } catch { return; } // glasses packages not installed here
  for (const [name, values] of Object.entries(shim)) {
    if (typeof values !== 'object') continue;
    for (const [key, value] of Object.entries(values)) assert.equal(real[name][key], value, `${name}.${key}`);
  }
});
