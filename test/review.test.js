import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../server/engine.js';
import { makeRouter, boardText } from '../server/router.js';
import { makeBot } from '../server/bot.js';

// A fake Telegram that can refuse private chats, like a real bot does for people who never pressed Start.
function fake({ blocked = [], admins = [] } = {}) {
  let id = 100; const out = []; const answers = []; const reactions = []; const deleted = []; const edits = [];
  return {
    out, answers, reactions, blocked, deleted, edits,
    deleteMessage: async (c, mid) => { deleted.push([c, mid]); },
    send: async (chat, text, extra = {}) => { if (blocked.includes(chat)) throw new Error('Forbidden: bot cant initiate'); const m = { chat, text, extra, message_id: ++id }; out.push(m); return m; },
    sendVenue: async (chat, lat, lng, title, address, extra = {}) => { const m = { chat, text: `${title} @ ${address}`, venue: true, extra, message_id: ++id }; out.push(m); return m; },
    edit: async (c, mid, text) => { edits.push([c, mid, text]); return {}; }, pin: async () => {}, stopLiveLocation: async () => {},
    answerCallback: async (qid, text) => { answers.push(text); },
    setReaction: async (chat, mid, emoji) => { reactions.push([chat, mid, emoji]); },
    getChatMember: async (chat, user) => ({ status: admins.includes(user) ? 'administrator' : 'member' }),
    createForumTopic: async () => { throw new Error('not a forum'); }, closeForumTopic: async () => {},
  };
}
function setup(opts) {
  const clock = { t: 5_000_000, now() { return this.t; }, advance(ms) { this.t += ms; } };
  const tg = fake(opts);
  const engine = new Engine({ clock });
  const router = makeRouter({ engine, telegram: tg, log: () => {} });
  engine.notify = router.notify;
  const bot = makeBot({ engine, telegram: tg, router });
  return { clock, tg, engine, bot };
}
const from = (id, name) => ({ id, first_name: name });
const g = (text, user = from(7, 'Sam'), extra = {}) => ({ message: { chat: { id: -500, type: 'supergroup', title: 'W' }, from: user, text, message_id: 1, ...extra } });
const priv = (id, text) => ({ message: { chat: { id, type: 'private' }, from: from(id, 'P'), text, message_id: 2 } });
const settle = () => new Promise((r) => setImmediate(r));
const lastCode = (tg) => tg.out.filter((m) => /\n[A-Z0-9]{10}\n/.test(m.text || '')).at(-1).text.match(/\n([A-Z0-9]{10})\n/)[1];

async function started(opts) {
  const s = setup(opts);
  await s.bot.handle(g('/team W'));
  await s.bot.handle(g('/run Elm'));
  await s.bot.handle(g('/add Ana | A1'));
  const joined = s.engine.pair(lastCode(s.tg));
  const run = Object.values(s.engine.runs)[0];
  const vol = Object.values(run.volunteers)[0];
  return { ...s, run, vol, token: joined.token };
}

test('only the coordinator or a group admin can change a run', async () => {
  const { bot, engine, run } = await started({ admins: [8] });
  await bot.handle(g('/end', from(99, 'Pat')));
  assert.equal(run.status, 'active', 'a plain member cannot end the run');
  await bot.handle(g('/add Bo | A2', from(99, 'Pat')));
  assert.equal(Object.keys(run.volunteers).length, 1);
  await bot.handle(g('/status', from(99, 'Pat')));
  await bot.handle(g('/add Bo | A2', from(8, 'Admin')));
  assert.equal(Object.keys(run.volunteers).length, 2, 'a group admin can');
  await bot.handle(g('/end'));
  assert.equal(run.status, 'ended');
  assert.ok(engine);
});

test('reply buttons refuse a plain member', async () => {
  const { bot, tg, engine, vol, token } = await started();
  await bot.handle({ callback_query: { id: 'q', data: `r|${vol.id}|0`, from: from(99, 'Pat'), message: { chat: { id: -500 } } } });
  assert.equal(tg.answers.at(-1), 'Only the coordinator can do that');
  assert.equal(engine.sync(token).replies.length, 0);
});

test('/coordinator says so when the coordinator never pressed Start, and notices stay in the group', async () => {
  const { bot, tg, engine, clock, vol } = await started({ blocked: [7] });
  await bot.handle(g('/coordinator'));
  assert.match(tg.out.at(-1).text, /cannot reach you privately/);
  assert.equal(engine.teamByChat(-500).telegram.coordinatorChatId, null);
  clock.advance(engine.cfg.checkinMs + engine.cfg.coordinatorGraceMs + 1000);
  engine.tick(); await settle();
  assert.ok(tg.out.some((m) => m.chat === -500 && /Missed check-in notice/.test(m.text)));
  assert.ok(vol);
});

