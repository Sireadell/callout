import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { setup, msg, settle, start } from './helpers.js';
import { Telegram, UPDATES } from '../server/telegram.js';
import { makeSandboxes } from '../server/sandbox.js';
import { makeMiniApp } from '../server/miniapp.js';
import { makeBot, COMMANDS } from '../server/bot.js';
import { makeJoins } from '../server/join.js';
import { Engine } from '../server/engine.js';

const DAY = 24 * 60 * 60_000;
const opts = { bot: { freePeople: 2, planStars: 250 } };
const SAM = { from: { id: 7, first_name: 'Sam' } };
const BEN = { from: { id: 42, first_name: 'Ben' } };
const FREE = 'Free plan covers 2 people per run. Send /plan to see the Team plan.';
const lastText = (tg) => tg.out.at(-1).text;
const teamOf = (s) => Object.values(s.engine.teams)[0];
const people = (s) => Object.keys(s.engine.activeRun(teamOf(s).id).volunteers).length;
const paid = (s, team, extra = {}, from = SAM.from) => s.bot.handle({ message: { chat: { id: from.id, type: 'private' }, from, message_id: 1, successful_payment: { currency: 'XTR', total_amount: 250, invoice_payload: `team:${team.id}`, telegram_payment_charge_id: 'ch_1', ...extra } } });

test('the free plan stops the 3rd person on a real team, and the Team plan lifts it', async () => {
  const s = setup(opts);
  await start(s, { name: 'Ana' });
  await s.bot.handle(msg('/add Bo | Area B'));
  await s.bot.handle(msg('/add Cy | Area C'));
  assert.equal(lastText(s.tg), FREE);
  assert.equal(people(s), 2);
  // Someone still waiting for a code gets a fresh one, not a new place.
  await s.bot.handle(msg('/add Bo | Area B'));
  assert.notEqual(lastText(s.tg), FREE);
  await paid(s, teamOf(s));
  await s.bot.handle(msg('/add Cy | Area C'));
  assert.equal(people(s), 3);
});

test('a lens joiner who would be the 3rd person is turned away on the free plan', async () => {
  const s = setup(opts);
  s.joins = makeJoins({ engine: s.engine });
  s.bot = makeBot({ engine: s.engine, telegram: s.tg, router: s.router, joins: s.joins, ...opts.bot });
  await start(s, { name: 'Ana' });
  await s.bot.handle(msg('/add Bo | Area B'));
  const { code } = s.joins.create();
  await s.bot.handle(msg(`/join ${code}`, BEN));
  const buttons = s.tg.out.filter((m) => /wants to join/.test(m.text || '')).at(-1).extra.reply_markup.inline_keyboard.flat();
  const newOne = buttons.find((b) => b.text.startsWith('New: Ben'));
  await s.bot.handle({ callback_query: { id: 'q', data: newOne.callback_data, from: SAM.from, message: { chat: { id: -500 } } } });
  await settle();
  assert.equal(lastText(s.tg), FREE);
  assert.equal(people(s), 2);
});

test('there is no cap without a limit (the practice team and the proof script)', async () => {
  const s = setup();
  await start(s, { name: 'Ana' });
  for (const n of ['Bo', 'Cy', 'Di', 'Ed', 'Flo', 'Gus', 'Hal', 'Ida', 'Jo']) await s.bot.handle(msg(`/add ${n} | Area`));
  assert.equal(people(s), 10);
  const sandboxes = makeSandboxes({ log: () => {} });
  const { id } = await sandboxes.create('t');
  const sb = sandboxes.get(id);
  for (const n of ['Bo', 'Cy', 'Di', 'Ed', 'Flo', 'Gus', 'Hal', 'Ida', 'Jo']) await sandboxes.act(sb, { say: `/add ${n} | Area` });
  assert.equal(Object.keys(sb.engine.runs[sb.runId].volunteers).length, 10);
  await sandboxes.act(sb, { say: '/plan' });
  assert.match(sb.chat.messages.at(-1).text, /Payments are not set up/);
});

