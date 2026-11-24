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
