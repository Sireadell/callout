import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Telegram } from '../server/telegram.js';
import { makeRoutes } from '../server/api.js';
import { setup, start, msg, settle } from './helpers.js';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
const PHOTO = [{ file_id: 'small', width: 90, height: 68 }, { file_id: 'big', width: 800, height: 600 }, { file_id: 'mid', width: 320, height: 240 }];

async function withClue() {
  const world = setup();
  const asked = [];
  world.tg.download = async (id) => { asked.push(id); return JPEG; };
  const s = await start(world);
  world.engine.clue(s.token, { text: 'Which door?' });
  await settle();
  const clue = world.tg.out.find((m) => /Which door/.test(m.text) && m.extra?.reply_markup);
  return { ...world, ...s, asked, clue };
}
const photoReply = (clue, extra = {}) => msg(undefined, { photo: PHOTO, reply_to_message: { message_id: clue.message_id }, ...extra });

test('a photo sent as a reply to a clue reaches that lens, in the smallest copy that fills it', async () => {
  const w = await withClue();
  await w.bot.handle(photoReply(w.clue, { caption: 'This one' }));
  assert.deepEqual(w.asked, ['mid']);
  const reply = w.engine.sync(w.token).replies[0];
  assert.equal(reply.text, 'This one');
  assert.equal(reply.picture, true);
  assert.equal(w.engine.picture(w.token, reply.id).image, JPEG.toString('base64'));
});

test('/reply in a photo caption sends the photo, with the name alone', async () => {
  const w = await withClue();
  await w.bot.handle(msg(undefined, { photo: PHOTO, caption: '/reply Ana' }));
  assert.equal(w.engine.sync(w.token).replies[0].text, 'Sent a photo');
});

test('someone who is not the coordinator cannot put a photo on a lens', async () => {
  const w = await withClue();
  await w.bot.handle(photoReply(w.clue, { from: { id: 99, first_name: 'Bo' } }));
  assert.deepEqual(w.asked, []);
  assert.equal(w.engine.sync(w.token).replies.length, 0);
});

test('a photo that cannot be fetched is said so in the chat', async () => {
  const w = await withClue();
  w.tg.download = async () => { throw new Error('nope'); };
  await w.bot.handle(photoReply(w.clue));
  assert.ok(w.tg.out.some((m) => /did not reach Ana/.test(m.text || '')));
  assert.equal(w.engine.sync(w.token).replies.length, 0);
});

test('photos are never saved, expire, and go when the run ends', async () => {
  const w = await withClue();
  await w.bot.handle(photoReply(w.clue));
  const reply = w.engine.sync(w.token).replies[0];
  assert.doesNotMatch(JSON.stringify(w.engine.snapshot()), new RegExp(JPEG.toString('base64')));
  w.clock.advance(15 * 60_000 + 1);
  assert.throws(() => w.engine.picture(w.token, reply.id), /picture gone/);
  w.engine.tick();
  assert.equal(w.engine.pictures.size, 0);
  await w.bot.handle(photoReply(w.clue));
  w.engine.endRun(w.run.id);
  assert.equal(w.engine.pictures.size, 0);
});

test('only the volunteer it was sent to can fetch a photo', async () => {
  const w = await withClue();
  await w.bot.handle(photoReply(w.clue));
  const reply = w.engine.sync(w.token).replies[0];
  const { code } = w.engine.addVolunteer(w.run.id, { name: 'Ben', area: 'A2' });
  const ben = w.engine.pair(code);
  const routes = makeRoutes({ engine: w.engine, stt: null, env: {} });
  assert.throws(() => routes['POST /api/picture']({ token: ben.token, replyId: reply.id }), /picture gone/);
});

test('a download error never shows the bot token', async () => {
  const tg = new Telegram('12:secret', { fetchImpl: async (url) => {
    if (url.includes('/getFile')) return { json: async () => ({ ok: true, result: { file_path: 'photos/a.jpg', file_size: 10 } }) };
    throw new Error(`cannot reach ${url}`);
  } });
  await assert.rejects(() => tg.download('x'), (e) => !e.message.includes('secret'));
});
