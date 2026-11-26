import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, start, settle } from './helpers.js';

const said = (tg, re) => tg.out.filter((m) => re.test(m.text || ''));
const MIN = 60_000;

test('a closed app is reported at once with the time, and replaces "gone quiet"', async () => {
  const s = setup();
  const { token } = await start(s);
  s.engine.heartbeat(token, { app: 'closed', reason: 'system_exit' });
  s.engine.heartbeat(token, { app: 'closed', reason: 'system_exit' });
  s.clock.advance(5 * MIN); s.engine.tick(); await settle();
  const closed = said(s.tg, /the glasses app was closed at [0-9]{2}:[0-9]{2} UTC/);
  assert.equal(closed.length, 1);
  assert.equal(closed[0].extra.disable_notification, false);
  assert.equal(said(s.tg, /gone quiet/).length, 0);
  assert.equal(s.engine.teamStatus(Object.keys(s.engine.runs)[0])[0].state, 'silent');
  s.engine.heartbeat(token, {}); await settle();
  assert.equal(said(s.tg, /is back online/).length, 1);
});

test('a short move to the background is not reported; a long one is, after 20 seconds', async () => {
  const s = setup();
  const { token } = await start(s);
  s.engine.heartbeat(token, { app: 'closed', reason: 'foreground_exit' });
  s.clock.advance(10_000); s.engine.tick();
  s.engine.sync(token);
  s.clock.advance(30_000); s.engine.tick(); await settle();
  assert.equal(said(s.tg, /was closed/).length, 0);
  s.engine.heartbeat(token, { app: 'closed', reason: 'foreground_exit' });
  s.clock.advance(20_000); s.engine.tick(); s.engine.tick(); await settle();
  assert.equal(said(s.tg, /was closed/).length, 1);
});

test('after the app is gone and no closed message arrived, "gone quiet" still fires', async () => {
  const s = setup();
  await start(s);
  s.clock.advance(3 * MIN); s.engine.tick(); await settle();
  assert.equal(said(s.tg, /gone quiet/).length, 1);
});

