// The try-it page. Each visitor gets a practice team of their own: the same engine, bot and message
// code as the real server, held in memory only. Messages go to a panel on the page instead of
// Telegram. Nothing is sent to Telegram, Discord, a sheet or an AI service, nothing is written to
// disk, and the whole practice team is dropped after half an hour.
import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import { Engine } from './engine.js';
import { makeRouter } from './router.js';
import { makeBot } from './bot.js';
import { makeJoins } from './join.js';
import { makeRoutes } from './api.js';
import { makeLimiter } from './limit.js';
import { intentOf } from './intent.js';

export const GROUP = -1001;
const COORDINATOR = { id: 7, first_name: 'Sam' };
// Short timers, so a visitor sees a missed check-in notice within a few minutes.
export const SANDBOX_TIMERS = Object.freeze({ checkinMs: 2 * 60_000, coordinatorGraceMs: 30_000, teamGraceMs: 60_000, silentMs: 2 * 60_000 });
const KEEP_MESSAGES = 80;

// Stands in for the Telegram sender: it keeps what would have been sent so the page can show it.
export function makeChat({ now = Date.now } = {}) {
  let id = 100;
  const messages = [];
  const buttonsOf = (extra) => (extra?.reply_markup?.inline_keyboard || []).flat().filter((b) => b.callback_data).map((b) => ({ text: b.text, data: b.callback_data }));
  const add = (chat, text, extra = {}, more = {}) => {
    const m = { message_id: ++id, chat: chat === GROUP ? 'group' : 'private', from: 'bot', text: String(text), buttons: buttonsOf(extra), replyTo: extra.reply_to_message_id, at: now(), ...more };
    messages.push(m);
    if (messages.length > KEEP_MESSAGES) messages.shift();
    return m;
  };
  const find = (mid) => messages.find((m) => m.message_id === mid);
  const files = new Map(); // photos the visitor sent, for the lens to fetch
  const telegram = {
    send: async (chat, text, extra) => add(chat, text, extra),
    edit: async (chat, mid, text) => { const m = find(mid); if (m) { m.text = String(text); m.buttons = []; } return {}; },
    editButtons: async (chat, mid, markup) => { const m = find(mid); if (m) m.buttons = buttonsOf({ reply_markup: markup }); },
    sendVenue: async (chat, lat, lng, title, address, extra) => add(chat, `${title}\n${address}`, extra),
    sendPhoto: async (chat, bytes, caption, extra) => add(chat, caption || 'Photo', extra),
    pin: async (chat, mid) => { const m = find(mid); if (m) m.pinned = true; },
    setReaction: async (chat, mid, emoji) => { const m = find(mid); if (m) m.reaction = emoji; },
    getChatMember: async (chat, user) => ({ status: user === COORDINATOR.id ? 'creator' : 'member' }),
    createForumTopic: async () => { throw new Error('not a forum'); },
    closeForumTopic: async () => {},
    deleteMessage: async (chat, mid) => { const i = messages.findIndex((m) => m.message_id === mid); if (i >= 0) messages.splice(i, 1); },
    answerCallback: async () => {},
    sendLiveLocation: async (chat) => add(chat, 'Live location'),
    editLiveLocation: async () => {}, stopLiveLocation: async () => {},
    setMyCommands: async () => {},
    sendVoice: async (chat, bytes, extra) => {
      for (const m of messages) if (m.voice) delete m.voice; // only the newest recording is kept
      return add(chat, 'Voice note', extra, { voice: bytes.toString('base64') });
    },
    download: async (fileId) => { const f = files.get(fileId); if (!f) throw new Error('no file'); return f; },
  };
  return { telegram, messages, add, find, files };
}

