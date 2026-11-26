// Callout server: the glasses app talks to /api/*, Telegram talks to the bot.
import http from 'node:http';
import fs from 'node:fs';
import { Engine } from './engine.js';
import { Telegram } from './telegram.js';
import { Discord, verifyInteraction, makeInteractionHandler } from './discord.js';
import { PRESETS } from './router.js';
import { makeRouter } from './router.js';
import { makeBot } from './bot.js';
import { makeStt } from './stt.js';
import { makeAi } from './ai.js';
import { makeMiniApp } from './miniapp.js';
import { makeSheet } from './sheet.js';
import { makeRoutes, describeCaller } from './api.js';
import { makeSaver } from './saver.js';

if (fs.existsSync('.env')) process.loadEnvFile('.env');
const PORT = Number(process.env.PORT || 8787);
const STATE = 'data/state.json';

const telegram = process.env.TELEGRAM_BOT_TOKEN ? new Telegram(process.env.TELEGRAM_BOT_TOKEN) : null;
const discord = new Discord({ botToken: process.env.DISCORD_BOT_TOKEN || null });
// Dev only: shorten the timers (in seconds) so the notice steps can be seen in a minute or two.
const secs = (k, d) => (process.env.CALLOUT_DEV === "1" && process.env[k] ? Number(process.env[k]) * 1000 : d);
const engine = new Engine({ config: { checkinMs: secs("DEV_CHECKIN_S", 15 * 60_000), coordinatorGraceMs: secs("DEV_GRACE1_S", 2 * 60_000), teamGraceMs: secs("DEV_GRACE2_S", 5 * 60_000), silentMs: secs("DEV_SILENT_S", 3 * 60_000) } });
const router = makeRouter({ engine, telegram, discord });
engine.notify = router.notify;
if (fs.existsSync(STATE)) engine.restore(JSON.parse(fs.readFileSync(STATE, 'utf8')));
let bot = null;
const ai = makeAi({ anthropicKey: process.env.ANTHROPIC_API_KEY, openrouterKey: process.env.OPENROUTER_API_KEY, openrouterModel: process.env.OPENROUTER_MODEL || undefined });
const sheet = process.env.GOOGLE_SERVICE_ACCOUNT_FILE && fs.existsSync(process.env.GOOGLE_SERVICE_ACCOUNT_FILE)
  ? makeSheet({ serviceAccount: JSON.parse(fs.readFileSync(process.env.GOOGLE_SERVICE_ACCOUNT_FILE, 'utf8')) }) : null;
// A host that wipes its disk on restart: pick the state back up from the Sheet copy (no positions).
if (!fs.existsSync(STATE) && sheet && process.env.STATE_SHEET_ID) {
  const copy = await sheet.readState(process.env.STATE_SHEET_ID);
  if (copy) { engine.restore(copy); console.log('Restored state from the Sheet copy'); }
}

// Save to disk every few seconds when something changed. With STATE_SHEET_ID set, also keep a copy in the Sheet.
const saver = makeSaver({ engine, file: STATE, sheet, sheetId: process.env.STATE_SHEET_ID || null });
engine.changed = () => queueMicrotask(saver.saveNow);
setInterval(() => { engine.tick(); Object.keys(engine.runs).forEach((id) => engine.runs[id].status === 'active' && (router.updateBoard(id), router.updateLocations(id))); saver.save(); }, 5000).unref();

// ---- very small request helpers ----
const hits = new Map();
const limited = (ip) => { const m = Math.floor(Date.now() / 60000); const k = `${ip}:${m}`; hits.set(k, (hits.get(k) || 0) + 1); if (hits.size > 5000) hits.clear(); return hits.get(k) > 240; };
function body(req, cap = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', (c) => { n += c.length; if (n > cap) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks)) : {}); } catch { reject(new Error('bad json')); } });
  });
}
const send = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'GET,POST,OPTIONS' }); res.end(JSON.stringify(obj)); };

