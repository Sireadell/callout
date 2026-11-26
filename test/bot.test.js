import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../server/engine.js';
import { makeRouter, PRESETS } from '../server/router.js';
import { makeBot } from '../server/bot.js';

// A fake Telegram that records what the bot sends.
const fakeLive = []; const fakeStopped = []; const fakePhotos = []; const fakeForum = { on: false, topics: [], closed: [] };
function fakeTelegram() {
  let id = 100; const out = []; const pins = []; const answers = [];
  return {
    out, pins, answers,
    send: async (chat, text, extra = {}) => { const m = { chat, text, extra, message_id: ++id }; out.push(m); return m; },
    edit: async (chat, mid, text) => { out.push({ chat, edit: mid, text }); return {}; },
    pin: async (chat, mid) => { pins.push([chat, mid]); },
    answerCallback: async (qid, text) => { answers.push([qid, text]); },
    live: [], photos: [], topics: [], closed: [], stopped: [], forum: false,
    sendVenue: async (chat, lat, lng, title, address, extra = {}) => { const m = { chat, text: title + ' @ ' + address, venue: [lat, lng], extra, message_id: ++id }; out.push(m); return m; },
    sendLiveLocation: async (chat, lat, lng, extra = {}) => { const m = { chat, lat, lng, extra, message_id: ++id }; fakeLive.push(m); return m; },
    editLiveLocation: async (chat, mid, lat, lng, heading) => { fakeLive.push({ chat, edit: mid, lat, lng, heading }); },
    stopLiveLocation: async (chat, mid) => { fakeStopped.push(mid); },
    sendPhoto: async (chat, bytes, caption, extra = {}) => { const m = { chat, bytes, caption, extra, message_id: ++id }; fakePhotos.push(m); return m; },
    createForumTopic: async (chat, name) => { if (!fakeForum.on) throw new Error('not a forum'); fakeForum.topics.push(name); return { message_thread_id: 55 }; },
    closeForumTopic: async (chat, th) => { fakeForum.closed.push(th); },
  };
}
const msg = (text, extra = {}) => ({ message: { chat: { id: -500, type: 'supergroup', title: 'Wardens' }, from: { id: 7, first_name: 'Sam' }, text, message_id: 1, ...extra } });

// The pairing code sits on its own line in the reply to /add.
const codeIn = (m) => m.text.match(/\n([A-Z0-9]{10})\n/)[1];
const lastCode = (tg) => codeIn(tg.out.filter((m) => /\n[A-Z0-9]{10}\n/.test(m.text || '')).at(-1));

function setup() {
  const clock = { t: 5_000_000, now() { return this.t; }, advance(ms) { this.t += ms; } };
  const tg = fakeTelegram();
  const engine = new Engine({ clock });
  const router = makeRouter({ engine, telegram: tg });
  engine.notify = router.notify;
  const bot = makeBot({ engine, telegram: tg, router });
  return { clock, tg, engine, bot, router };
}

test('team, run and add give a pairing code in the group', async () => {
  const { bot, tg, engine } = setup();
  await bot.handle(msg('/team Wardens'));
  await bot.handle(msg('/run Elm Street'));
  await bot.handle(msg('/add Ana | Area A1'));
  const code = lastCode(tg);
  const joined = engine.pair(code);
  assert.equal(joined.name, 'Ana');
});

test('a clue shows reply buttons; pressing one puts the line on the lens', async () => {
  const { bot, tg, engine } = setup();
  await bot.handle(msg('/team Wardens'));
  await bot.handle(msg('/run Elm Street'));
  await bot.handle(msg('/add Ana | Area A1'));
  const { token } = engine.pair(lastCode(tg));
  engine.clue(token, { text: 'Person inside', pos: { lat: 1, lng: 2 } });
  await new Promise((r) => setImmediate(r));
  const clueMsg = tg.out.filter((m) => m.text?.includes('Person inside')).at(-1);
  const buttons = clueMsg.extra.reply_markup.inline_keyboard.flat();
  assert.equal(buttons.length, PRESETS.length + 1); // plus Ask a question
  await bot.handle({ callback_query: { id: 'q1', data: buttons[0].callback_data, from: { id: 7, first_name: 'Sam' }, message: { chat: { id: -500 } } } });
  assert.equal(engine.sync(token).replies[0].text, PRESETS[0]);
  assert.match(tg.answers.at(-1)[1], /Sent to Ana/);
});