export function makeSandboxes({ stt = null, clock = { now: () => Date.now() }, max = 40, ttlMs = 30 * 60_000, perCaller = 8, voicePerSandbox = 15, voicePerDay = 150, log = console.error } = {}) {
  const live = new Map();
  const now = () => clock.now();
  const starts = makeLimiter({ max: perCaller, windowMs: 10 * 60_000, now });
  const voiceDay = makeLimiter({ max: voicePerDay, windowMs: 24 * 60 * 60_000, now });
  const fail = (status, message) => Object.assign(new Error(message), { status });

  function drop() {
    for (const [id, s] of live) if (now() >= s.endsAt) live.delete(id);
  }

  async function create(caller = 'unknown') {
    drop();
    if (!starts.allow(caller)) throw fail(429, 'too many practice teams, try again in a few minutes');
    if (live.size >= max) throw fail(503, 'all practice teams are in use, try again in a few minutes');
    const id = randomBytes(12).toString('hex');
    const chat = makeChat({ now });
    const engine = new Engine({ clock, config: SANDBOX_TIMERS });
    const router = makeRouter({ engine, telegram: chat.telegram, log });
    engine.notify = router.notify;
    const joins = makeJoins({ engine });
    const bot = makeBot({ engine, telegram: chat.telegram, router, joins, botUsername: 'practice_bot' });
    const routes = makeRoutes({ engine, stt, joins, env: {} });
    const s = { id, chat, engine, router, bot, routes, endsAt: now() + ttlMs, actions: 0, voice: 0, updates: 0 };

    // Speech: typed words are used as they are. A real recording goes to speech to text, within limits.
    routes['POST /api/voice'] = async (b) => {
      const { run } = engine.touch(b.token);
      let text = '';
      if (typeof b.devText === 'string') text = b.devText.slice(0, 200);
      else if (stt && b.audio && s.voice < voicePerSandbox && voiceDay.allow('all')) {
        s.voice += 1;
        text = await stt.transcribe(Buffer.from(String(b.audio), 'base64'));
      }
      return { text, intent: intentOf(text, engine.quickClues(run)) };
    };

    await say(s, '/team Practice team');
    await say(s, '/run Elm Street');
    const run = engine.activeRun(Object.keys(engine.teams)[0]);
    const { code } = engine.addVolunteer(run.id, { name: 'Alex', area: 'Area A1' });
    s.runId = run.id;
    live.set(id, s);
    return { id, code, endsInMs: ttlMs };
  }

  const update = (s, body) => s.bot.handle({ update_id: ++s.updates, ...body });
  // A line typed by the practice coordinator, optionally as a reply to one of the bot's messages.
  async function say(s, text, replyTo, photo) {
    const m = s.chat.add(GROUP, text, replyTo ? { reply_to_message_id: replyTo } : {}, { from: 'you', ...(photo ? { photo: photo.toString('base64') } : {}) });
    let content = { text: m.text };
    if (photo) {
      s.chat.files.clear(); s.chat.files.set(`p${m.message_id}`, photo);
      content = { caption: text, photo: [{ file_id: `p${m.message_id}`, width: 320, height: 240 }] };
    }
    await update(s, { message: { message_id: m.message_id, chat: { id: GROUP, type: 'supergroup', title: 'Practice team' }, from: COORDINATOR, ...content, ...(replyTo ? { reply_to_message: { message_id: replyTo } } : {}) } });
  }

  function get(id) {
    drop();
    const s = live.get(id);
    if (!s) throw fail(404, 'this practice team has ended, reload the page for a new one');
    return s;
  }

  const view = (s) => ({ endsInMs: s.endsAt - now(), messages: s.chat.messages, voiceLeft: stt ? voicePerSandbox - s.voice : 0 });

  // What the coordinator panel can do: type a line, reply to a message, or press a button.
  async function act(s, b) {
    if ((s.actions += 1) > 300) throw fail(429, 'this practice team has been used enough, reload for a new one');
    if (typeof b.press === 'string') {
      const m = s.chat.find(Number(b.messageId));
      if (!m?.buttons.some((x) => x.data === b.press)) throw fail(400, 'that button is gone');
      let note = '';
      const answer = s.chat.telegram.answerCallback;
      s.chat.telegram.answerCallback = async (qid, text) => { note = text || ''; };
      try { await update(s, { callback_query: { id: `q${s.updates}`, data: b.press, from: COORDINATOR, message: { message_id: m.message_id, chat: { id: GROUP }, text: m.text } } }); }
      finally { s.chat.telegram.answerCallback = answer; }
      return { ...view(s), note };
    }
    let text = String(b.say || '').trim().slice(0, 300);
    const replyTo = b.replyTo ? s.chat.find(Number(b.replyTo))?.message_id : undefined;
    let photo;
    if (b.photo) {
      photo = Buffer.from(String(b.photo), 'base64');
      if (photo.length < 4 || photo.length > 150 * 1024 || photo[0] !== 0xff || photo[1] !== 0xd8) throw fail(400, 'send a small JPEG picture');
      // A photo goes to Alex's lens: as a reply to the picked message, or else by name.
      if (!replyTo && !/^\/reply\b/.test(text)) text = `/reply Alex ${text}`.trim();
      // Only the newest picture is kept in the panel.
      for (const m of s.chat.messages) delete m.photo;
    } else if (!text) throw fail(400, 'nothing to send');
    await say(s, text, replyTo, photo);
    return view(s);
  }

  function tick() {
    drop();
    for (const s of live.values()) {
      s.engine.tick();
      if (s.engine.runs[s.runId]?.status === 'active') s.router.updateBoard(s.runId);
    }
  }

  return { create, get, view, act, tick, count: () => live.size };
}

// The files the page needs. The lens code is the very same code the glasses run.
const PAGES = {
  '/try': ['./public/try.html', 'text/html'],
  '/try/page.js': ['./public/try.js', 'text/javascript'],
  '/try/sdk.js': ['./public/try-sdk.js', 'text/javascript'],
  '/try/app/main.js': ['../glasses/src/main.js', 'text/javascript'],
  '/try/app/view.js': ['../glasses/src/view.js', 'text/javascript'],
  '/try/app/motion.js': ['../glasses/src/motion.js', 'text/javascript'],
};

// Answers every address under /try. Returns what to send: { file, type } for a page, or the JSON result.
export async function sandboxRequest(sandboxes, { method, path, readBody, caller, signal }) {
  if (method === 'GET' && Object.hasOwn(PAGES, path)) {
    const [file, type] = PAGES[path];
    return { type: `${type}; charset=utf-8`, file: fs.readFileSync(new URL(file, import.meta.url)) };
  }
  if (method === 'POST' && path === '/try/new') return { json: await sandboxes.create(caller) };
  const m = path.match(/^\/try\/s\/([a-f0-9]{24})(\/.+)$/);
  if (!m) return null;
  const s = sandboxes.get(m[1]);
  const rest = m[2];
  if (rest === '/chat' && method === 'GET') return { json: sandboxes.view(s) };
  if (rest === '/chat' && method === 'POST') return { json: await sandboxes.act(s, await readBody(220 * 1024)) };
  const fn = rest.startsWith('/api/') && s.routes[`${method} ${rest}`];
  if (!fn) return null;
  return { json: await fn(await readBody(['/api/voice', '/api/photo', '/api/clue'].includes(rest) ? 900 * 1024 : undefined), { signal, caller: m[1] }) };
}
