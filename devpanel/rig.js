// DEV PANEL ONLY. Starts a local Callout server with a fake Telegram, sets up a team and a run
// through the bot (as Telegram would, over the webhook), and pairs the real glasses app to it.
import { spawn } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startLens } from './lens.js';

const TOKEN = '0:devpanel';
export const GROUP = -1001;
export const COORDINATOR = { id: 7, first_name: 'Sam' };

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function until(fn, { ms = 30_000, step = 200 } = {}) {
  const end = performance.now() + ms;
  for (;;) {
    const got = fn();
    if (got) return got;
    if (performance.now() > end) return null;
    await sleep(step);
  }
}

export async function startRig({ port = 8788, silentSeconds = 20, onServerLine = () => {} } = {}) {
  const server = `http://127.0.0.1:${port}`;
  const secret = randomBytes(12).toString('hex');
  // An empty folder, so no .env file and no saved state from real use is ever picked up.
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'callout-devpanel-'));
  const keep = Object.fromEntries(['PATH', 'Path', 'SystemRoot', 'TEMP', 'TMP', 'HOME'].filter((k) => process.env[k]).map((k) => [k, process.env[k]]));
  const child = spawn(process.execPath, ['--import', new URL('./fake-telegram.js', import.meta.url).href, fileURLToPath(new URL('../server/index.js', import.meta.url))], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { ...keep, PORT: String(port), CALLOUT_DEVPANEL: '1', CALLOUT_DEV: '1', DEV_SILENT_S: String(silentSeconds), TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_WEBHOOK_SECRET: secret, PUBLIC_URL: server },
  });
  const sent = []; // every Telegram call the server made
  let ready = false; let died = false;
  child.on('message', (m) => sent.push({ ...m, at: new Date() }));
  child.on('exit', () => { died = true; });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (d) => { const s = String(d); if (/webhook set/.test(s)) ready = true; onServerLine(s.trimEnd()); });
  const stop = () => { child.kill(); try { fs.rmSync(cwd, { recursive: true, force: true }); } catch { /* still closing */ } };
  process.on('exit', stop);
  await until(() => ready || died, { ms: 15_000 });
  if (!ready) { stop(); throw new Error(`the local server did not start (is port ${port} free?)`); }

  let updateId = 0; let messageId = 5000;
  const update = async (body) => {
    const r = await realFetch(`${server}/telegram/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': secret }, body: JSON.stringify({ update_id: ++updateId, ...body }) });
    if (!r.ok) throw new Error(`webhook ${r.status}`);
  };
  const realFetch = globalThis.fetch;
  const textOf = (m) => m.body.text || m.body.caption || (m.body.title ? `${m.body.title} (${m.body.address})` : '');
  const find = (re, from = 0) => sent.slice(from).find((m) => re.test(textOf(m)));
  const say = (text) => update({ message: { message_id: ++messageId, chat: { id: GROUP, type: 'supergroup', title: 'Practice team' }, from: COORDINATOR, text } });
  const press = (messageIdPressed, data) => update({ callback_query: { id: `q${++updateId}`, data, from: COORDINATOR, message: { message_id: messageIdPressed, chat: { id: GROUP } } } });

  // Adds a volunteer through the bot and returns the pairing code it sent.
  async function addVolunteer(name, area) {
    const from = sent.length;
    await say(`/add ${name} | ${area}`);
    const msg = await until(() => find(new RegExp(`${name}[\\s\\S]*\\b[A-HJKMNP-Z2-9]{10}\\b`), from));
    if (!msg) throw new Error('the bot sent no pairing code');
    return textOf(msg).match(/\b[A-HJKMNP-Z2-9]{10}\b/)[0];
  }
  // A second person with no lens of their own, who talks to the server directly.
  async function api(route, body) {
    const r = await realFetch(`${server}${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || r.status);
    return j;
  }
  // The sign-in data Telegram would give the coordinator's dashboard, signed with the fake token.
  function miniAppUrl() {
    const p = new URLSearchParams({ auth_date: String(Math.floor(performance.timeOrigin / 1000 + performance.now() / 1000) - 5), query_id: 'devpanel', user: JSON.stringify(COORDINATOR) });
    const check = [...p.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
    p.set('hash', createHmac('sha256', createHmac('sha256', 'WebAppData').update(TOKEN).digest()).update(check).digest('hex'));
    return `${server}/app#tgWebAppData=${encodeURIComponent(p.toString())}&tgWebAppVersion=8.0&tgWebAppPlatform=web`;
  }

  await say('/team Practice team');
  await say('/run Elm Street');
  const code = await addVolunteer('Ana', 'Area A1');
  const lens = await startLens({ server });
  await lens.pair(code);
  return { server, sent, textOf, find, say, press, addVolunteer, api, miniAppUrl, lens, stop };
}
