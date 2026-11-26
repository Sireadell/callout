import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, msg, settle, start } from './helpers.js';
import { makeBot } from '../server/bot.js';
import { makeJoins, JOIN_TTL_MS } from '../server/join.js';
import { makeRoutes } from '../server/api.js';

function withJoins() {
  const s = setup();
  s.joins = makeJoins({ engine: s.engine });
  s.bot = makeBot({ engine: s.engine, telegram: s.tg, router: s.router, joins: s.joins });
  return s;
}
const BEN = { from: { id: 42, first_name: 'Ben' } };
const press = (data, from = { id: 7, first_name: 'Sam' }) => ({ callback_query: { id: 'q', data, from, message: { chat: { id: -500 } } } });
const buttons = (tg) => tg.out.filter((m) => /wants to join/.test(m.text || '')).at(-1).extra.reply_markup.inline_keyboard.flat();

test('lens code, /join, coordinator picks: the lens gets its sign-in and the sender is the private chat', async () => {
  const s = withJoins();
  await start(s);
  const { code, secret } = s.joins.create();
  assert.match(code, /^\d{4}$/);
  assert.deepEqual(s.joins.status(secret), { state: 'waiting' });
  await s.bot.handle(msg(`/join ${code}`, BEN));
  assert.deepEqual(s.joins.status(secret), { state: 'claimed', name: 'Ben', team: 'Wardens' });
  await s.bot.handle(press(buttons(s.tg).find((b) => b.text === 'New: Ben in Area A1').callback_data));
  await settle();
  const done = s.joins.status(secret);
  assert.deepEqual([done.state, done.name, done.area, done.team], ['paired', 'Ben', 'Area A1', 'Wardens']);
  assert.equal(s.engine.sync(done.token).area, 'Area A1');
  assert.equal(s.engine.findVolunteer(Object.values(s.engine.runs[done.runId].volunteers).at(-1).id).v.tgChatId, 42);
  assert.ok(!JSON.stringify(s.engine.snapshot()).includes(done.token));
  s.clock.advance(61_000);
  assert.equal(s.joins.status(secret).state, 'expired');
});

test('a volunteer already on the list is claimed, not listed twice; a typed area works too', async () => {
  const s = withJoins();
  const { run } = await start(s);
  await s.bot.handle(msg('/add Ben | Area B2'));
  const a = s.joins.create();
  await s.bot.handle(msg(`/join ${a.code}`, BEN));
  await s.bot.handle(press(buttons(s.tg).find((b) => b.text === 'This is Ben, Area B2').callback_data));
  assert.equal(Object.values(run.volunteers).filter((v) => v.name === 'Ben').length, 1);
  assert.equal(s.joins.status(a.secret).area, 'Area B2');
  const b = s.joins.create();
  await s.bot.handle(msg(`/join ${b.code}`, { from: { id: 43, first_name: 'Cy' } }));
  const prompt = s.tg.out.filter((m) => /wants to join/.test(m.text || '')).at(-1);
  await s.bot.handle(msg('North side', { reply_to_message: { message_id: prompt.message_id } }));
  assert.equal(s.joins.status(b.secret).area, 'North side');
});

test('only the coordinator can choose, and codes expire', async () => {
  const s = withJoins();
  await start(s);
  const { code, secret } = s.joins.create();
  await s.bot.handle(msg(`/join ${code}`, BEN));
  const choice = buttons(s.tg)[0].callback_data;
  await s.bot.handle(press(choice, { id: 42, first_name: 'Ben' }));
  assert.match(s.tg.answers.at(-1)[1], /Only the coordinator/);
  assert.equal(s.joins.status(secret).state, 'claimed');
  s.clock.advance(JOIN_TTL_MS + 1);
  await s.bot.handle(press(choice));
  assert.equal(s.joins.status(secret).state, 'expired');
});

test('guessing codes stops after five wrong tries, even with the right code next', async () => {
  const s = withJoins();
  await start(s);
  const { code, secret } = s.joins.create();
  const wrong = code === '0000' ? '0001' : '0000';
  for (let i = 0; i < 5; i++) await s.bot.handle(msg(`/join ${wrong}`, BEN));
  await s.bot.handle(msg(`/join ${code}`, BEN));
  assert.match(s.tg.out.at(-1).text, /Too many wrong codes/);
  assert.equal(s.joins.status(secret).state, 'waiting');
});

test('asking for lens codes is limited per caller and answers 429', () => {
  const s = withJoins();
  const routes = makeRoutes({ engine: s.engine, joins: s.joins, botName: () => 'CalloutBot', env: {} });
  for (let i = 0; i < 20; i++) assert.equal(routes['POST /api/join']({}, { caller: 'a' }).bot, 'CalloutBot');
  assert.throws(() => routes['POST /api/join']({}, { caller: 'a' }), (e) => e.status === 429);
  assert.ok(routes['POST /api/join']({}, { caller: 'b' }).code);
});
