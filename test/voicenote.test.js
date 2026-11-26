import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pcmToMp3 } from '../server/voicenote.js';
import { makeRoutes } from '../server/api.js';
import { Telegram } from '../server/telegram.js';
import { setup, start, msg, settle } from './helpers.js';

// One second of a 440 Hz tone, as the glasses would send it.
const tone = (seconds = 1) => {
  const pcm = Buffer.alloc(Math.round(16000 * seconds) * 2);
  for (let i = 0; i < pcm.length / 2; i++) pcm.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / 16000) * 12000), i * 2);
  return pcm;
};

async function world() {
  const w = setup();
  const voices = [];
  w.tg.sendVoice = async (chat, bytes, extra) => { voices.push({ chat, bytes, extra }); return { message_id: 9000 + voices.length }; };
  w.tg.deleted = [];
  w.tg.deleteMessage = async (chat, id) => { w.tg.deleted.push(id); };
  const s = await start(w);
  const routes = makeRoutes({ engine: w.engine, stt: null, env: {} });
  const clue = async () => { routes['POST /api/clue']({ token: s.token, text: 'Gate locked', audio: tone().toString('base64') }); await settle(); await settle(); };
  return { ...w, ...s, voices, clue };
}

test('a recording is packed as MP3, much smaller than the raw audio', () => {
  const mp3 = pcmToMp3(tone(2));
  assert.equal(mp3[0], 0xff, 'starts with an MP3 frame');
  assert.ok(mp3.length > 1000 && mp3.length < tone(2).length / 4);
});

test('too short or too long a recording is dropped', () => {
  assert.equal(pcmToMp3(tone(0.1)), null);
  assert.equal(pcmToMp3(tone(13)), null);
  assert.equal(pcmToMp3(null), null);
});

test('voice notes are off until the coordinator turns them on', async () => {
  const w = await world();
  await w.clue();
  assert.equal(w.voices.length, 0);
  assert.equal(w.engine.sync(w.token).voiceNotes, undefined);
});

test('with /voice on the recording follows its clue in the team chat, and is not saved', async () => {
  const w = await world();
  await w.bot.handle(msg('/voice on'));
  await settle();
  assert.ok(w.tg.out.some((m) => /Voice notes are on/.test(m.text || '')), 'the team is told');
  assert.equal(w.engine.sync(w.token).voiceNotes, true);
  await w.clue();
  assert.equal(w.voices.length, 1);
  const clueMsg = w.tg.out.find((m) => /Gate locked/.test(m.text || '') && m.extra?.reply_markup);
  assert.equal(w.voices[0].extra.reply_to_message_id, clueMsg.message_id);
  assert.equal(w.voices[0].extra.protect_content, true);
  assert.ok(JSON.stringify(w.engine.snapshot()).length < 20_000, 'no audio in the saved state');
});

test('only the coordinator can turn voice notes on', async () => {
  const w = await world();
  await w.bot.handle(msg('/voice on', { from: { id: 99, first_name: 'Bo' } }));
  assert.equal(w.run.voiceNotes, undefined);
});

test('a reply to the voice note reaches the speaker, and /end clear removes it', async () => {
  const w = await world();
  await w.bot.handle(msg('/voice on'));
  await w.clue();
  await w.bot.handle(msg('Stay there', { reply_to_message: { message_id: 9001 } }));
  assert.equal(w.engine.sync(w.token).replies.at(-1).text, 'Stay there');
  await w.bot.handle(msg('/end clear'));
  for (let i = 0; i < 5; i++) await settle();
  assert.ok(w.tg.deleted.includes(9001));
});

test('a refused voice note never stops the clue', async () => {
  const w = await world();
  w.tg.sendVoice = async () => { throw new Error('no'); };
  await w.bot.handle(msg('/voice on'));
  await w.clue();
  assert.ok(w.tg.out.some((m) => /Gate locked/.test(m.text || '')));
});

test('the voice note goes to Telegram as a file upload', async () => {
  let seen;
  const tg = new Telegram('t', { minGapMs: 0, fetchImpl: async (url, init) => { seen = { url, form: init.body }; return { json: async () => ({ ok: true, result: { message_id: 1 } }) }; } });
  await tg.sendVoice(5, Buffer.from([0xff, 0xf3]), { reply_to_message_id: 3, message_thread_id: undefined });
  assert.match(seen.url, /sendVoice$/);
  assert.equal(seen.form.get('reply_to_message_id'), '3');
  assert.equal(seen.form.has('message_thread_id'), false);
  assert.equal(seen.form.get('voice').type, 'audio/mpeg');
});