test('if the private chat fails later, the missed check-in still reaches the group', async () => {
  const { bot, tg, engine, clock } = await started();
  await bot.handle(g('/coordinator'));
  assert.equal(engine.teamByChat(-500).telegram.coordinatorChatId, 7);
  tg.blocked.push(7); // the coordinator blocked the bot after setting it up
  clock.advance(engine.cfg.checkinMs + engine.cfg.coordinatorGraceMs + 1000);
  engine.tick(); await settle(); await settle();
  assert.ok(tg.out.some((m) => m.chat === -500 && /Missed check-in notice/.test(m.text)), 'fell back to the group');
  assert.ok(tg.out.some((m) => m.chat === -500 && /cannot message the coordinator privately/.test(m.text)));
});

test('Reached them, mark OK clears the overdue steps and tells the team', async () => {
  const { bot, tg, engine, clock, vol, run } = await started();
  clock.advance(engine.cfg.checkinMs + engine.cfg.coordinatorGraceMs + 1000);
  engine.tick(); await settle();
  const notice = tg.out.find((m) => /Missed check-in notice/.test(m.text || ''));
  const data = notice.extra.reply_markup.inline_keyboard.flat().find((b) => /^ok\|/.test(b.callback_data)).callback_data;
  assert.equal(vol.step, 1);
  await bot.handle({ callback_query: { id: 'q', data, from: from(7, 'Sam'), message: { chat: { id: -500 } } } });
  assert.equal(vol.step, 0);
  assert.equal(tg.answers.at(-1), 'Ana marked OK');
  await settle();
  assert.ok(tg.out.some((m) => /marked OK by Sam/.test(m.text || '')));
  assert.equal(vol.marked, 1);
  assert.ok(run);
});

test('private nudges: quiet before, loud and with a button at the time, and the button checks in only that person', async () => {
  const { bot, tg, engine, clock, vol, run } = await started();
  await bot.handle(g('/add Cy | A2'));
  const code2 = lastCode(tg);
  await bot.handle(priv(77, `/start ${code2}`));
  const cy = Object.values(run.volunteers).find((v) => v.name === 'Cy');
  assert.equal(cy.tgChatId, 77);
  engine.pair(code2);
  clock.advance(engine.cfg.checkinMs - 60_000);
  engine.tick(); await settle();
  const soon = tg.out.find((m) => m.chat === 77 && /due in about/.test(m.text));
  assert.ok(soon, 'quiet nudge first');
  assert.equal(soon.extra.disable_notification, true);
  assert.ok(!tg.out.some((m) => m.chat === -500 && /due in about/.test(m.text)), 'never in the group');
  clock.advance(61_000);
  engine.tick(); await settle();
  const due = tg.out.find((m) => m.chat === 77 && /Check-in time/.test(m.text));
  assert.equal(due.extra.disable_notification, false);
  assert.doesNotMatch(due.text, /\d\.\d{4}/, 'no position in a nudge');
  const data = due.extra.reply_markup.inline_keyboard[0][0].callback_data;
  await bot.handle({ callback_query: { id: 'x', data, from: from(5, 'Other'), message: { chat: { id: 12345 } } } });
  assert.equal(cy.checkins, 0, 'another chat cannot press it');
  await bot.handle({ callback_query: { id: 'y', data, from: from(77, 'P'), message: { chat: { id: 77 } } } });
  assert.equal(cy.checkins, 1);
  assert.equal(cy.nudge, 0);
  assert.ok(vol);
});

test('sign out stops the notices and shows on the board', async () => {
  const { engine, clock, token, run, tg } = await started();
  engine.signOut(token);
  clock.advance(engine.cfg.checkinMs * 3);
  engine.tick(); await settle();
  assert.ok(!tg.out.some((m) => /Missed check-in/.test(m.text || '')));
  assert.match(boardText(engine, run.id), /signed out/);
});

test('need backup is a loud team notice with a map pin, worded as a request', async () => {
  const { engine, token, tg } = await started();
  engine.needBackup(token, { pos: { lat: 51.5, lng: -0.12 } });
  await settle();
  const m = tg.out.find((x) => x.venue);
  assert.ok(m);
  assert.equal(m.extra.disable_notification, false);
  const all = tg.out.map((x) => x.text).join('\n');
  assert.match(all, /asked the team for backup/);
  assert.doesNotMatch(all, /SOS|help is coming|urgent|rescue/i);
});

test('a confirmed reply puts a reaction on the coordinator\'s own message', async () => {
  const { bot, tg, engine, token } = await started();
  await bot.handle(g('/reply Ana Return to base', from(7, 'Sam'), { message_id: 321 }));
  const r = engine.sync(token).replies[0];
  engine.confirmReply(token, r.id);
  await settle();
  assert.ok(tg.reactions.some(([c, id, e]) => c === -500 && id === 321 && e === '👀'));
});