test('replying to a clue message sends that text to the volunteer', async () => {
  const { bot, tg, engine } = setup();
  await bot.handle(msg('/team Wardens'));
  await bot.handle(msg('/run Elm Street'));
  await bot.handle(msg('/add Ana | Area A1'));
  const { token } = engine.pair(lastCode(tg));
  engine.clue(token, { text: 'Road blocked' });
  await new Promise((r) => setImmediate(r));
  const clueMsg = tg.out.filter((m) => m.text?.includes('Road blocked')).at(-1);
  await bot.handle(msg('Take the back lane', { message_id: 9, reply_to_message: { message_id: clueMsg.message_id } }));
  assert.equal(engine.sync(token).replies[0].text, 'Take the back lane');
});

test('button presses from other chats are refused', async () => {
  const { bot, tg, engine } = setup();
  await bot.handle(msg('/team Wardens'));
  await bot.handle(msg('/run Elm Street'));
  await bot.handle(msg('/add Ana | Area A1'));
  const { token, runId } = engine.pair(lastCode(tg));
  const volId = Object.keys(engine.runs[runId].volunteers)[0];
  await bot.handle({ callback_query: { id: 'q2', data: `r|${volId}|0`, from: {}, message: { chat: { id: -999 } } } });
  assert.equal(tg.answers.at(-1)[1], 'Not available');
  assert.equal(engine.sync(token).replies.length, 0);
});

test('the status board is pinned once, then edited in place', async () => {
  const { bot, tg, engine, clock } = setup();
  await bot.handle(msg('/team Wardens'));
  await bot.handle(msg('/run Elm Street'));
  await bot.handle(msg('/add Ana | Area A1'));
  const { token, runId } = engine.pair(lastCode(tg));
  await new Promise((r) => setImmediate(r));
  clock.advance(60_000);
  engine.checkIn(token);
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.equal(tg.pins.length, 1);
  assert.ok(tg.out.some((m) => m.edit && /Ana/.test(m.text)));
  assert.ok(engine.runs[runId].board.messageId);
});

test('the board and notices never claim to be an emergency service', async () => {
  const { bot, tg } = setup();
  await bot.handle(msg('/team Wardens'));
  await bot.handle(msg('/run Elm Street'));
  await bot.handle(msg('/status'));
  assert.match(tg.out.at(-1).text, /Not an emergency service/);
});

const priv = (text, extra = {}) => ({ message: { chat: { id: 77, type: 'private' }, from: { id: 77, first_name: 'Ana' }, text, message_id: 2, ...extra } });

test('the private start link ties the volunteer to their chat, and the code still works on the glasses', async () => {
  const { bot, tg, engine } = setup();
  await bot.handle(msg('/team Wardens'));
  await bot.handle(msg('/run Elm Street'));
  await bot.handle(msg('/add Ana | Area A1'));
  const code = lastCode(tg);
  await bot.handle(priv(`/start ${code}`));
  assert.ok(tg.out.some((m) => m.chat === 77 && /Linked: Ana/.test(m.text || '')));
  assert.equal(engine.pair(code).name, 'Ana');
});

test('a used or made-up start link is refused', async () => {
  const { bot, tg } = setup();
  await bot.handle(priv('/start NOTACODE123'));
  assert.match(tg.out.at(-1).text, /not valid/);
});

test('plain start in private gives the add-to-group link with admin rights', async () => {
  const { bot, tg } = setup();
  await bot.handle(priv('/start'));
  assert.match(tg.out.at(-1).text, /startgroup=setup&admin=pin_messages\+manage_topics/);
});

test('adding the bot as a plain member asks for admin; missing rights are named', async () => {
  const { bot, tg } = setup();
  const upd = (nm) => ({ my_chat_member: { chat: { id: -500, type: 'supergroup' }, new_chat_member: nm } });
  await bot.handle(upd({ status: 'member' }));
  assert.match(tg.out.at(-1).text, /not an admin/);
  await bot.handle(upd({ status: 'administrator', can_pin_messages: true, can_manage_topics: false }));
  assert.match(tg.out.at(-1).text, /make one topic per run/);
  await bot.handle(upd({ status: 'administrator', can_pin_messages: true, can_manage_topics: true }));
  assert.match(tg.out.at(-1).text, /All set/);
});

