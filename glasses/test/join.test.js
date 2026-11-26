import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, until, wait, E } from './harness.js';

let status = { state: 'waiting' };
let codes = 0;
const app = await startApp({
  storage: {},
  routes: {
    '/api/join': () => { codes += 1; return { code: codes === 1 ? '4821' : '9034', secret: `s${codes}`, expiresInMs: 600000, bot: null }; },
    '/api/join/status': () => status,
  },
});
after(() => app.done());

test('an unpaired lens shows a join code and asks nothing else of the server', async () => {
  await until(() => /Join code: 4821/.test(app.all()), 4000, 'code');
  app.tap();
  await wait(100);
  assert.equal(codes, 1);
  assert.equal(app.sent('/api/checkin').length, 0);
});

test('an expired code is replaced only on a tap', async () => {
  status = { state: 'expired' };
  await until(() => /expired/.test(app.all()), 6000, 'expired');
  await wait(3500);
  assert.equal(codes, 1);
  status = { state: 'waiting' };
  app.tap();
  await until(() => /Join code: 9034/.test(app.all()), 4000, 'new code');
});

test('claimed, then paired: the token is stored and the run shows', async () => {
  status = { state: 'claimed', name: 'Ana', team: 'Wardens' };
  await until(() => /Hi Ana\./.test(app.all()), 6000, 'claimed');
  status = { state: 'paired', token: 'tok_new', runId: 'run_x', name: 'Ana', area: 'Area A1', team: 'Wardens', nextDueAt: 0 };
  await until(() => /Joined Wardens/.test(app.all()), 6000, 'paired');
  assert.equal(app.glasses.storage.get('callout.token'), 'tok_new');
  assert.ok(app.sent('/api/sync').some((r) => r.body.token === 'tok_new'));
  const polls = app.sent('/api/join/status').length;
  await wait(3500);
  assert.equal(app.sent('/api/join/status').length, polls);
});

test('double press before or after pairing still only opens the exit dialog', async () => {
  app.press(E.DOUBLE_CLICK_EVENT);
  await wait(50);
  assert.deepEqual(app.glasses.exits, [1]);
});
