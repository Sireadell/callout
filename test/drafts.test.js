import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, start, settle } from './helpers.js';
import { makeAi } from '../server/ai.js';
import { PRESETS } from '../server/router.js';

const answering = (text) => makeAi({ openrouterKey: 'k', fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: text } }] }) }) });

function withAi(ai) {
  const s = setup({ router: { ai } });
  const edits = [];
  s.tg.editButtons = async (chat, mid, markup) => { edits.push({ chat, mid, rows: markup.inline_keyboard }); };
  return { ...s, edits };
}

test('two AI suggestions appear under the fixed buttons, and pressing one sends it to the lens', async () => {
  const s = withAi(answering('Which door is it?\nHelp is coming\nThanks, stay by the gate\nThird idea'));
  const { token } = await start(s);
  s.engine.clue(token, { text: 'Person inside' }); await settle();
  const { rows, mid, chat } = s.edits.at(-1);
  assert.deepEqual(rows.map((r) => r[0].text), [...PRESETS, 'AI: Which door is it?', 'AI: Thanks, stay by the gate', 'Ask a question']);
  const button = rows[PRESETS.length][0];
  assert.ok(Buffer.byteLength(button.callback_data) <= 64);
  await s.bot.handle({ callback_query: { id: 'q', data: button.callback_data, from: { id: 7, first_name: 'Sam' }, message: { chat: { id: chat }, message_id: mid } } });
  assert.equal(s.engine.sync(token).replies[0].text, 'Which door is it?');
});

test('with no usable suggestion the fixed buttons stay as they are', async () => {
  for (const ai of [answering('Call an ambulance'), makeAi({ openrouterKey: 'k', fetchImpl: async () => ({ ok: false, status: 500 }) }), makeAi({})]) {
    const s = withAi(ai);
    const { token } = await start(s);
    s.engine.clue(token, { text: 'Person inside' }); await settle();
    assert.equal(s.edits.length, 0);
    assert.ok(s.tg.out.some((m) => /Person inside/.test(m.text || '')));
  }
});

test('safety notices never get AI suggestions', async () => {
  const s = withAi(answering('Which door?\nThanks'));
  const { token } = await start(s);
  s.engine.needBackup(token); s.clock.advance(30 * 60_000); s.engine.tick(); await settle();
  assert.equal(s.edits.length, 0);
});