test('missed check-in buzzes, a clue is quiet, and positions are protected', async () => {
  const { bot, tg, engine, clock } = setup();
  await bot.handle(msg('/team Wardens'));
  await bot.handle(msg('/run Elm Street'));
  await bot.handle(msg('/add Ana | Area A1'));
  const { token } = engine.pair(lastCode(tg));
  engine.checkIn(token);
  engine.clue(token, { text: 'Road blocked', pos: { lat: 1, lng: 2 } });
  await new Promise((r) => setImmediate(r));
  const clue = tg.out.filter((m) => m.text?.includes('Road blocked')).at(-1);
  assert.equal(clue.extra.disable_notification, true);
  assert.equal(clue.extra.protect_content, true);
  clock.advance(18 * 60_000);
  engine.tick();
  await new Promise((r) => setImmediate(r));
  const missed = tg.out.filter((m) => /Missed check-in/.test(m.text || '')).at(-1);
  assert.equal(missed.extra.disable_notification, false);
});

const tick = () => new Promise((r) => setImmediate(r));
async function paired() {
  const s = setup();
  await s.bot.handle(msg('/team Wardens'));
  await s.bot.handle(msg('/run Elm Street'));
  await s.bot.handle(msg('/add Ana | Area A1'));
  const { token, runId } = s.engine.pair(lastCode(s.tg));
  await tick();
  return { ...s, token, runId };
}

test('a clue with a position is a map pin with the reply buttons on it', async () => {
  const { tg, engine, token } = await paired();
  engine.clue(token, { text: 'Road blocked', pos: { lat: 51.5, lng: -0.1 } });
  await tick(); await tick();
  const pin = tg.out.find((m) => m.venue);
  assert.deepEqual(pin.venue, [51.5, -0.1]);
  assert.equal(pin.text, 'Road blocked @ Ana (Area A1)');
  assert.equal(pin.extra.reply_markup.inline_keyboard.length, PRESETS.length + 1);
});

test('live location starts once, moves only after 25 m and a minute, with a heading', async () => {
  const { engine, token, router, clock } = await paired();
  fakeLive.length = 0;
  engine.heartbeat(token, { pos: { lat: 51.5, lng: -0.1 } });
  await router.updateLocations(Object.keys(engine.runs)[0]);
  assert.equal(fakeLive.length, 1);
  assert.equal(fakeLive[0].extra.protect_content, true);
  const run = Object.keys(engine.runs)[0];
  // moved 5 m only: no edit
  clock.advance(61_000);
  engine.heartbeat(token, { pos: { lat: 51.50004, lng: -0.1 } });
  await router.updateLocations(run);
  assert.equal(fakeLive.length, 1);
  // moved about 110 m north but only 10 s after the last edit window? wait a minute first
  engine.heartbeat(token, { pos: { lat: 51.501, lng: -0.1 } });
  await router.updateLocations(run);
  assert.equal(fakeLive.length, 2);
  assert.equal(fakeLive[1].heading, 360); // due north is 360, never 0
  // moved far but too soon: no edit
  clock.advance(10_000);
  engine.heartbeat(token, { pos: { lat: 51.51, lng: -0.1 } });
  await router.updateLocations(run);
  assert.equal(fakeLive.length, 2);
});

test('live locations stop at the debrief and the position is wiped', async () => {
  const { engine, token, router, bot, runId } = await paired();
  fakeStopped.length = 0;
  engine.heartbeat(token, { pos: { lat: 51.5, lng: -0.1 } });
  await router.updateLocations(runId);
  await bot.handle(msg('/end'));
  await tick(); await tick(); await tick();
  assert.equal(fakeStopped.length, 1);
  assert.equal(engine.runs[runId].volunteers[Object.keys(engine.runs[runId].volunteers)[0]].pos, null);
});