test('/plan shows the plan and builds a 30 day Stars invoice for the team', async () => {
  const s = setup(opts);
  await start(s);
  await s.bot.handle(msg('/plan'));
  const inv = s.tg.invoices[0];
  assert.deepEqual([inv.payload, inv.amount, inv.periodSeconds], [`team:${teamOf(s).id}`, 250, 2592000]);
  const m = s.tg.out.at(-1);
  assert.match(m.text, /^Free plan: up to 2 people per run/);
  assert.equal(m.extra.reply_markup.inline_keyboard[0][0].url, 'https://t.me/$invoice1');
  // Not the coordinator: refused, no invoice.
  await s.bot.handle(msg('/plan', BEN));
  assert.equal(s.tg.invoices.length, 1);
  // With a plan running, it says so.
  await paid(s, teamOf(s));
  await s.bot.handle(msg('/plan'));
  assert.match(s.tg.out.at(-1).text, /^Team plan until \d{4}-\d\d-\d\d\./);
});

test('the invoice request uses XTR, an empty provider token and the subscription period', async () => {
  let sent;
  const t = new Telegram('T', { minGapMs: 0, sleep: async () => {}, fetchImpl: async (url, init) => { sent = [url, JSON.parse(init.body)]; return { json: async () => ({ ok: true, result: 'link' }) }; } });
  assert.equal(await t.createInvoiceLink({ title: 'T', description: 'D', payload: 'team:1', amount: 250, label: 'L', periodSeconds: 2592000 }), 'link');
  assert.match(sent[0], /createInvoiceLink$/);
  assert.deepEqual([sent[1].currency, sent[1].provider_token, sent[1].subscription_period, sent[1].prices], ['XTR', '', 2592000, [{ label: 'L', amount: 250 }]]);
  await t.refundStarPayment(7, 'ch');
  assert.deepEqual([sent[1].user_id, sent[1].telegram_payment_charge_id], [7, 'ch']);
  await t.answerPreCheckoutQuery('p', false, 'no');
  assert.deepEqual([sent[1].pre_checkout_query_id, sent[1].ok, sent[1].error_message], ['p', false, 'no']);
  await t.setWebhook('https://x/y', 's');
  assert.ok(sent[1].allowed_updates.includes('pre_checkout_query'));
  assert.ok(UPDATES.includes('pre_checkout_query'));
});

test('pre-checkout is accepted for a known team and refused for an unknown one', async () => {
  const s = setup(opts);
  await start(s);
  const q = (id, payload) => ({ pre_checkout_query: { id, from: SAM.from, invoice_payload: payload, currency: 'XTR', total_amount: 250 } });
  await s.bot.handle(q('p1', `team:${teamOf(s).id}`));
  await s.bot.handle(q('p2', 'team:nope'));
  await s.bot.handle(q('p3', 'junk'));
  assert.deepEqual(s.tg.prechecks.map((x) => [x[0], x[1]]), [['p1', true], ['p2', false], ['p3', false]]);
  assert.ok(s.tg.prechecks[1][2]);
});

test('a successful payment sets the plan, using the subscription end date when sent', async () => {
  const s = setup(opts);
  await start(s);
  const team = teamOf(s);
  const until = Math.floor((s.clock.t + 30 * DAY) / 1000) + 3600;
  await paid(s, team, { subscription_expiration_date: until, is_recurring: true });
  assert.deepEqual(team.plan, { tier: 'team', until: until * 1000, chargeId: 'ch_1', payer: 7, paidAt: s.clock.t });
  assert.match(s.tg.out.filter((m) => m.chat === -500).at(-1).text, /^Team plan active until \d{4}-\d\d-\d\d\.$/);
  // Without an end date: 30 days from now. A payment for an unknown team changes nothing.
  const t2 = setup(opts); await start(t2);
  await paid(t2, teamOf(t2));
  assert.equal(teamOf(t2).plan.until, t2.clock.t + 30 * DAY);
  await paid(t2, { id: 'nope' }, { telegram_payment_charge_id: 'x' });
  assert.equal(teamOf(t2).plan.chargeId, 'ch_1');
});

