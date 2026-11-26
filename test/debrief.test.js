import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, start, msg, settle } from './helpers.js';
import { debriefFacts } from '../server/ai.js';
import { Telegram } from '../server/telegram.js';

async function endedRun(s) {
  const { token, run } = await start(s);
  await s.bot.handle(msg('/add Ben | Area B2'));
  s.engine.checkIn(token, { pos: { lat: 51.50123, lng: -0.12456 } });
  s.engine.clue(token, { text: 'Road blocked' });
  const d = s.engine.endRun(run.id);
  await settle();
  return d;
}

test('the debrief goes out as a table of counts, with the areas that had no check-in', async () => {
  const s = setup();
  const rich = [];
  s.tg.sendRich = async (chat, blocks, extra) => { rich.push({ chat, blocks, extra }); return { message_id: 900 }; };
  const d = await endedRun(s);
  assert.deepEqual(d.areasWithoutCheckin, ['Area B2']);
  const { blocks, extra } = rich[0];
  assert.deepEqual(blocks.map((b) => b.type), ['heading', 'table', 'paragraph', 'paragraph']);
  assert.deepEqual(blocks[1].cells.map((r) => r.map((c) => c.text)), [['Name', 'Area', 'Check-ins', 'Missed'], ['Ana', 'Area A1', '1', '0'], ['Ben', 'Area B2', '0', '0']]);
  assert.match(blocks[3].text, /^Areas with no check-in: 1 [(]Area B2[)][.]$/);
  assert.equal(extra.protect_content, false);
  assert.doesNotMatch(JSON.stringify(blocks), /51[.]5/);
  assert.ok(!s.tg.out.some((m) => /finished after/.test(m.text || '')));
});

test('if Telegram refuses the table, the plain text debrief is sent', async () => {
  const s = setup();
  s.tg.sendRich = async () => { throw new Error('bad request'); };
  await endedRun(s);
  assert.ok(s.tg.out.some((m) => /finished after[^]*Areas with no check-in: 1 [(]Area B2[)]/.test(m.text || '')));
});

test('the AI is given the count of areas without a check-in, not their names', async () => {
  const facts = debriefFacts(await endedRun(setup()));
  assert.match(facts, /Areas with no check-in: 1[.]/);
  assert.doesNotMatch(facts, /Area B2|Ben/);
});

test('the table message uses the Bot API shape', async () => {
  let url; let body;
  const t = new Telegram('T', { minGapMs: 0, sleep: async () => {}, fetchImpl: async (u, init) => { url = u; body = JSON.parse(init.body); return { json: async () => ({ ok: true, result: {} }) }; } });
  await t.sendRich(-5, [{ type: 'paragraph', text: 'x' }], { disable_notification: true });
  assert.match(url, /sendRichMessage$/);
  assert.deepEqual(body, { chat_id: -5, rich_message: { blocks: [{ type: 'paragraph', text: 'x' }] }, disable_notification: true });
});