test('a photo is posted as a reply to its clue and is not kept by the server', async () => {
  const { engine, token, tg } = await paired();
  fakePhotos.length = 0;
  const clue = engine.clue(token, { text: 'Person inside', pos: { lat: 1, lng: 2 } });
  await tick(); await tick();
  const pinMsg = tg.out.find((m) => m.venue);
  engine.attachPhoto(token, { clueId: clue.id, bytes: Buffer.from([1, 2, 3]) });
  await tick(); await tick();
  assert.equal(fakePhotos.length, 1);
  assert.equal(fakePhotos[0].extra.reply_to_message_id, pinMsg.message_id);
  assert.equal(JSON.stringify(engine.snapshot()).includes('"photo"'), false);
  assert.throws(() => engine.attachPhoto(token, { clueId: 'nope', bytes: Buffer.from([1]) }), /unknown clue/);
  assert.throws(() => engine.attachPhoto(token, { clueId: clue.id, bytes: Buffer.alloc(700 * 1024) }), /too large/);
});

test('in a forum group each run gets a topic that is closed at the debrief; elsewhere nothing changes', async () => {
  fakeForum.on = true; fakeForum.topics.length = 0; fakeForum.closed.length = 0;
  const { tg, bot } = await paired();
  assert.deepEqual(fakeForum.topics, ['Elm Street']);
  assert.ok(tg.out.some((m) => m.extra?.message_thread_id === 55), 'notices go into the run topic');
  await bot.handle(msg('/end'));
  await tick(); await tick(); await tick();
  assert.deepEqual(fakeForum.closed, [55]);
  fakeForum.on = false;
  const plain = await paired();
  assert.equal(plain.tg.out.some((m) => m.extra?.message_thread_id), false);
});

// ---- AI summary line, sheet in and out ----
const fakeAi = { enabled: true, oneLine: async (t) => `SHORT:${t.slice(0, 10)}`, debrief: async () => 'One clue, nobody missed a check-in.' };
const fakeSheet = (calls = []) => ({
  email: 'robot@x.iam', calls,
  readVolunteers: async () => [{ name: 'Ana', area: 'A1' }, { name: 'Ben', area: 'B2' }],
  writeDebrief: async (id, d, s) => { calls.push([id, d.run, s]); return { people: d.volunteers.length, clues: d.clues.length }; },
});
function setupExtra() {
  const s = setup();
  s.sheetCalls = [];
  s.bot = makeBot({ engine: s.engine, telegram: s.tg, router: s.router, ai: fakeAi, sheet: fakeSheet(s.sheetCalls) });
  return s;
}
const SHEET_ID = 'abcDEF1234567890abcDEF1234567890';

test('a long coordinator line reaches the lens as one short line, full text kept', async () => {
  const { bot, tg, engine } = setupExtra();
  await bot.handle(msg('/team Wardens')); await bot.handle(msg('/run Elm Street')); await bot.handle(msg('/add Ana | Area A1'));
  const { token } = engine.pair(lastCode(tg));
  const long = 'Please walk north along the river path until you reach the old stone bridge';
  await bot.handle(msg(`/reply Ana ${long}`));
  const r = engine.sync(token).replies[0];
  assert.equal(r.text, 'SHORT:Please wal');
  assert.equal(r.full, long);
});

test('short lines are left as typed', async () => {
  const { bot, tg, engine } = setupExtra();
  await bot.handle(msg('/team Wardens')); await bot.handle(msg('/run Elm Street')); await bot.handle(msg('/add Ana | Area A1'));
  const { token } = engine.pair(lastCode(tg));
  await bot.handle(msg('/reply Ana Return to base'));
  assert.equal(engine.sync(token).replies[0].text, 'Return to base');
});

test('/sheet then /import adds everyone from the sheet with codes', async () => {
  const { bot, tg, engine } = setupExtra();
  await bot.handle(msg('/team Wardens')); await bot.handle(msg('/run Elm Street'));
  await bot.handle(msg('/sheet nonsense'));
  assert.ok(tg.out.some((m) => /robot@x.iam/.test(m.text || "")));
  await bot.handle(msg('/import'));
  assert.ok(tg.out.some((m) => /Connect a sheet first/.test(m.text || '')));
  await bot.handle(msg(`/sheet https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit`));
  await bot.handle(msg('/import'));
  const t = tg.out.at(-1).text;
  assert.match(t, /Added 2/); assert.match(t, /Ana \(A1\): [A-Z0-9]{10}/); assert.match(t, /Ben \(B2\)/);
  const run = engine.activeRun(Object.keys(engine.teams)[0]);
  assert.equal(Object.keys(run.volunteers).length, 2);
});

