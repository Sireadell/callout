import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Telegram } from '../server/telegram.js';

// Found in the first live test: an unset reply_markup was sent as the text "undefined" and Telegram refused the photo.
test('sendPhoto leaves out empty options and sends real ones as JSON', async () => {
  let form;
  const t = new Telegram('T', { minGapMs: 0, sleep: async () => {}, fetchImpl: async (url, init) => { form = init.body; return { json: async () => ({ ok: true, result: { message_id: 5 } }) }; } });
  await t.sendPhoto(-1, Buffer.from('x'), 'cap', { reply_markup: undefined, message_thread_id: 8, disable_notification: true, extra_null: null, reply_to_message_id: 3 });
  assert.equal(form.has('reply_markup'), false);
  assert.equal(form.has('extra_null'), false);
  assert.equal(form.get('message_thread_id'), '8');
  assert.equal(form.get('disable_notification'), 'true');
  assert.equal(form.get('caption'), 'cap');
  await t.sendPhoto(-1, Buffer.from('x'), '', { reply_markup: { inline_keyboard: [] } });
  assert.equal(form.get('reply_markup'), '{"inline_keyboard":[]}');
});

test('group sends wait at least 3.1 seconds apart; private chats use the short gap', async () => {
  const waits = [];
  const t = new Telegram('T', { minGapMs: 1100, sleep: async (ms) => { waits.push(ms); }, fetchImpl: async () => ({ json: async () => ({ ok: true, result: { message_id: 1 } }) }) });
  await t.send(-5, 'a'); await t.send(77, 'b');
  assert.deepEqual(waits, [3100, 1100]);
});

test('a 429 answer waits retry_after plus one second and tries once more', async () => {
  const waits = []; let n = 0;
  const t = new Telegram('T', { minGapMs: 0, sleep: async (ms) => { waits.push(ms); }, fetchImpl: async () => { n += 1; return n === 1 ? { status: 429, json: async () => ({ ok: false, parameters: { retry_after: 4 } }) } : { json: async () => ({ ok: true, result: { message_id: 9 } }) }; } });
  const r = await t.call('sendMessage', { chat_id: 1, text: 'x' });
  assert.equal(r.message_id, 9);
  assert.deepEqual(waits, [5000]);
});
