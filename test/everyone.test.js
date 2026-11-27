// /reply all, /ask all with its count on the board, and coordinator voice messages to the lens.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, msg, start, settle } from './helpers.js';

// A team with Ana and Ben joined, and Cy added but not joined yet.
async function team(options) {
  const w = setup(options);
  const ana = await start(w);
  await w.bot.handle(msg('/add Ben | Area A2'));
  const code = w.tg.out.map((m) => m.text?.match(/\n([A-Z0-9]{10})\n/)?.[1]).filter(Boolean).at(-1);
  const ben = { token: w.engine.pair(code).token };
  await w.bot.handle(msg('/add Cy | Area A3'));
  await settle();
  return { ...w, ana, ben };
}
const board = (tg) => tg.out.filter((m) => /^Run: /.test(m.text || '')).at(-1).text;

test('/reply all reaches every joined lens once, and nobody who has not joined', async () => {
  const w = await team();
  await w.bot.handle(msg('/reply all Come back to the hall'));
  assert.deepEqual(w.engine.sync(w.ana.token).replies.map((r) => r.text), ['Come back to the hall']);
  assert.deepEqual(w.engine.sync(w.ben.token).replies.map((r) => r.text), ['Come back to the hall']);
  const cy = Object.values(w.ana.run.volunteers).find((v) => v.name === 'Cy');
  assert.equal(w.ana.run.replies.filter((r) => r.volunteerId === cy.id).length, 0);
  assert.equal(w.tg.reactions.at(-1)[2], '👌');
});

test('/ask all asks everyone, and the board counts the answers and names who is still to answer', async () => {
  const w = await team();
  await w.bot.handle(msg('/ask all Are you OK?'));
  const qa = w.engine.sync(w.ana.token).question;
  const qb = w.engine.sync(w.ben.token).question;
  assert.deepEqual([qa.text, qa.answers], ['Are you OK?', ['Yes', 'No', 'Not sure']]);
  assert.match(board(w.tg), /Asked everyone "Are you OK\?": no answer yet 2 \(Ana, Ben\)/);
  w.engine.answer(w.ana.token, { questionId: qa.id, answer: 'Yes' });
  await settle();
  assert.match(board(w.tg), /Asked everyone "Are you OK\?": Yes 1, no answer yet 1 \(Ben\)/);
  w.engine.answer(w.ben.token, { questionId: qb.id, answer: 'No' });
  await settle();
  assert.match(board(w.tg), /Asked everyone "Are you OK\?": Yes 1, No 1\n/);
  // Each answer still comes back under the question, with buttons to act on it.
  assert.equal(w.tg.out.filter((m) => /answered "Are you OK\?"/.test(m.text || '')).length, 2);
});

test('the count leaves the board after 15 minutes, and a member cannot ask everyone', async () => {
  const w = await team();
  await w.bot.handle(msg('/ask all Are you OK?', { from: { id: 99, first_name: 'Pat' } }));
  assert.equal(w.engine.sync(w.ana.token).question, null);
  await w.bot.handle(msg('/ask all Are you OK?'));
  w.clock.advance(15 * 60_000 + 1);
  await w.router.updateBoard(w.ana.run.id);
  assert.doesNotMatch(board(w.tg), /Asked everyone/);
});

test('someone called All is still reached by name', async () => {
  const w = setup();
  const all = await start(w, { name: 'All', area: 'Area Z' });
  await w.bot.handle(msg('/reply All see you soon'));
  assert.deepEqual(w.engine.sync(all.token).replies.map((r) => r.text), ['see you soon']);
});

test('with nobody joined, /reply all says so and sends nothing', async () => {
  const w = setup();
  await w.bot.handle(msg('/team Wardens'));
  await w.bot.handle(msg('/run Elm Street'));
  await w.bot.handle(msg('/reply all hello'));
  await settle();
  assert.ok(w.tg.out.some((m) => /Nobody has joined this run yet/.test(m.text || '')));
  assert.equal(w.engine.runs[Object.keys(w.engine.runs)[0]].replies.length, 0);
});

// A fake speech to text that hears fixed words.
const hears = (words, got = []) => ({ transcribeFile: async (b) => { got.push(b); return words; } });