test('/import twice does not list the same people twice', async () => {
  const { bot, tg, engine } = setupExtra();
  await bot.handle(msg('/team Wardens')); await bot.handle(msg('/run Elm Street'));
  await bot.handle(msg('/add Ana | A1'));
  await bot.handle(msg(`/sheet https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit`));
  await bot.handle(msg('/import'));
  assert.match(tg.out.at(-1).text, /Added 1, 1 already in the run/);
  await bot.handle(msg('/import'));
  assert.match(tg.out.at(-1).text, /already in this run/);
  const run = engine.activeRun(Object.keys(engine.teams)[0]);
  assert.equal(Object.keys(run.volunteers).length, 2);
});

test('/end posts the summary, writes the sheet and closes the topic last', async () => {
  const { bot, tg, engine, sheetCalls } = setupExtra();
  fakeForum.on = true; fakeForum.closed.length = 0;
  await bot.handle(msg('/team Wardens')); await bot.handle(msg('/run Elm Street')); await bot.handle(msg('/add Ana | Area A1'));
  const { token } = engine.pair(lastCode(tg));
  engine.clue(token, { text: 'House empty' });
  await bot.handle(msg(`/sheet ${SHEET_ID}`));
  tg.out.length = 0;
  await bot.handle(msg('/end'));
  await new Promise((r) => setImmediate(r));
  const texts = tg.out.map((m) => m.text || '');
  assert.ok(texts.some((x) => /finished after/.test(x)));
  assert.ok(texts.some((x) => x === 'Summary: One clue, nobody missed a check-in.'));
  assert.ok(texts.some((x) => /Debrief written to your sheet \(1 people, 1 clues\)/.test(x)));
  assert.deepEqual(sheetCalls[0], [SHEET_ID, 'Elm Street', 'One clue, nobody missed a check-in.']);
  assert.equal(fakeForum.closed.length, 1);
  fakeForum.on = false;
});

// ---- reactions both ways ----
test('a reply gets an OK reaction instead of a chat line; falls back to text if reactions fail', async () => {
  const { bot, tg, engine } = setup();
  const reacts = [];
  tg.setReaction = async (chat, mid, emoji) => { reacts.push([chat, mid, emoji]); };
  await bot.handle(msg('/team Wardens')); await bot.handle(msg('/run Elm Street')); await bot.handle(msg('/add Ana | Area A1'));
  const { token } = engine.pair(lastCode(tg));
  engine.clue(token, { text: 'Road blocked' });
  await new Promise((r) => setImmediate(r));
  const clueMsg = tg.out.filter((m) => m.text?.includes('Road blocked')).at(-1);
  tg.out.length = 0;
  await bot.handle(msg('Take the back lane', { message_id: 9, reply_to_message: { message_id: clueMsg.message_id } }));
  assert.deepEqual(reacts, [[-500, 9, '\u{1F44C}']]);
  assert.ok(!tg.out.some((m) => /Sent to/.test(m.text || '')));
  tg.setReaction = async () => { throw new Error('reactions off'); };
  await bot.handle(msg('Then wait', { message_id: 10, reply_to_message: { message_id: clueMsg.message_id } }));
  assert.ok(tg.out.some((m) => /Sent to Ana/.test(m.text || '')));
});

test('a thumbs up on a clue puts Seen on the lens; other emoji and removals do nothing', async () => {
  const { bot, tg, engine } = setup();
  await bot.handle(msg('/team Wardens')); await bot.handle(msg('/run Elm Street')); await bot.handle(msg('/add Ana | Area A1'));
  const { token } = engine.pair(lastCode(tg));
  engine.clue(token, { text: 'House empty' });
  await new Promise((r) => setImmediate(r));
  const clueMsg = tg.out.filter((m) => m.text?.includes('House empty')).at(-1);
  const react = (nw, old = []) => bot.handle({ message_reaction: { chat: { id: -500 }, message_id: clueMsg.message_id, user: { id: 7, first_name: 'Sam' }, old_reaction: old, new_reaction: nw } });
  await react([{ type: 'emoji', emoji: '\u{1F525}' }]);
  assert.equal(engine.sync(token).replies.length, 0);
  await react([{ type: 'emoji', emoji: '\u{1F44D}' }]);
  assert.equal(engine.sync(token).replies[0].text, 'Seen');
  await react([], [{ type: 'emoji', emoji: '\u{1F44D}' }]);
  assert.equal(engine.sync(token).replies.length, 0);
  await bot.handle({ message_reaction: { chat: { id: -500 }, message_id: 99999, new_reaction: [{ type: 'emoji', emoji: '\u{1F44D}' }] } });
  assert.equal(engine.sync(token).replies.length, 0);
});