test('with no AI key a long coordinator line is cut to one short line, full text kept', async () => {
  const { bot, engine, token } = await started();
  const long = 'Please move to the north side of the park and check the boat shed near the river. Then report back.';
  await bot.handle(g(`/reply Ana ${long}`));
  const r = engine.sync(token).replies[0];
  assert.ok(r.text.length <= 60, `lens text ${r.text.length}`);
  assert.equal(r.full, long);
});

test('/interval changes the gap for this run only, and refuses silly values', async () => {
  const { bot, tg, engine, clock, run, token } = await started();
  await bot.handle(g('/interval 30'));
  assert.equal(engine.gap(run), 30 * 60_000);
  assert.ok(engine.sync(token).dueInMs > 14 * 60_000 + 59_000 && engine.sync(token).dueInMs <= 30 * 60_000);
  await bot.handle(g('/interval 2'));
  assert.match(tg.out.at(-1).text, /between 5 and 60/);
  assert.equal(engine.gap(run), 30 * 60_000);
  await bot.handle(g('/interval 10', from(99, 'Pat')));
  assert.equal(engine.gap(run), 30 * 60_000, 'a plain member cannot');
  clock.advance(20 * 60_000); engine.tick(); await settle();
  assert.ok(!tg.out.some((m) => /Missed check-in/.test(m.text || '')), '20 min is fine on a 30 min gap');
});

test('the debrief carries first and last check-in, Mark OK and sign-out, and no positions', async () => {
  const { engine, clock, token, run, vol } = await started();
  clock.advance(60_000); engine.checkIn(token, { pos: { lat: 51.5, lng: -0.1 } });
  clock.advance(60_000); engine.checkIn(token, {});
  engine.markOk(run.id, vol.id, 'Sam');
  engine.signOut(token);
  const d = engine.endRun(run.id);
  const v = d.volunteers[0];
  assert.equal(v.checkins, 2);
  assert.ok(v.firstAt && v.lastAt && v.lastAt > v.firstAt);
  assert.equal(v.markedOk, 1);
  assert.equal(v.signedOut, true);
  assert.match(engine.debriefText(d), /marked OK 1x, signed out/);
});

test('a check-in held back by bad signal keeps its own time, capped to 30 minutes and never the future', async () => {
  const { engine, clock, token, vol } = await started();
  const t0 = clock.t;
  clock.advance(10 * 60_000);
  engine.checkIn(token, { at: t0 + 4 * 60_000 });
  assert.equal(vol.lastCheckin, t0 + 4 * 60_000, 'uses the time it was made');
  clock.advance(5 * 60_000);
  engine.checkIn(token, { at: clock.t + 999_999 });
  assert.equal(vol.lastCheckin, clock.t, 'a time in the future is ignored');
  clock.advance(60 * 60_000);
  engine.checkIn(token, { at: clock.t - 50 * 60_000 });
  assert.equal(vol.lastCheckin, clock.t - 30 * 60_000, 'older than 30 minutes is capped');
  engine.checkIn(token, { at: 'nonsense' });
  assert.equal(vol.lastCheckin, clock.t);
});

test('a clue held back says it was sent late', async () => {
  const { engine, clock, token, tg } = await started();
  clock.advance(6 * 60_000);
  engine.clue(token, { text: 'Road blocked', pos: { lat: 1, lng: 2 }, at: clock.t - 5 * 60_000 });
  await settle();
  assert.ok(tg.out.some((m) => /sent 5 min late/.test(m.text || '')));
});

test('/end clear deletes the messages that show positions; a plain /end leaves them', async () => {
  for (const clear of [false, true]) {
    const { bot, tg, engine, token } = await started();
    engine.clue(token, { text: 'Person inside', pos: { lat: 1, lng: 2 } }); await settle();
    const pin = tg.out.find((m) => m.venue);
    await bot.handle(g(clear ? '/end clear' : '/end')); await settle(); await settle();
    const gone = tg.deleted.some(([, id]) => id === pin.message_id);
    assert.equal(gone, clear);
    assert.ok(!tg.deleted.some(([, id]) => /Run "/.test(tg.out.find((m) => m.message_id === id)?.text || '')), 'the debrief stays');
  }
});

test('Mark OK rewrites the notice it was pressed on', async () => {
  const { bot, tg, engine, clock, vol } = await started();
  clock.advance(engine.cfg.checkinMs + engine.cfg.coordinatorGraceMs + 1000);
  engine.tick(); await settle();
  const notice = tg.out.find((m) => /Missed check-in notice/.test(m.text || ''));
  const data = notice.extra.reply_markup.inline_keyboard.flat().find((b) => /^ok[|]/.test(b.callback_data)).callback_data;
  await bot.handle({ callback_query: { id: 'q', data, from: from(7, 'Sam'), message: { chat: { id: -500 }, message_id: notice.message_id, text: notice.text } } });
  assert.ok(tg.edits.some(([, mid, text]) => mid === notice.message_id && /Marked OK by Sam/.test(text)));
  assert.ok(vol);
});
