import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, msg, start, settle } from './helpers.js';
import { makeAi } from '../server/ai.js';

test('quick clues start with everyday words and follow /clues for this run', async () => {
  const { bot, engine, tg } = setup();
  const { token } = await start({ bot, engine, tg });
  assert.deepEqual(engine.sync(token).quickClues, ['All done', 'No answer', 'Spoke to them', 'Access blocked']);
  await bot.handle(msg('/clues House empty, No answer, Spoke to them,  Access blocked '));
  assert.deepEqual(engine.sync(token).quickClues, ['House empty', 'No answer', 'Spoke to them', 'Access blocked']);
  await bot.handle(msg('/clues default'));
  assert.equal(engine.sync(token).quickClues[0], 'All done');
});

test('too many or too long quick clues are refused and nothing changes', async () => {
  const { bot, engine, tg } = setup();
  const { token } = await start({ bot, engine, tg });
  for (const bad of ['/clues a, b, c, d, e', '/clues This one is far too long']) {
    await bot.handle(msg(bad));
    assert.match(tg.out.at(-1).text, /up to 4 clues of up to 16 characters/);
  }
  await bot.handle(msg('/clues Hi', { from: { id: 99, first_name: 'Pat' } }));
  assert.match(tg.out.at(-1).text, /Only the coordinator/);
  assert.equal(engine.sync(token).quickClues.length, 4);
});

test('a question shows on every sync until answered, and the answer threads under it', async () => {
  const { bot, engine, tg, clock } = setup();
  const { token } = await start({ bot, engine, tg });
  const asking = msg('/ask Ana how many people?');
  await bot.handle(asking);
  const q = engine.sync(token).question;
  assert.deepEqual([q.text, q.answers, q.by], ['how many people?', ['None', '1', '2 or more'], 'Sam']);
  assert.equal(engine.sync(token).question.id, q.id);
  engine.answer(token, { questionId: q.id, answer: '2 or more' });
  engine.answer(token, { questionId: q.id, answer: 'None' });
  await settle();
  const answers = tg.out.filter((m) => /answered "how many people/.test(m.text || ''));
  assert.equal(answers.length, 1);
  assert.equal(answers[0].chat, -500);
  assert.equal(answers[0].extra.reply_to_message_id, asking.message.message_id);
  assert.equal(answers[0].extra.disable_notification, undefined);
  assert.equal(engine.sync(token).question, null);
});

test('the Ask button opens a reply box, and the reply becomes the question', async () => {
  const { bot, engine, tg } = setup();
  const { token } = await start({ bot, engine, tg });
  engine.clue(token, { text: 'Person inside' });
  await settle();
  const clue = tg.out.find((m) => /Person inside/.test(m.text || ''));
  const ask = clue.extra.reply_markup.inline_keyboard.flat().find((b) => b.text === 'Ask a question');
  await bot.handle({ callback_query: { id: 'q', data: ask.callback_data, from: { id: 7, first_name: 'Sam' }, message: { chat: { id: -500 } } } });
  const prompt = tg.out.at(-1);
  assert.equal(prompt.extra.reply_markup.force_reply, true);
  await bot.handle(msg('Is the door open?', { reply_to_message: { message_id: prompt.message_id } }));
  assert.deepEqual(engine.sync(token).question.answers, ['Yes', 'No', 'Not sure']);
  assert.equal(engine.sync(token).replies.length, 0);
});

test('a plain member cannot ask, and old or replaced questions are refused', async () => {
  const { bot, engine, tg, clock } = setup();
  const { token, run, id } = await start({ bot, engine, tg });
  await bot.handle(msg('/ask Ana are you there?', { from: { id: 99, first_name: 'Pat' } }));
  assert.equal(engine.sync(token).question, null);
  const first = engine.ask(run.id, { volunteerId: id, text: 'One?', answers: ['Yes'] });
  const second = engine.ask(run.id, { volunteerId: id, text: 'Two?', answers: ['Yes'] });
  assert.throws(() => engine.answer(token, { questionId: first.id, answer: 'Yes' }), /unknown question/);
  assert.throws(() => engine.answer(token, { questionId: second.id, answer: '  ' }), /empty answer/);
  clock.advance(15 * 60_000 + 1);
  assert.equal(engine.sync(token).question, null);
  assert.throws(() => engine.answer(token, { questionId: second.id, answer: 'Yes' }), /unknown question/);
});

test('AI answers are cut, guarded and replaced when unusable', async () => {
  const reply = (text) => makeAi({ openrouterKey: 'k', fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: text } }] }) }) });
  assert.deepEqual(await reply('1. Blue door\n- Call an ambulance\nSOS\nThis answer is much too long to fit\nSide gate\nNone seen\nExtra').answers('Which door?'), ['Blue door', 'Side gate', 'None seen']);
  assert.deepEqual(await reply('help is coming').answers('Which door?'), ['Not sure', 'Give me 5 min', 'Call me']);
  assert.deepEqual(await makeAi({}).answers('Can you hear me?'), ['Yes', 'No', 'Not sure']);
});

test('one coordinator with two teams can answer both from the private chat', async () => {
  const { bot, engine, tg } = setup();
  const ana = await start({ bot, engine, tg }, { chat: -500, team: 'Wardens', name: 'Ana' });
  await bot.handle(msg('/coordinator', { chat: { id: -500, type: 'supergroup' } }));
  const ben = await start({ bot, engine, tg }, { chat: -600, team: 'Drivers', name: 'Ben' });
  await bot.handle(msg('/coordinator', { chat: { id: -600, type: 'supergroup' } }));
  const priv = { id: 7, type: 'private' };
  for (const v of [ana, ben]) engine.needBackup(v.token);
  engine.reply(ana.run.id, { volunteerId: ana.id, text: 'x' }); engine.sync(ana.token);
  engine.sync(ben.token);
  // A notice for the second team that goes to the coordinator's private chat.
  engine.announce(ben.run.id, 'coordinator', 'went_silent', 'Ben quiet', { volunteerId: ben.id });
  await settle();
  const notice = tg.out.find((m) => m.chat === 7 && m.text === 'Ben quiet');
  await bot.handle(msg('Come back', { chat: priv, reply_to_message: { message_id: notice.message_id } }));
  assert.equal(engine.sync(ben.token).replies[0].text, 'Come back');
  await bot.handle({ message_reaction: { chat: priv, message_id: notice.message_id, user: { id: 7, first_name: 'Sam' }, old_reaction: [], new_reaction: [{ type: 'emoji', emoji: '👍' }] } });
  assert.equal(engine.sync(ben.token).replies[0].text, 'Seen');
  await bot.handle(msg('/ask Ben are you there?', { chat: priv }));
  assert.equal(engine.sync(ben.token).question.text, 'are you there?');
  assert.equal(engine.sync(ana.token).question, null);
});