// ---- found in the first live Telegram test ----
test('notices that arrive together make one board, edited in place', async () => {
  const { bot, tg, engine } = setup();
  await bot.handle(msg('/team Wardens')); await bot.handle(msg('/run Elm Street')); await bot.handle(msg('/add Ana | Area A1'));
  const { token } = engine.pair(lastCode(tg));
  engine.checkIn(token); engine.heartbeat(token, { battery: 80, worn: true });
  engine.clue(token, { text: 'House empty' });
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  const boards = tg.out.filter((m) => !m.edit && /^Run: Elm Street/.test(m.text || ''));
  assert.equal(boards.length, 1);
  assert.equal(tg.pins.length, 1);
});

test('a group turned into a supergroup keeps its team', async () => {
  const { bot, tg, engine } = setup();
  await bot.handle(msg('/team Wardens'));
  await bot.handle({ message: { chat: { id: -500, type: 'group' }, migrate_to_chat_id: -1005, message_id: 2 } });
  assert.equal(engine.teamByChat(-1005)?.name, 'Wardens');
  assert.equal(engine.teamByChat(-500), undefined);
});

test('the first private chat keeps the link: a second person cannot take it over', async () => {
  const { bot, tg, engine } = setup();
  await bot.handle(msg('/team Wardens'));
  await bot.handle(msg('/run Elm Street'));
  await bot.handle(msg('/add Ana | Area A1'));
  const code = lastCode(tg);
  await bot.handle(priv(`/start ${code}`));
  assert.ok(tg.out.some((m) => m.chat === -500 && /Ana's private chat is linked, opened by Ana/.test(m.text)));
  await bot.handle(priv(`/start ${code}`, { chat: { id: 88, type: 'private' }, from: { id: 88, first_name: 'Pat' } }));
  assert.match(tg.out.at(-1).text, /already has a private chat linked/);
  const run = Object.values(engine.runs)[0];
  assert.equal(Object.values(run.volunteers)[0].tgChatId, 77);
});

test('with a private coordinator chat, pairing codes never appear in the group', async () => {
  const { bot, tg } = setup();
  await bot.handle(msg('/team Wardens'));
  await bot.handle(msg('/coordinator'));
  await bot.handle(msg('/run Elm Street'));
  await bot.handle(msg('/add Ana | Area A1'));
  const withCode = tg.out.filter((m) => /\n[A-Z0-9]{10}\n/.test(m.text || ''));
  assert.deepEqual(withCode.map((m) => m.chat), [7]);
  assert.ok(tg.out.some((m) => m.chat === -500 && /Added Ana \(Area A1\)\. The code is private\./.test(m.text)));
  assert.ok(!tg.out.some((m) => m.chat === -500 && /[?]start=[A-Z0-9]{10}/.test(m.text || '')));
});

test('without a private coordinator chat the code goes to the group with a warning', async () => {
  const { bot, tg } = setup();
  await bot.handle(msg('/team Wardens'));
  await bot.handle(msg('/run Elm Street'));
  await bot.handle(msg('/add Ana | Area A1'));
  assert.ok(tg.out.some((m) => m.chat === -500 && /Anyone in this group can see this/.test(m.text || '')));
});

test('the run notice says what goes to the AI, only when AI is on', async () => {
  const off = setup();
  await off.bot.handle(msg('/team Wardens'));
  await off.bot.handle(msg('/run Elm Street'));
  assert.ok(!off.tg.out.some((m) => /AI is on/.test(m.text || '')));
  const on = setup();
  const bot = makeBot({ engine: on.engine, telegram: on.tg, router: on.router, ai: { enabled: true } });
  await bot.handle(msg('/team Wardens', { chat: { id: -501, type: 'supergroup' } }));
  await bot.handle(msg('/run Elm Street', { chat: { id: -501, type: 'supergroup' } }));
  assert.ok(on.tg.out.some((m) => m.chat === -501 && /AI is on: clue words/.test(m.text || '')));
});
