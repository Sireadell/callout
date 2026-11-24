import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../server/engine.js';
import { makeRouter, PRESETS } from '../server/router.js';
import { makeBot } from '../server/bot.js';

// A fake Telegram that records what the bot sends.
function fakeTelegram() {
  let id = 100; const out = []; const pins = []; const answers = [];
  return {
    out, pins, answers,
    send: async (chat, text, extra = {}) => { const m = { chat, text, extra, message_id: ++id }; out.push(m); return m; },
    edit: async (chat, mid, text) => { out.push({ chat, edit: mid, text }); return {}; },
    pin: async (chat, mid) => { pins.push([chat, mid]); },
    answerCallback: async (qid, text) => { answers.push([qid, text]); },
  };
}
const msg = (text, extra = {}) => ({ message: { chat: { id: -500, type: 'supergroup', title: 'Wardens' }, from: { id: 7, first_name: 'Sam' }, text, message_id: 1, ...extra } });

function setup() {
  const clock = { t: 5_000_000, now() { return this.t; }, advance(ms) { this.t += ms; } };
  const tg = fakeTelegram();
  const engine = new Engine({ clock });
  const router = makeRouter({ engine, telegram: tg });
  engine.notify = router.notify;
  const bot = makeBot({ engine, telegram: tg, router });
  return { clock, tg, engine, bot };
}

test('team, run and add give a pairing code in the group', async () => {
  const { bot, tg, engine } = setup();
  await bot.handle(msg('/team Wardens'));
  await bot.handle(msg('/run Elm Street'));
  await bot.handle(msg('/add Ana | Area A1'));
  const code = tg.out.at(-1).text.match(/\n([A-Z0-9]{10})$/)[1];
  const joined = engine.pair(code);
  assert.equal(joined.name, 'Ana');
});

test('a clue shows reply buttons; pressing one puts the line on the lens', async () => {
  const { bot, tg, engine } = setup();
  await bot.handle(msg('/team Wardens'));
  await bot.handle(msg('/run Elm Street'));
  await bot.handle(msg('/add Ana | Area A1'));
  const { token } = engine.pair(tg.out.at(-1).text.match(/\n([A-Z0-9]{10})$/)[1]);
  engine.clue(token, { text: 'Person inside', pos: { lat: 1, lng: 2 } });
  await new Promise((r) => setImmediate(r));
  const clueMsg = tg.out.filter((m) => m.text?.includes('Person inside')).at(-1);
  const buttons = clueMsg.extra.reply_markup.inline_keyboard.flat();
  assert.equal(buttons.length, PRESETS.length);
  await bot.handle({ callback_query: { id: 'q1', data: buttons[0].callback_data, from: { first_name: 'Sam' }, message: { chat: { id: -500 } } } });
  assert.equal(engine.sync(token).replies[0].text, PRESETS[0]);
  assert.match(tg.answers.at(-1)[1], /Sent to Ana/);
});

test('replying to a clue message sends that text to the volunteer', async () => {
  const { bot, tg, engine } = setup();
  await bot.handle(msg('/team Wardens'));
  await bot.handle(msg('/run Elm Street'));
  await bot.handle(msg('/add Ana | Area A1'));
  const { token } = engine.pair(tg.out.at(-1).text.match(/\n([A-Z0-9]{10})$/)[1]);
  engine.clue(token, { text: 'Road blocked' });
  await new Promise((r) => setImmediate(r));
  const clueMsg = tg.out.filter((m) => m.text?.includes('Road blocked')).at(-1);
  await bot.handle(msg('Take the back lane', { message_id: 9, reply_to_message: { message_id: clueMsg.message_id } }));
  assert.equal(engine.sync(token).replies[0].text, 'Take the back lane');
});

test('button presses from other chats are refused', async () => {
  const { bot, tg, engine } = setup();
  await bot.handle(msg('/team Wardens'));
  await bot.handle(msg('/run Elm Street'));
  await bot.handle(msg('/add Ana | Area A1'));
  const { token, runId } = engine.pair(tg.out.at(-1).text.match(/\n([A-Z0-9]{10})$/)[1]);
  const volId = Object.keys(engine.runs[runId].volunteers)[0];
  await bot.handle({ callback_query: { id: 'q2', data: `r|${volId}|0`, from: {}, message: { chat: { id: -999 } } } });
  assert.equal(tg.answers.at(-1)[1], 'Not available');
  assert.equal(engine.sync(token).replies.length, 0);
});

test('the status board is pinned once, then edited in place', async () => {
  const { bot, tg, engine, clock } = setup();
  await bot.handle(msg('/team Wardens'));
  await bot.handle(msg('/run Elm Street'));
  await bot.handle(msg('/add Ana | Area A1'));
  const { token, runId } = engine.pair(tg.out.at(-1).text.match(/\n([A-Z0-9]{10})$/)[1]);
  await new Promise((r) => setImmediate(r));
  clock.advance(60_000);
  engine.checkIn(token);
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.equal(tg.pins.length, 1);
  assert.ok(tg.out.some((m) => m.edit && /Ana/.test(m.text)));
  assert.ok(engine.runs[runId].board.messageId);
});

test('the board and notices never claim to be an emergency service', async () => {
  const { bot, tg } = setup();
  await bot.handle(msg('/team Wardens'));
  await bot.handle(msg('/run Elm Street'));
  await bot.handle(msg('/status'));
  assert.match(tg.out.at(-1).text, /Not an emergency service/);
});
