import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, msg, start, settle } from './helpers.js';
import { Telegram } from '../server/telegram.js';

// A Telegram that can show a message to one member only.
function ephemeral(tg, { hidden = true } = {}) {
  const only = [];
  tg.sendOnlyTo = async (chat, user, text) => { only.push({ chat, user, text }); return hidden ? { message_id: 0, ephemeral_message_id: 4 } : { message_id: 9 }; };
  return only;
}
const PAT = { from: { id: 99, first_name: 'Pat' } };

test('a refused command is answered to that person only', async () => {
  const s = setup(); let only;
  await start(s);
  only = ephemeral(s.tg);
  const before = s.tg.out.length;
  await s.bot.handle(msg('/end', PAT));
  assert.deepEqual(only.at(-1), { chat: -500, user: 99, text: 'Only the coordinator can do that.' });
  assert.equal(s.tg.out.length, before);
});

test('without a private chat the code is shown only to the person who asked', async () => {
  const s = setup(); let only = ephemeral(s.tg);
  await s.bot.handle(msg('/team Wardens')); await s.bot.handle(msg('/run Elm Street'));
  await s.bot.handle(msg('/add Ana | Area A1'));
  assert.equal(only.at(-1).user, 7);
  const code = only.at(-1).text.match(/\n([A-Z0-9]{10})\n/)[1];
  assert.ok(!s.tg.out.some((m) => m.text?.includes(code)));
  // Lost it: the same command gives a new code, the old one stops working, and Ana is listed once.
  await s.bot.handle(msg('/add Ana | Area A2'));
  const next = only.at(-1).text.match(/\n([A-Z0-9]{10})\n/)[1];
  assert.throws(() => s.engine.pair(code), /not valid/);
  assert.equal(s.engine.pair(next).area, 'Area A2');
  assert.equal(Object.keys(Object.values(s.engine.runs)[0].volunteers).length, 1);
});

test('if Telegram does not confirm the message was hidden, the group is warned', async () => {
  const s = setup(); ephemeral(s.tg, { hidden: false });
  await s.bot.handle(msg('/team Wardens')); await s.bot.handle(msg('/run Elm Street'));
  await s.bot.handle(msg('/add Ana | Area A1'));
  assert.ok(s.tg.out.some((m) => /Anyone in this group can see the code above/.test(m.text || '')));
});

test('safety notices are never sent as one-person messages', async () => {
  const s = setup(); let only;
  const { token } = await start(s);
  only = ephemeral(s.tg);
  const used = only.length;
  s.engine.needBackup(token); s.clock.advance(30 * 60_000); s.engine.tick(); await settle();
  assert.equal(only.length, used);
  const button = s.tg.out.flatMap((m) => m.extra?.reply_markup?.inline_keyboard?.flat() || []).find((b) => /mark OK/.test(b.text));
  assert.equal(button.style, 'success');
});

test('the one-person message uses the Bot API shape', async () => {
  let body;
  const t = new Telegram('T', { minGapMs: 0, sleep: async () => {}, fetchImpl: async (url, init) => { body = JSON.parse(init.body); return { json: async () => ({ ok: true, result: {} }) }; } });
  await t.sendOnlyTo(-5, 7, 'hi');
  assert.deepEqual(body, { chat_id: -5, text: 'hi', ephemeral_message_parameters: { receiver_user_id: 7 } });
});
