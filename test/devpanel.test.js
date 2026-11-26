import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeFakeFetch } from '../devpanel/fake-telegram.js';
import { Telegram } from '../server/telegram.js';

test('the dev panel answers Telegram calls on this computer and reports them', async () => {
  const seen = []; const real = [];
  const fetchImpl = makeFakeFetch({ realFetch: async (u) => { real.push(String(u)); return { ok: true }; }, report: (m) => seen.push(m) });
  const tg = new Telegram('0:devpanel', { fetchImpl, sleep: async () => {} });
  assert.equal((await tg.getMe()).username, 'devpanel_bot');
  const m = await tg.send(-1, 'Hello');
  assert.ok(m.message_id > 0);
  await tg.sendPhoto(-1, Buffer.from('abc'), 'a photo');
  assert.deepEqual(seen.map((s) => s.method), ['sendMessage', 'sendPhoto']);
  assert.equal(seen[1].body.photo, '[file, 3 bytes]');
  await assert.rejects(tg.createForumTopic(-1, 'x'), /not a forum/);
  assert.equal(real.length, 0);
});

test('the dev panel lets local calls through and blocks every other outside address', async () => {
  const real = [];
  const fetchImpl = makeFakeFetch({ realFetch: async (u) => { real.push(String(u)); return { ok: true }; } });
  await fetchImpl('http://127.0.0.1:8788/healthz');
  assert.equal(real.length, 1);
  await assert.rejects(fetchImpl('https://discord.com/api/v10/channels/1/messages'), /blocks outside address/);
  await assert.rejects(fetchImpl('https://api.openrouter.ai/x'), /blocks outside address/);
  assert.equal(real.length, 1);
});
