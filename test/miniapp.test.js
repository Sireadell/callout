import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import fs from 'node:fs';
import { Engine } from '../server/engine.js';
import { PRESETS } from '../server/router.js';
import { makeMiniApp, validateInitData } from '../server/miniapp.js';
import { makeBot } from '../server/bot.js';

const TOKEN = '123:ABC';
const NOW = 1_800_000_000_000;
// Builds initData the way Telegram does.
function initFor(user, { authDate = NOW / 1000 - 10, token = TOKEN } = {}) {
  const p = new URLSearchParams({ auth_date: String(authDate), query_id: 'q', user: JSON.stringify(user) });
  const check = [...p.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  p.set('hash', createHmac('sha256', secret).update(check).digest('hex'));
  return p.toString();
}

test('initData must be signed with the bot token and be fresh', () => {
  const u = { id: 7, first_name: 'Sam' };
  assert.equal(validateInitData(initFor(u), TOKEN, { now: () => NOW }).id, 7);
  assert.equal(validateInitData(initFor(u, { token: 'other' }), TOKEN, { now: () => NOW }), null);
  assert.equal(validateInitData(initFor(u, { authDate: NOW / 1000 - 7200 }), TOKEN, { now: () => NOW }), null);
  assert.equal(validateInitData(initFor(u).replace('Sam', 'Eve'), TOKEN, { now: () => NOW }), null);
  assert.equal(validateInitData('', TOKEN), null);
  assert.equal(validateInitData('hash=zz', TOKEN), null);
});

function world() {
  const engine = new Engine({ clock: { now: () => NOW } });
  const team = engine.addTeam({ name: 'Wardens', telegram: { chatId: -1, coordinatorUserId: 7 } });
  const run = engine.startRun({ teamId: team.id, name: 'Elm' });
  const { volunteer, code } = engine.addVolunteer(run.id, { name: 'Ana', area: 'A1' });
  const { token } = engine.pair(code);
  engine.clue(token, { text: 'House empty', pos: { lat: 1, lng: 2 } });
  return { engine, run, volunteer, token, app: makeMiniApp({ engine, botToken: TOKEN, presets: PRESETS, now: () => NOW }) };
}

test('the coordinator sees the team and clues; someone else is refused', () => {
  const w = world();
  const s = w.app.state(initFor({ id: 7, first_name: 'Sam' }));
  assert.equal(s.run, 'Elm'); assert.equal(s.volunteers[0].name, 'Ana'); assert.equal(s.clues[0].text, 'House empty');
  assert.throws(() => w.app.state(initFor({ id: 8, first_name: 'Eve' })), /not a coordinator/);
  assert.throws(() => w.app.state('hash=bad'), /not signed in/);
});

test('a preset button from the dashboard reaches the lens; free text and bad input are handled', () => {
  const w = world(); const init = initFor({ id: 7, first_name: 'Sam' });
  w.app.reply(init, { volunteerId: w.volunteer.id, preset: 2 });
  assert.equal(w.engine.sync(w.token).replies[0].text, PRESETS[2]);
  w.app.reply(init, { volunteerId: w.volunteer.id, text: 'Wait there' });
  assert.equal(w.engine.sync(w.token).replies[0].text, 'Wait there');
  assert.throws(() => w.app.reply(init, { volunteerId: w.volunteer.id }), /empty/);
  assert.throws(() => w.app.reply(init, { volunteerId: 'nobody', preset: 0 }), /unknown volunteer/);
  assert.throws(() => w.app.reply(initFor({ id: 9, first_name: 'X' }), { volunteerId: w.volunteer.id, preset: 0 }), /not a coordinator/);
});

test('/app in private chat gives a web app button; in a group it points to the private chat', async () => {
  const out = [];
  const tg = { send: async (c, t, e) => { out.push({ c, t, e }); return { message_id: 1 }; } };
  const bot = makeBot({ engine: new Engine(), telegram: tg, router: {}, appUrl: 'https://x.example/app', botUsername: 'cb' });
  await bot.handle({ message: { chat: { id: 7, type: 'private' }, from: { id: 7 }, text: '/start app' } });
  assert.equal(out.at(-1).e.reply_markup.inline_keyboard[0][0].web_app.url, 'https://x.example/app');
  await bot.handle({ message: { chat: { id: -1, type: 'group' }, from: { id: 7 }, text: '/app' } });
  assert.match(out.at(-1).t, /t\.me\/cb\?start=app/);
  const none = makeBot({ engine: new Engine(), telegram: tg, router: {} });
  await none.handle({ message: { chat: { id: 7, type: 'private' }, from: { id: 7 }, text: '/app' } });
  assert.match(out.at(-1).t, /public address/);
});

test('someone with two teams sees the one with a run going', () => {
  let t = NOW;
  const engine = new Engine({ clock: { now: () => t } });
  const a = engine.addTeam({ name: 'First', telegram: { chatId: -1, coordinatorUserId: 7 } });
  const b = engine.addTeam({ name: 'Second', telegram: { chatId: -2, coordinatorUserId: 7 } });
  const old = engine.startRun({ teamId: a.id, name: 'Old' });
  engine.endRun(old.id); t += 1000;
  engine.startRun({ teamId: b.id, name: 'Now' });
  const s = makeMiniApp({ engine, botToken: TOKEN, presets: PRESETS, now: () => NOW }).state(initFor({ id: 7, first_name: 'Sam' }));
  assert.equal(s.team, 'Second'); assert.equal(s.run, 'Now');
});

// The drawing code lives inside the page, between two markers.
const page = fs.readFileSync(new URL('../server/public/app.html', import.meta.url), 'utf8');
const dotMap = new Function(`${page.split('/* map:start */')[1].split('/* map:end */')[0]}; return dotMap;`)();
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const person = (name, lat, lng) => ({ name, state: 'ok', pos: lat === null ? null : { lat, lng } });
const dots = (svg) => [...svg.matchAll(/<circle [^>]*cx="(-?\d+)" cy="(-?\d+)"/g)].map((m) => [Number(m[1]), Number(m[2])]);

test('the dashboard asks no map service: the only outside address in the page is Telegram', () => {
  const hosts = [...page.matchAll(/https?:\/\/([^/"'\s`)]+)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(hosts)], ['telegram.org']);
  assert.doesNotMatch(page, /openstreetmap|<a /i);
});

test('dots keep north up and east right, inside the picture, with no coordinates in it', () => {
  const svg = dotMap([person('South west', 51.5, -0.13), person('North east', 51.51, -0.12), person('No position', null)], esc);
  const [sw, ne] = dots(svg);
  assert.equal(dots(svg).length, 2);
  assert.ok(ne[0] > sw[0] && ne[1] < sw[1]);
  for (const [x, y] of dots(svg)) assert.ok(x >= 0 && x <= 320 && y >= 0 && y <= 200);
  assert.doesNotMatch(svg, /51\.5|-0\.1/);
  assert.match(svg, />(200|500) m</);
});

test('one person sits in the middle, close people do not look far apart, names are escaped', () => {
  assert.deepEqual(dots(dotMap([person('Ana', 51.5, -0.12)], esc)), [[160, 100]]);
  const [a, b] = dots(dotMap([person('A', 51.5, -0.12), person('B', 51.50002, -0.12)], esc));
  assert.ok(Math.abs(a[1] - b[1]) < 20);
  assert.match(dotMap([person('<img src=x>', 51.5, -0.12)], esc), /&lt;img src=x&gt;/);
  assert.equal(dotMap([person('Ana', null)], esc), '');
});

test('the state shows each volunteer kit model', () => {
  const w = world();
  w.engine.heartbeat(w.token, { device: { model: 'g2', ring: true } });
  const s = w.app.state(initFor({ id: 7, first_name: 'Sam' }));
  assert.deepEqual(s.volunteers[0].device, { model: 'g2', ring: true });
});
