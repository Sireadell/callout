import { intentOf } from './intent.js';
import { makeLongPoll } from './longpoll.js';

// One log line that shows whose address the rate limit counts: the caller's, or a proxy in front of the server.
// Addresses are cut short so no caller can be identified from the log.
export function describeCaller(req) {
  const cut = (a) => {
    const s = String(a || '').replace(/^::ffff:/, '');
    return s.includes(':') ? `${s.split(':').slice(0, 2).join(':')}:x` : `${s.split('.').slice(0, 2).join('.')}.x`;
  };
  const chain = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
  const direct = req.socket.remoteAddress;
  const same = chain.length > 0 && chain[0] === String(direct || '').replace(/^::ffff:/, '');
  return `rate limit sees ${cut(direct)}; forwarded-for entries: ${chain.length}${chain.length ? `, first ${cut(chain[0])}, same as seen: ${same ? 'yes' : 'no'}` : ''}`;
}

// What the glasses app and the Mini App can ask the server. Kept apart from the web server so it can be tested.
export function makeRoutes({ engine, stt, miniapp = null, env = process.env }) {
  const sync = makeLongPoll({ engine });
  return {
    'POST /api/pair': (b) => engine.pair(b.code),
    'POST /api/checkin': (b) => engine.checkIn(b.token, { pos: b.pos, at: b.at }),
    'POST /api/heartbeat': (b) => { engine.heartbeat(b.token, b); return { ok: true }; },
    'POST /api/clue': (b) => { const c = engine.clue(b.token, b); return { id: c.id }; },
    'POST /api/signout': (b) => { engine.signOut(b.token); return { ok: true }; },
    'POST /api/backup': (b) => { engine.needBackup(b.token, { pos: b.pos }); return { ok: true }; },
    'POST /api/confirm': (b) => { engine.confirmReply(b.token, b.replyId); return { ok: true }; },
    // With "wait" it holds the request until there is news. "signal" fires if the caller goes away.
    'POST /api/sync': (b, { signal } = {}) => sync(b, signal),
    // Audio from the glasses: base64 of raw 16 kHz 16 bit mono. Returns the words and what they ask for.
    // Nothing is stored and nothing is sent from here.
    'POST /api/voice': async (b) => {
      const { run } = engine.touch(b.token); // checks the token and leaves waiting replies for the next sync
      const text = !env.ASSEMBLYAI_API_KEY && env.CALLOUT_DEV === '1'
        ? b.devText ?? 'Person inside' // dev stub, labelled in the video
        : await stt.transcribe(Buffer.from(String(b.audio || ''), 'base64'));
      return { text, intent: intentOf(text, engine.quickClues(run)) };
    },
    'POST /api/answer': (b) => { engine.answer(b.token, { questionId: b.questionId, answer: b.answer, at: b.at }); return { ok: true }; },
    // A photo for a clue already sent: base64 JPEG, passed on to the chat and not kept.
    'POST /api/photo': (b) => engine.attachPhoto(b.token, { clueId: b.clueId, bytes: Buffer.from(String(b.image || ''), 'base64') }),
    'POST /app/api/state': (b) => { if (!miniapp) throw new Error('not set up'); return miniapp.state(b.initData); },
    'POST /app/api/reply': (b) => { if (!miniapp) throw new Error('not set up'); return miniapp.reply(b.initData, b); },
    'GET /healthz': () => ({ ok: true }),
  };
}