test('a voice reply to a clue shows its words on that lens, and the coordinator sees what was heard', async () => {
  const got = [];
  const w = setup({ bot: { stt: hears('Check the blue door first', got) } });
  const { token } = await start(w);
  w.engine.clue(token, { text: 'No answer' });
  await settle();
  const clue = w.tg.out.find((m) => /No answer/.test(m.text || ''));
  w.tg.download = async (id) => Buffer.from(`ogg:${id}`);
  await w.bot.handle(msg(undefined, { voice: { file_id: 'v1', duration: 3 }, reply_to_message: { message_id: clue.message_id } }));
  assert.equal(String(got[0]), 'ogg:v1');
  assert.deepEqual(w.engine.sync(token).replies.map((r) => r.text), ['Check the blue door first']);
  assert.match(w.tg.out.at(-1).text, /^Heard: "Check the blue door first"\. Sent to Ana's lens\.$/);
});

test('words that already end in a full stop get no second one', async () => {
  const w = setup({ bot: { stt: hears('Check the blue door first.') } });
  await start(w);
  w.tg.download = async () => Buffer.from('ogg');
  await w.bot.handle(msg(undefined, { voice: { file_id: 'v', duration: 2 }, caption: '/reply Ana' }));
  assert.equal(w.tg.out.at(-1).text, 'Heard: "Check the blue door first." Sent to Ana\'s lens.');
});

test('a voice message captioned /ask all asks everyone in those words', async () => {
  const w = await team({ bot: { stt: hears('Is everyone OK?') } });
  w.tg.download = async () => Buffer.from('ogg');
  await w.bot.handle(msg(undefined, { voice: { file_id: 'v2', duration: 2 }, caption: '/ask all' }));
  assert.equal(w.engine.sync(w.ben.token).question.text, 'Is everyone OK?');
  assert.match(w.tg.out.filter((m) => /^Heard/.test(m.text || '')).at(-1).text, /Asked everyone\./);
});

test('voice replies are refused without speech to text, when too long, or from a plain member', async () => {
  const w = setup();
  const { token } = await start(w);
  w.engine.clue(token, { text: 'No answer' });
  await settle();
  const clue = w.tg.out.find((m) => /No answer/.test(m.text || ''));
  const voice = (extra) => msg(undefined, { voice: { file_id: 'v', duration: 3 }, reply_to_message: { message_id: clue.message_id }, ...extra });
  await w.bot.handle(voice());
  assert.match(w.tg.out.at(-1).text, /not set up on this server/);

  const v2 = setup({ bot: { stt: hears('hello') } });
  const s2 = await start(v2);
  v2.engine.clue(s2.token, { text: 'No answer' });
  await settle();
  const c2 = v2.tg.out.find((m) => /No answer/.test(m.text || ''));
  v2.tg.download = async () => Buffer.from('ogg');
  await v2.bot.handle(msg(undefined, { voice: { file_id: 'v', duration: 61 }, reply_to_message: { message_id: c2.message_id } }));
  assert.match(v2.tg.out.at(-1).text, /under a minute/);
  await v2.bot.handle(msg(undefined, { voice: { file_id: 'v', duration: 3 }, reply_to_message: { message_id: c2.message_id }, from: { id: 99, first_name: 'Pat' } }));
  assert.equal(v2.engine.sync(s2.token).replies.length, 0);
});

test('a voice message with no words, or one that fails, sends nothing to the lens', async () => {
  const w = setup({ bot: { stt: hears('  ') } });
  const { token } = await start(w);
  w.tg.download = async () => Buffer.from('ogg');
  await w.bot.handle(msg(undefined, { voice: { file_id: 'v', duration: 2 }, caption: '/reply Ana' }));
  assert.match(w.tg.out.at(-1).text, /could not hear any words/);
  w.tg.download = async () => { throw new Error('gone'); };
  await w.bot.handle(msg(undefined, { voice: { file_id: 'v', duration: 2 }, caption: '/reply Ana' }));
  assert.match(w.tg.out.at(-1).text, /did not reach the lens/);
  assert.equal(w.engine.sync(token).replies.length, 0);
});
