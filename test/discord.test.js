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

const SAM = '100000000000000001';
const PAT = '200000000000000002';

function world() {
  const engine = new Engine({ clock: { now: () => 1_000_000 } });
  const team = engine.addTeam({ name: 'T', discord: { webhookUrl: 'https://hook', channelId: 'C1' } });
  const run = engine.startRun({ teamId: team.id, name: 'Elm' });
  const { volunteer, code } = engine.addVolunteer(run.id, { name: 'Ana', area: 'A1' });
  return { engine, team, run, volunteer, token: engine.pair(code).token };
}

test('a button press sends the preset to the lens and answers privately', () => {
  const w = world(); const h = makeInteractionHandler({ engine: w.engine, presets: PRESETS, coordinatorIds: SAM });
  assert.deepEqual(h({ type: 1 }), { type: 1 });
  const out = h({ type: 3, channel_id: 'C1', data: { custom_id: `r|${w.volunteer.id}|1` }, member: { user: { id: SAM, username: 'sam' } } });
  assert.equal(out.data.flags, 64);
  assert.equal(w.engine.sync(w.token).replies[0].text, PRESETS[1]);
});

test('a button from another channel or an ended run is refused', () => {
  const w = world(); const h = makeInteractionHandler({ engine: w.engine, presets: PRESETS, coordinatorIds: SAM });
  const member = { user: { id: SAM } };
  assert.equal(h({ type: 3, channel_id: 'OTHER', member, data: { custom_id: `r|${w.volunteer.id}|0` } }).data.content, 'Not available');
  assert.equal(h({ type: 3, channel_id: 'C1', member, data: { custom_id: 'r|nobody|0' } }).data.content, 'Not available');
  w.engine.endRun(w.run.id);
  assert.equal(h({ type: 3, channel_id: 'C1', member, data: { custom_id: `r|${w.volunteer.id}|0` } }).data.content, 'Not available');
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

test('only a listed coordinator can send a reply; anyone else is refused privately', () => {
  const w = world();
  const h = makeInteractionHandler({ engine: w.engine, presets: PRESETS, coordinatorIds: ` 300000000000000003, ${SAM} ` });
  const press = (id) => h({ type: 3, channel_id: 'C1', data: { custom_id: `r|${w.volunteer.id}|0` }, member: { user: { id, username: 'x' } } });
  const refused = press(PAT);
  assert.equal(refused.data.flags, 64);
  assert.match(refused.data.content, new RegExp(`^Only the coordinator can do that\. Your Discord user ID is ${PAT}\.$`));
  assert.equal(w.engine.sync(w.token).replies.length, 0);
  assert.equal(press(undefined).data.content, 'Only the coordinator can do that.');
  assert.equal(press(SAM).data.content, 'Sent to Ana');
  assert.equal(w.engine.sync(w.token).replies[0].text, PRESETS[0]);
});

test('with no coordinator list nobody can send, and the list is read from the setting', () => {
  const w = world();
  const press = (h) => h({ type: 3, channel_id: 'C1', data: { custom_id: `r|${w.volunteer.id}|0` }, member: { user: { id: SAM } } }).data.content;
  for (const none of ['', '  ', 'sam', undefined]) assert.match(press(makeInteractionHandler({ engine: w.engine, presets: PRESETS, coordinatorIds: none ?? '' })), /Only the coordinator/);
  assert.equal(w.engine.sync(w.token).replies.length, 0);
  const before = process.env.DISCORD_COORDINATOR_IDS;
  process.env.DISCORD_COORDINATOR_IDS = SAM;
  try { assert.equal(press(makeInteractionHandler({ engine: w.engine, presets: PRESETS })), 'Sent to Ana'); }
  finally { if (before === undefined) delete process.env.DISCORD_COORDINATOR_IDS; else process.env.DISCORD_COORDINATOR_IDS = before; }
});
