import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { Engine } from '../server/engine.js';
import { PRESETS, makeRouter } from '../server/router.js';
import { Discord, verifyInteraction, makeInteractionHandler } from '../server/discord.js';

function keys() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const hex = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
  return { hex, sign: (s) => sign(null, Buffer.from(s), privateKey).toString('hex') };
}

test('only correctly signed interactions pass', () => {
  const k = keys(); const body = '{"type":1}';
  assert.ok(verifyInteraction(k.hex, k.sign('123' + body), '123', body));
  assert.ok(!verifyInteraction(k.hex, k.sign('123' + body), '124', body));
  assert.ok(!verifyInteraction(k.hex, k.sign('123' + body), '123', '{"type":2}'));
  assert.ok(!verifyInteraction(k.hex, 'zz', '123', body));
  assert.ok(!verifyInteraction('nothex', k.sign('x'), '1', 'x'));
});

function world() {
  const engine = new Engine({ clock: { now: () => 1_000_000 } });
  const team = engine.addTeam({ name: 'T', discord: { webhookUrl: 'https://hook', channelId: 'C1' } });
  const run = engine.startRun({ teamId: team.id, name: 'Elm' });
  const { volunteer, code } = engine.addVolunteer(run.id, { name: 'Ana', area: 'A1' });
  return { engine, team, run, volunteer, token: engine.pair(code).token };
}

test('a button press sends the preset to the lens and answers privately', () => {
  const w = world(); const h = makeInteractionHandler({ engine: w.engine, presets: PRESETS });
  assert.deepEqual(h({ type: 1 }), { type: 1 });
  const out = h({ type: 3, channel_id: 'C1', data: { custom_id: `r|${w.volunteer.id}|1` }, member: { user: { username: 'sam' } } });
  assert.equal(out.data.flags, 64);
  assert.equal(w.engine.sync(w.token).replies[0].text, PRESETS[1]);
});

test('a button from another channel or an ended run is refused', () => {
  const w = world(); const h = makeInteractionHandler({ engine: w.engine, presets: PRESETS });
  assert.equal(h({ type: 3, channel_id: 'OTHER', data: { custom_id: `r|${w.volunteer.id}|0` } }).data.content, 'Not available');
  assert.equal(h({ type: 3, channel_id: 'C1', data: { custom_id: 'r|nobody|0' } }).data.content, 'Not available');
  w.engine.endRun(w.run.id);
  assert.equal(h({ type: 3, channel_id: 'C1', data: { custom_id: `r|${w.volunteer.id}|0` } }).data.content, 'Not available');
});

test('clue notices go with buttons through the bot; others use the webhook', async () => {
  const w = world(); const calls = [];
  const discord = new Discord({ botToken: 'B', fetchImpl: async (url, init) => { calls.push([url, JSON.parse(init.body), init.headers.authorization]); return { ok: true, json: async () => ({}) }; } });
  const router = makeRouter({ engine: w.engine, discord });
  await router.notify({ runId: w.run.id, teamId: w.team.id, audience: 'team', kind: 'clue', text: 'Ana: Road blocked', volunteerId: w.volunteer.id });
  await router.notify({ runId: w.run.id, teamId: w.team.id, audience: 'team', kind: 'joined', text: 'Ana joined' });
  assert.match(calls[0][0], /channels\/C1\/messages/);
  assert.equal(calls[0][2], 'Bot B');
  assert.equal(calls[0][1].components[0].components.length, PRESETS.length);
  assert.equal(calls[0][1].components[0].components[0].custom_id, `r|${w.volunteer.id}|0`);
  assert.match(calls[1][0], /^https:\/\/hook/);
  assert.equal(calls[1][1].components, undefined);
  assert.deepEqual(calls[1][1].allowed_mentions, { parse: [] });
});
