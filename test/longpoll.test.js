import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../server/engine.js';
import { makeLongPoll } from '../server/longpoll.js';

function setup() {
  const clock = { t: 1_000_000, now() { return this.t; }, advance(ms) { this.t += ms; } };
  const engine = new Engine({ clock });
  const team = engine.addTeam({ name: 'Wardens' });
  const run = engine.startRun({ teamId: team.id, name: 'Elm Street' });
  const { code, volunteer } = engine.addVolunteer(run.id, { name: 'Ana', area: 'A1' });
  const { token } = engine.pair(code);
  const sync = makeLongPoll({ engine });
  const rev = engine.sync(token).rev;
  const reply = (text) => engine.reply(run.id, { volunteerId: volunteer.id, text });
  return { clock, engine, run, token, id: volunteer.id, sync, rev, reply };
}
const state = (p) => Promise.race([p.then(() => 'answered'), new Promise((r) => setTimeout(r, 30, 'held'))]);

test('a held request answers as soon as the coordinator replies', async () => {
  const { sync, token, rev, reply, clock, engine } = setup();
  const held = sync({ token, wait: 25, rev });
  assert.equal(await state(held), 'held');
  reply('Come back');
  clock.advance(40);
  const out = await held;
  assert.equal(out.replies[0].text, 'Come back');
  assert.ok(out.rev > rev);
  assert.equal(engine.timingSummary().replyToLens.samples, 1);
});

test('a first call, an old number or a waiting reply answers at once', async () => {
  const { sync, token, rev, reply } = setup();
  assert.equal((await sync({ token, wait: 25 })).rev, rev);
  assert.equal((await sync({ token, wait: 25, rev: rev - 1 })).rev, rev);
  reply('Hello');
  assert.equal((await sync({ token, wait: 25, rev: rev + 1 })).replies.length, 1);
  assert.equal(sync({ token }).replies.length, 0, 'no wait answers directly, as before');
});

test('it answers with the normal reply when the time is up', async () => {
  const { sync, token, rev } = setup();
  assert.equal((await sync({ token, wait: 0.05, rev })).runName, 'Elm Street');
});

test('a caller who hangs up takes no reply, and one who missed a reply gets it again', async () => {
  const { sync, token, rev, reply, engine } = setup();
  const gone = new AbortController();
  const held = sync({ token, wait: 25, rev }, gone.signal);
  gone.abort();
  assert.equal(await held, null);
  reply('Come back');
  assert.equal(engine.sync(token).replies.length, 1); // sent, but say it never arrived
  const again = await sync({ token, wait: 25, rev });
  assert.equal(again.replies[0].text, 'Come back');
  const settled = sync({ token, wait: 0.05, rev: again.rev });
  assert.equal((await settled).replies.length, 0);
});

test('a newer held request ends the older one without taking replies', async () => {
  const { sync, token, rev, reply } = setup();
  const first = sync({ token, wait: 25, rev });
  const second = sync({ token, wait: 25, rev });
  assert.deepEqual((await first).replies, []);
  reply('Come back');
  assert.equal((await second).replies.length, 1);
});

test('ending the run releases a held request with "unknown token"', async () => {
  const { sync, token, rev, engine, run } = setup();
  const held = sync({ token, wait: 25, rev });
  engine.endRun(run.id);
  await assert.rejects(held, /unknown token/);
});

test('timings give p50 and p95 over the last 50', () => {
  const { engine } = setup();
  for (let i = 1; i <= 60; i++) engine.measure('x', i);
  assert.deepEqual(engine.timingSummary().x, { samples: 50, p50Ms: 35, p95Ms: 58 });
});
