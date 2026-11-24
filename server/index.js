// Callout server: the glasses app talks to /api/*, Telegram talks to the bot.
import http from 'node:http';
import fs from 'node:fs';
import { Engine } from './engine.js';
import { Telegram } from './telegram.js';
import { Discord } from './discord.js';
import { makeRouter } from './router.js';
import { makeBot } from './bot.js';

if (fs.existsSync('.env')) process.loadEnvFile('.env');
const PORT = Number(process.env.PORT || 8787);
const STATE = 'data/state.json';

const telegram = process.env.TELEGRAM_BOT_TOKEN ? new Telegram(process.env.TELEGRAM_BOT_TOKEN) : null;
const discord = new Discord();
const engine = new Engine();
const router = makeRouter({ engine, telegram, discord });
engine.notify = router.notify;
if (fs.existsSync(STATE)) engine.restore(JSON.parse(fs.readFileSync(STATE, 'utf8')));
const bot = telegram ? makeBot({ engine, telegram, router }) : null;

// Save to disk every few seconds when something changed.
let lastSaved = '';
function save() {
  const s = JSON.stringify(engine.snapshot());
  if (s === lastSaved) return;
  fs.mkdirSync('data', { recursive: true });
  fs.writeFileSync(`${STATE}.tmp`, s);
  fs.renameSync(`${STATE}.tmp`, STATE);
  lastSaved = s;
}
setInterval(() => { engine.tick(); Object.keys(engine.runs).forEach((id) => engine.runs[id].status === 'active' && router.updateBoard(id)); save(); }, 5000).unref();

// ---- very small request helpers ----
const hits = new Map();
const limited = (ip) => { const m = Math.floor(Date.now() / 60000); const k = `${ip}:${m}`; hits.set(k, (hits.get(k) || 0) + 1); if (hits.size > 5000) hits.clear(); return hits.get(k) > 240; };
function body(req) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', (c) => { n += c.length; if (n > 64 * 1024) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks)) : {}); } catch { reject(new Error('bad json')); } });
  });
}
const send = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'GET,POST,OPTIONS' }); res.end(JSON.stringify(obj)); };

const routes = {
  'POST /api/pair': (b) => engine.pair(b.code),
  'POST /api/checkin': (b) => engine.checkIn(b.token, { pos: b.pos }),
  'POST /api/heartbeat': (b) => { engine.heartbeat(b.token, b); return { ok: true }; },
  'POST /api/clue': (b) => { const c = engine.clue(b.token, b); return { id: c.id }; },
  'POST /api/confirm': (b) => { engine.confirmReply(b.token, b.replyId); return { ok: true }; },
  'POST /api/sync': (b) => engine.sync(b.token, { pos: b.pos }),
  'GET /healthz': () => ({ ok: true }),
};
// Local testing only: makes a team, a run and one volunteer and returns the pairing code.
if (process.env.CALLOUT_DEV === '1') {
  routes['POST /dev/seed'] = (b) => {
    const team = engine.addTeam({ name: b.team || 'Test team' });
    const run = engine.startRun({ teamId: team.id, name: b.run || 'Elm Street' });
    const { code } = engine.addVolunteer(run.id, { name: b.name || 'Ana', area: b.area || 'Area A1' });
    return { runId: run.id, code };
  };
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204, {});
  const url = new URL(req.url, 'http://x');
  try {
    if (limited(req.socket.remoteAddress)) return send(res, 429, { error: 'slow down' });
    if (req.method === 'POST' && url.pathname === '/telegram/webhook') {
      if (!process.env.TELEGRAM_WEBHOOK_SECRET || req.headers['x-telegram-bot-api-secret-token'] !== process.env.TELEGRAM_WEBHOOK_SECRET) return send(res, 401, {});
      const update = await body(req);
      send(res, 200, {});
      bot?.handle(update).catch((e) => console.error('bot error:', e.message));
      return;
    }
    const fn = routes[`${req.method} ${url.pathname}`];
    if (!fn) return send(res, 404, { error: 'not found' });
    send(res, 200, fn(req.method === 'POST' ? await body(req) : {}));
  } catch (e) {
    send(res, 400, { error: e.message });
  }
});

// Without a public address, the bot listens by asking Telegram for updates.
async function poll() {
  let offset = 0;
  for (;;) {
    try {
      for (const u of await telegram.getUpdates(offset)) { offset = u.update_id + 1; await bot.handle(u).catch((e) => console.error('bot error:', e.message)); }
    } catch (e) { console.error('poll error:', e.message); await new Promise((r) => setTimeout(r, 3000)); }
  }
}

server.listen(PORT, () => {
  console.log(`Callout server on :${PORT}`);
  if (telegram && !process.env.TELEGRAM_WEBHOOK_SECRET) { console.log('Telegram: polling'); poll(); }
});
