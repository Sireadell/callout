import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, start, settle } from './helpers.js';
import { makeStatus } from '../server/status.js';

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


test('the status page shows parts and counts, and no names, ids, keys or positions', async () => {
  const s = setup();
  const { token, run } = await start(s);
  s.engine.clue(token, { text: 'Person inside', pos: { lat: 51.50123, lng: -0.12456 } }); await settle();
  s.engine.endRun(run.id);
  const env = { RENDER_GIT_COMMIT: 'abcdef1234567', ASSEMBLYAI_API_KEY: 'secret-key', CALLOUT_DEV: '1' };
  const page = makeStatus({ engine: s.engine, env, parts: { telegram: () => true }, startedAt: 0, now: () => 9000 })();
  assert.deepEqual([page.commit, page.uptimeSeconds, page.runsEnded, page.parts.speechToText, page.parts.ai, page.parts.testRoutes], ['abcdef1', 9, 1, 'on', 'off', 'on']);
  assert.equal(page.timings.clueToChat.samples, 1);
  assert.doesNotMatch(JSON.stringify(page), /Ana|Wardens|Person|secret-key|-500|51[.]5/);
});