const discordInteraction = makeInteractionHandler({ engine, presets: PRESETS });
function rawBody(req, cap = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', (c) => { n += c.length; if (n > cap) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}
const miniapp = process.env.TELEGRAM_BOT_TOKEN ? makeMiniApp({ engine, botToken: process.env.TELEGRAM_BOT_TOKEN, presets: PRESETS }) : null;
const stt = makeStt({ apiKey: process.env.ASSEMBLYAI_API_KEY });
const routes = makeRoutes({ engine, stt, miniapp });
// Local testing only: makes a team, a run and one volunteer and returns the pairing code.
if (process.env.CALLOUT_DEV === '1') {
  routes['POST /dev/seed'] = (b) => {
    const team = engine.addTeam({ name: b.team || 'Test team' });
    const run = engine.startRun({ teamId: team.id, name: b.run || 'Elm Street' });
    const { code } = engine.addVolunteer(run.id, { name: b.name || 'Ana', area: b.area || 'Area A1' });
    return { runId: run.id, code };
  };
}

let callersLogged = 0;
const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204, {});
  const url = new URL(req.url, 'http://x');
  if (url.pathname.startsWith('/api/') && callersLogged < 3) { callersLogged += 1; console.log(describeCaller(req)); }
  try {
    if (limited(req.socket.remoteAddress)) return send(res, 429, { error: 'slow down' });
    if (req.method === 'POST' && url.pathname === '/telegram/webhook') {
      if (!process.env.TELEGRAM_WEBHOOK_SECRET || req.headers['x-telegram-bot-api-secret-token'] !== process.env.TELEGRAM_WEBHOOK_SECRET) return send(res, 401, {});
      const update = await body(req);
      send(res, 200, {});
      bot?.handle(update).catch((e) => console.error('bot error:', e.message));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/discord/interactions') {
      const raw = await rawBody(req);
      if (!process.env.DISCORD_PUBLIC_KEY || !verifyInteraction(process.env.DISCORD_PUBLIC_KEY, String(req.headers['x-signature-ed25519'] || ''), req.headers['x-signature-timestamp'], raw)) return send(res, 401, {});
      return send(res, 200, discordInteraction(JSON.parse(raw)));
    }
    if (req.method === 'GET' && url.pathname === '/app') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(fs.readFileSync(new URL('./public/app.html', import.meta.url)));
    }
    const fn = routes[`${req.method} ${url.pathname}`];
    if (!fn) return send(res, 404, { error: 'not found' });
    send(res, 200, await fn(req.method === 'POST' ? await body(req, (url.pathname === '/api/voice' || url.pathname === '/api/photo') ? 900 * 1024 : undefined) : {}));
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

async function startTelegram() {
  const me = await telegram.getMe();
  bot = makeBot({ engine, telegram, router, botUsername: me.username, ai, sheet, appUrl: process.env.PUBLIC_URL ? `${process.env.PUBLIC_URL}/app` : null, discordDefault: process.env.DISCORD_WEBHOOK_URL ? { webhookUrl: process.env.DISCORD_WEBHOOK_URL, channelId: process.env.DISCORD_CHANNEL_ID || null } : null });
  await bot.register().catch((e) => console.error('commands:', e.message));
  if (process.env.TELEGRAM_WEBHOOK_SECRET && process.env.PUBLIC_URL) {
    await telegram.setWebhook(`${process.env.PUBLIC_URL}/telegram/webhook`, process.env.TELEGRAM_WEBHOOK_SECRET);
    console.log('Telegram: webhook set');
  } else { await telegram.call('deleteWebhook'); console.log('Telegram: polling'); poll(); }
}

server.listen(PORT, () => {
  console.log(`Callout server on :${PORT}`);
  if (telegram) startTelegram().catch((e) => console.error('telegram start failed:', e.message));
});

// A deploy or restart: stop taking requests, save everything, then leave.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, async () => {
    setTimeout(() => process.exit(0), 8000).unref();
    server.close();
    server.closeAllConnections();
    await saver.saveNow();
    process.exit(0);
  });
}