test('an expired plan no longer lifts the cap', async () => {
  const s = setup(opts);
  await start(s, { name: 'Ana' });
  await paid(s, teamOf(s));
  s.clock.advance(31 * DAY);
  await s.bot.handle(msg('/add Bo | Area B'));
  await s.bot.handle(msg('/add Cy | Area C'));
  assert.equal(lastText(s.tg), FREE);
});

test('the plan is saved with the team and shown only to the coordinator in the dashboard', async () => {
  const s = setup(opts);
  await start(s);
  const team = teamOf(s);
  team.telegram.coordinatorUserId = 7;
  const before = makeMiniApp({ engine: s.engine, botToken: '123:ABC', presets: [], now: () => s.clock.t });
  const init = () => {
    const p = new URLSearchParams({ auth_date: String(s.clock.t / 1000 - 5), user: JSON.stringify({ id: 7, first_name: 'Sam' }) });
    const check = [...p.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
    p.set('hash', createHmac('sha256', createHmac('sha256', 'WebAppData').update('123:ABC').digest()).update(check).digest('hex'));
    return p.toString();
  };
  assert.deepEqual(before.state(init()).plan, { tier: 'free' });
  await paid(s, team);
  assert.deepEqual(before.state(init()).plan, { tier: 'team', until: team.plan.until });
  const copy = JSON.parse(JSON.stringify(s.engine.snapshot()));
  const e2 = new Engine({ clock: s.clock }); e2.restore(copy);
  assert.equal(Object.values(e2.teams)[0].plan.payer, 7);
});

test('refund: only the payer, within 7 days, puts the team back on the free plan', async () => {
  const s = setup(opts);
  await start(s);
  const team = teamOf(s);
  await paid(s, team);
  await s.bot.handle(msg('/refund', BEN));
  assert.equal(s.tg.refunds.length, 0);
  assert.match(lastText(s.tg), /Only the person who paid/);
  await s.bot.handle(msg('/refund'));
  assert.deepEqual(s.tg.refunds, [[7, 'ch_1']]);
  assert.equal(team.plan, undefined);
  await s.bot.handle(msg('/refund'));
  assert.match(lastText(s.tg), /no paid plan/);
  // After 7 days: refused.
  await paid(s, team);
  s.clock.advance(7 * DAY + 1000);
  await s.bot.handle(msg('/refund'));
  assert.equal(s.tg.refunds.length, 1);
  assert.match(lastText(s.tg), /within 7 days/);
  assert.equal(team.plan.tier, 'team');
});

test('if Telegram refuses the refund the plan stays', async () => {
  const s = setup(opts);
  await start(s);
  await paid(s, teamOf(s));
  s.tg.refundStarPayment = async () => { throw new Error('no'); };
  await s.bot.handle(msg('/refund'));
  assert.match(lastText(s.tg), /did not go through/);
  assert.equal(teamOf(s).plan.tier, 'team');
});

test('/paysupport and /terms answer, and the commands are listed', async () => {
  const s = setup(opts);
  await s.bot.handle(msg('/paysupport'));
  assert.match(lastText(s.tg), /\/refund/);
  await s.bot.handle(msg('/terms'));
  assert.match(lastText(s.tg), /250 Telegram Stars/);
  await s.bot.handle(msg('/help'));
  assert.match(lastText(s.tg), /\/plan/);
  for (const c of ['plan', 'refund', 'paysupport', 'terms']) assert.ok([...COMMANDS.everyone, ...COMMANDS.coordinator].some((x) => x.command === c), c);
});
