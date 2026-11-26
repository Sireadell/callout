import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../server/engine.js';
import { makeRoutes, describeCaller, callerOf } from '../server/api.js';

function setup(env = {}) {
  const clock = { t: 1_000_000, now() { return this.t; }, advance(ms) { this.t += ms; } };
  const engine = new Engine({ clock });
  const team = engine.addTeam({ name: 'Wardens' });
  const run = engine.startRun({ teamId: team.id, name: 'Elm Street' });
  const { code, volunteer } = engine.addVolunteer(run.id, { name: 'Ana', area: 'A1' });
  const { token } = engine.pair(code);
  const stt = { transcribe: async () => 'road blocked' };
  const routes = makeRoutes({ engine, stt, env });
  return { clock, engine, run, token, id: volunteer.id, routes };
}

test('a coordinator reply that arrives while the microphone is open is not lost', async () => {
  const { engine, run, token, id, routes } = setup();
  engine.reply(run.id, { volunteerId: id, text: 'Come back' });
  await routes['POST /api/voice']({ token, audio: '' });
  assert.equal(routes['POST /api/sync']({ token }).replies[0].text, 'Come back');
});

test('voice needs a valid sign-in key', async () => {
  const { routes } = setup();
  await assert.rejects(async () => routes['POST /api/voice']({ token: 'nope', audio: '' }), /unknown token/);
});

test('the rate limit log line shows a proxy without printing full addresses', () => {
  const line = describeCaller({ headers: { 'x-forwarded-for': '203.0.113.9, 10.1.2.3' }, socket: { remoteAddress: '::ffff:10.20.30.40' } });
  assert.equal(line, 'rate limit sees 10.20.x; forwarded-for entries: 2, first 203.0.x, same as seen: no');
  assert.doesNotMatch(line, /113\.9|30\.40/);
});

test('voice returns the words and what they ask for, and sends nothing by itself', async () => {
  const { engine, run, token, routes } = setup({ CALLOUT_DEV: '1' });
  const sent = []; engine.notify = (n) => sent.push(n);
  const r = await routes['POST /api/voice']({ token, devText: 'I need backup' });
  assert.deepEqual(r, { text: 'I need backup', intent: { type: 'backup' } });
  await routes['POST /api/voice']({ token, devText: 'OK' });
  assert.equal(sent.length, 0);
  assert.equal(Object.values(engine.runs[run.id].volunteers)[0].checkins, 0);
});

test('behind the host relay the limit counts each caller, and a sent header cannot fake one', () => {
  const req = (direct, forwarded) => ({ socket: { remoteAddress: direct }, headers: forwarded ? { 'x-forwarded-for': forwarded } : {} });
  assert.equal(callerOf(req('::ffff:10.20.30.40', '203.0.113.9, 172.70.0.1, 10.1.2.3')), '203.0.113.9');
  assert.equal(callerOf(req('10.20.30.40', '198.51.100.7, 172.70.0.1, 10.1.2.3')), '198.51.100.7');
  assert.equal(callerOf(req('10.20.30.40', '1.2.3.4, 203.0.113.9, 172.70.0.1, 10.1.2.3')), '203.0.113.9');
  assert.equal(callerOf(req('203.0.113.50', '1.2.3.4')), '203.0.113.50');
  assert.equal(callerOf(req('127.0.0.1')), '127.0.0.1');
});
