// One-minute proof: runs a whole team run on a fake clock against a fake Telegram, with no keys
// and no network, and checks every step. Run it with: npm run proof
import { Engine } from './engine.js';
import { makeRouter } from './router.js';
import { makeBot } from './bot.js';
import { withoutPositions } from './persist.js';

const clock = { t: Date.UTC(2026, 10, 29, 9, 0), now() { return this.t; } };
const reacts = []; const sent = []; let id = 100;
const rec = (chat, text, extra = {}) => { const m = { chat, text, extra, message_id: ++id }; sent.push(m); return m; };
const telegram = {
  send: async (c, t, e) => rec(c, t, e), edit: async (c, mid, t) => rec(c, `[board edited] ${t}`),
  pin: async () => {}, answerCallback: async () => {}, setReaction: async (c, mid, e) => { reacts.push([c, mid, e]); },
  sendVenue: async (c, la, lo, title, addr, e) => rec(c, `${title} (${addr}) at ${la.toFixed(4)}, ${lo.toFixed(4)}`, e),
  sendLiveLocation: async (c, la, lo) => rec(c, `live location ${la}, ${lo}`), editLiveLocation: async () => {},
  stopLiveLocation: async () => {}, sendPhoto: async (c, b, cap, e) => rec(c, `photo: ${cap}`, e),
  createForumTopic: async () => { throw new Error('not a forum'); }, closeForumTopic: async () => {},
};
const engine = new Engine({ clock });
const router = makeRouter({ engine, telegram, log: () => {} });
engine.notify = router.notify;
const bot = makeBot({ engine, telegram, router });
const tick = () => new Promise((r) => setImmediate(r));
const say = (text, extra = {}) => bot.handle({ message: { chat: { id: -1, type: 'supergroup', title: 'Flood wardens' }, from: { id: 7, first_name: 'Sam' }, text, message_id: ++id, ...extra } });
const minutes = async (n) => { for (let i = 0; i < n; i++) { clock.t += 60_000; engine.tick(); } await tick(); };

let failed = 0;
const check = (label, ok) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) failed++; };
const said = (re) => sent.some((m) => re.test(m.text || ''));

await say('/team Flood wardens'); await say('/run Elm Street door knock'); await say('/add Ana | Area A1');
const code = sent.map((m) => (m.text || '').match(/\n([A-Z0-9]{10})\n/)?.[1]).filter(Boolean).at(-1);
const { token } = engine.pair(code);
check('coordinator adds a volunteer in the group and gets a one-time pairing code', Boolean(token));
check('a used code cannot be used twice', (() => { try { engine.pair(code); return false; } catch { return true; } })());

engine.clue(token, { text: 'Person inside', pos: { lat: 51.5, lng: -0.12 } }); await tick();
const pin = sent.find((m) => /Person inside/.test(m.text || ''));
check('a clue arrives in the group as a map pin with four reply buttons', pin?.extra.reply_markup?.inline_keyboard.flat().length === 4);
check('clue messages cannot be forwarded or saved (protected)', pin?.extra.protect_content === true);

await say('Go back to the road', { reply_to_message: { message_id: pin.message_id } });
const r = engine.sync(token).replies[0];
check('a coordinator reply to the clue appears on the lens', r?.text === 'Go back to the road');
engine.confirmReply(token, r.id); await tick();
check('the volunteer confirms the reply and the coordinator sees an eyes reaction on their own message', reacts.some(([, , e]) => e === '👀'));

await minutes(15 + 2);
check('17 minutes without a check-in: the coordinator gets a missed check-in notice', said(/Missed check-in notice: Ana/));
const loud = sent.find((m) => /Missed check-in notice/.test(m.text || ''));
check('that notice is loud (buzzes phones); the clue before it was quiet', loud.extra.disable_notification === false && pin.extra.disable_notification === true);
await minutes(5);
check('22 minutes: the whole team is told', said(/Still no check-in from Ana/));

engine.checkIn(token, { pos: { lat: 51.51, lng: -0.12 } }); await tick();
await router.updateLocations(Object.keys(engine.runs)[0]);
const copy = JSON.stringify(withoutPositions(engine.snapshot()));
check('during a run, the copy that may leave the server has no positions and no usable sign-in key', !/\d\.\d{3,}/.test(copy) && !copy.includes(token) && !copy.includes(code));
check('a check-in clears it and says so', said(/has checked in again/));

engine.heartbeat(token, { battery: 9, charging: false, worn: true }); await tick();
check('battery at 9%: coordinator is told with the last position', said(/battery low \(9%\)/));
engine.heartbeat(token, { worn: false, charging: false, inCase: false }); await tick();
check('glasses taken off: coordinator is told', said(/taken the glasses off/));

await minutes(4);
check('app silent for 3 minutes: coordinator is told it may be the phone or signal', said(/gone quiet/));

// New in this version: a plain member cannot end the run, backup is a team request, Mark OK clears a notice.
await say('/end', { from: { id: 99, first_name: 'Pat' } }); await tick();
check('a plain group member cannot end the run', engine.runs[Object.keys(engine.runs)[0]].status === 'active');
engine.needBackup(token, { pos: { lat: 51.51, lng: -0.12 } }); await tick();
const bk = sent.find((m) => /asked the team for backup/.test(m.text || ''));
check('need backup: a loud team notice with a map pin, worded as a request', bk?.extra.disable_notification === false && !said(/\b(SOS|urgent|help is coming)\b/i));
engine.heartbeat(token, { battery: 80, charging: false, worn: true });
clock.t += 20 * 60_000; engine.tick(); await tick();
const miss = sent.filter((m) => /Missed check-in notice/.test(m.text || '')).at(-1);
const okBtn = miss.extra.reply_markup.inline_keyboard.flat().find((b) => /^ok[|]/.test(b.callback_data));
await bot.handle({ callback_query: { id: 'q', data: okBtn.callback_data, from: { id: 7, first_name: 'Sam' }, message: { chat: { id: -1 } } } }); await tick();
check('Reached them, mark OK clears the notice and tells the team', said(/marked OK by Sam/));
engine.heartbeat(token, { battery: 80, charging: false, worn: true });

await say('/end'); await tick();
check('the debrief posts counts, with no positions', (() => { const d = sent.find((m) => /finished after/.test(m.text || '')); return Boolean(d) && !/[0-9]+[.][0-9]{3,}/.test(d.text); })());
check('after the run: no positions, trails or tokens are kept', (() => {
  const v = Object.values(engine.runs[Object.keys(engine.runs)[0]].volunteers)[0];
  return v.pos === null && v.trail.length === 0 && Object.keys(engine.tokens).length === 0;
})());
check('after the run: no coordinate-shaped number is left anywhere in the saved state', !/\d\.\d{3,}/.test(JSON.stringify(engine.snapshot())));
check('missed check-in notices say they go only to the team', sent.filter((m) => /Missed check-in|Still no check-in/.test(m.text || '')).every((m) => /only to your own team/.test(m.text)));
check('nothing claims emergency or life-saving service', !sent.some((m) => /\b(SOS|dispatch|rescue|life.?sav|help is coming|diagnos|unconscious|injur)/i.test(m.text || '')));

console.log(failed ? `\n${failed} check(s) failed` : `\nAll checks passed (${sent.length} messages sent to the fake chat).`);
process.exit(failed ? 1 : 0);
