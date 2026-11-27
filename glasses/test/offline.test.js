// No signal: check-ins wait on the phone, show on the lens, and go out once, in order, with their own time.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, until, syncReply, wait } from './harness.js';

let online = true;
const refused = new Set();
const cut = (fn) => (body) => { if (!online) throw new TypeError('fetch failed'); return fn(body); };
const app = await startApp({
  routes: {
    '/api/sync': cut(() => syncReply()),
    '/api/checkin': cut((b) => (refused.has(b.at) ? { status: 400, error: 'run ended' } : { ok: true })),
  },
});
after(() => app.done());
await until(() => /Next check-in/.test(app.all()), 4000, 'main screen');
const delivered = () => app.sent('/api/checkin').filter((r) => r.body.at);
const stored = () => JSON.parse(app.glasses.storage.get('callout.queue') || '[]');

test('with no signal, two check-ins wait on the phone and the lens says so', async () => {
  online = false;
  app.tap();
  await until(() => /saved\. Sends when signal returns/.test(app.all()), 2000, 'saved note');
  await wait(20);
  app.tap();
  await until(() => stored().length === 2, 2000, 'two stored');
  await until(() => /2 waiting to send/.test(app.all()), 7000, 'waiting count');
  const [a, b] = stored();
  assert.ok(a.at <= b.at);
  assert.equal(delivered().length, 0);
});

test('when the signal returns they go out once each, oldest first, with the time they were made', async () => {
  const made = stored().map((x) => x.at);
  online = true;
  await until(() => delivered().length === 2, 30000, 'both sent');
  assert.deepEqual(delivered().map((r) => r.body.at), made);
  await until(() => stored().length === 0 && !/waiting to send/.test(app.all()), 7000, 'queue empty');
  await wait(300);
  assert.equal(delivered().length, 2);
});

test('an item the server refuses is dropped, so it cannot block the ones behind it', async () => {
  online = false;
  app.tap();
  await until(() => stored().length === 1, 2000, 'first stored');
  await wait(20);
  app.tap();
  await until(() => stored().length === 2, 2000, 'second stored');
  const [first, second] = stored().map((x) => x.at);
  refused.add(first);
  online = true;
  await until(() => delivered().some((r) => r.body.at === second), 30000, 'second sent');
  await until(() => stored().length === 0, 2000, 'queue empty');
});
