// Shared set-up for the newer tests: a fake clock, a fake Telegram and one volunteer.
import { Engine } from '../server/engine.js';
import { makeRouter } from '../server/router.js';
import { makeBot } from '../server/bot.js';

export function fakeTelegram() {
  let id = 100; const out = []; const answers = []; const reactions = []; const invoices = []; const prechecks = []; const refunds = [];
  const rec = (m) => { const full = { ...m, message_id: ++id }; out.push(full); return full; };
  return {
    out, answers, reactions, invoices, prechecks, refunds,
    send: async (chat, text, extra = {}) => rec({ chat, text, extra }),
    edit: async (chat, mid, text) => { out.push({ chat, edit: mid, text }); return {}; },
    sendVenue: async (chat, lat, lng, title, address, extra = {}) => rec({ chat, text: `${title} @ ${address}`, extra }),
    sendPhoto: async (chat, bytes, caption, extra = {}) => rec({ chat, text: caption, extra }),
    sendLiveLocation: async (chat) => rec({ chat, text: '' }),
    editLiveLocation: async () => {}, stopLiveLocation: async () => {}, pin: async () => {},
    answerCallback: async (qid, text) => { answers.push([qid, text]); },
    setReaction: async (chat, mid, emoji) => { reactions.push([chat, mid, emoji]); },
    createInvoiceLink: async (o) => { invoices.push(o); return `https://t.me/$invoice${invoices.length}`; },
    answerPreCheckoutQuery: async (qid, ok, why) => { prechecks.push([qid, ok, why]); },
    refundStarPayment: async (user, charge) => { refunds.push([user, charge]); },
    createForumTopic: async () => { throw new Error('not a forum'); }, closeForumTopic: async () => {},
  };
}

let line = 1000;
export const msg = (text, extra = {}) => ({ message: { chat: { id: -500, type: 'supergroup', title: 'Wardens' }, from: { id: 7, first_name: 'Sam' }, text, message_id: ++line, ...extra } });
export const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };

export function setup(options = {}) {
  const clock = { t: 5_000_000, now() { return this.t; }, advance(ms) { this.t += ms; } };
  const tg = fakeTelegram();
  const engine = new Engine({ clock });
  const router = makeRouter({ engine, telegram: tg, log: () => {}, ...options.router });
  engine.notify = router.notify;
  const bot = makeBot({ engine, telegram: tg, router, ...options.bot });
  return { clock, tg, engine, router, bot };
}

// A team, a run and one paired volunteer, all through the bot.
export async function start({ bot, engine, tg }, { chat = -500, team = 'Wardens', name = 'Ana', area = 'Area A1' } = {}) {
  const at = { chat: { id: chat, type: 'supergroup', title: team } };
  await bot.handle(msg(`/team ${team}`, at));
  await bot.handle(msg('/run Elm Street', at));
  await bot.handle(msg(`/add ${name} | ${area}`, at));
  const code = tg.out.map((m) => m.text?.match(/\n([A-Z0-9]{10})\n/)?.[1]).filter(Boolean).at(-1);
  const joined = engine.pair(code);
  await settle();
  const run = engine.runs[joined.runId];
  const volunteer = Object.values(run.volunteers).find((v) => v.name === name);
  return { token: joined.token, run, volunteer, id: volunteer.id };
}
