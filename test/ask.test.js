import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, msg, start } from './helpers.js';

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
