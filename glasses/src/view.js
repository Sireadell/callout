// Pure screen text for the lenses. No emoji: the lens drops them. Glyphs used: ● ○ ▲ ━
//
// Every screen is three text boxes: a bright main box, a dim status box and a dimmer hint line.
// Each box is wrapped and cut here, so nothing ever runs off the lens.
export const COLS = 44;
export const BOXES = [
  { id: 1, name: 'main', key: 'main', y: 0, height: 180, lines: 6, brightness: 4, capture: 1 },
  { id: 2, name: 'status', key: 'status', y: 184, height: 62, lines: 2, brightness: 2, capture: 0 },
  { id: 3, name: 'hint', key: 'hint', y: 250, height: 38, lines: 1, brightness: 1, capture: 0 },
];

export function wrap(text, cols = COLS) {
  const out = [];
  for (const para of String(text).split('\n')) {
    let line = '';
    for (let word of para.split(/\s+/).filter(Boolean)) {
      while (word.length > cols) {
        if (line) { out.push(line); line = ''; }
        out.push(word.slice(0, cols)); word = word.slice(cols);
      }
      if (!word) continue;
      if (line && line.length + 1 + word.length > cols) { out.push(line); line = word; }
      else line = line ? `${line} ${word}` : word;
    }
    out.push(line);
  }
  return out;
}

// Wrapped to the box width and cut to its line count. A cut line ends in "..." so it is never silent.
export function fit(parts, max, cols = COLS) {
  const lines = wrap(parts.join('\n'), cols);
  while (lines.length && !lines.at(-1)) lines.pop();
  if (lines.length <= max) return lines.join('\n');
  const kept = lines.slice(0, max);
  kept[max - 1] = `${kept[max - 1].slice(0, cols - 3)}...`;
  return kept.join('\n');
}

const screen = (main, status = [], hint = '') => ({
  main: fit(main, BOXES[0].lines),
  status: fit(status, BOXES[1].lines),
  hint: fit([hint], BOXES[2].lines),
});

export function fmtClock(ms) {
  const neg = ms < 0;
  const s = Math.floor(Math.abs(ms) / 1000);
  const mm = String(Math.floor(s / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${neg ? '-' : ''}${mm}:${ss}`;
}

const dueIn = (state, now) => state.sync.dueInMs - (now - state.syncedAt);
const countdown = (due) => (due < 0 ? `▲ OVERDUE ${fmtClock(due)}` : `Next check-in ${fmtClock(due)}`);

// Things that need attention, most important first.
function warnings(state, now) {
  const out = [];
  const d = state.device || {};
  if (typeof d.batteryLevel === 'number' && d.batteryLevel <= 15 && !d.isCharging) out.push(`▲ Glasses battery ${d.batteryLevel}%`);
  if (state.sync && now - state.syncedAt > 20000) out.push('○ No signal. Will retry.');
  if (state.queue?.length) out.push(`○ ${state.queue.length} waiting to send`);
  if (state.question) out.push('○ Question waiting: Menu');
  return out;
}

// Before pairing: a 4 digit join code from the server, with the phone page as the other route.
function unpairedView(state, flash) {
  const j = state.join || {};
  if (j.phase === 'waiting') {
    return screen([`Join code: ${j.code}`, '', `Send  /join ${j.code}`, 'in your team group.', ...flash], ['Or enter a code on your phone.'], 'Double tap: exit');
  }
  if (j.phase === 'claimed') {
    return screen([`Hi ${String(j.name || '').slice(0, 20)}.`, '', 'Waiting for the coordinator', 'to pick your area.', ...flash], [String(j.team || '').slice(0, COLS)], 'Double tap: exit');
  }
  const newCode = 'Tap: new code. Double tap: exit.';
  if (j.phase === 'expired') return screen(['CALLOUT', 'That join code expired.', 'Tap for a new one.', ...flash], ['Or enter a code on your phone.'], newCode);
  // Opened from the glasses menu, the phone may still be in a pocket: say so.
  const how = state.launch === 'glassesMenu'
    ? ['Take out your phone, open Callout', 'in the Even app and enter your code.']
    : ['Enter your code on the Callout page', 'on your phone.'];
  const note = j.phase === 'asking' ? ['Getting a join code...'] : j.phase === 'error' ? ['No join code. Try again in a minute.'] : [];
  return screen(['CALLOUT', 'Not paired yet.', ...how, ...flash], note, j.phase === 'asking' ? 'Double tap: exit' : newCode);
}

// The main screen. Main box: the countdown, or the newest reply while it shows. A short answer
// to the last gesture (state.flash) always gets room.
export function glanceView(state, now = Date.now()) {
  const flash = state.flash ? [state.flash] : [];
  if (!state.token && state.ended) return screen(['CALLOUT', '', 'Run finished.', 'Thank you.', ...flash], [], 'Tap: join a team. Double tap: exit.');
  if (!state.token) return unpairedView(state, flash);
  if (!state.sync) return screen(['CALLOUT', 'Connecting...', ...flash], warnings(state, now), 'Double tap: exit');
  const s = state.sync;
  const due = dueIn(state, now);
  const team = (Array.isArray(s.team) ? s.team : Object.values(s.team || {})).filter((t) => t.state !== 'out');
  const teamLine = team.length ? `Team ${team.filter((t) => t.state === 'ok').length}/${team.length} checked in` : '';
  const warn = warnings(state, now);
  const reply = state.reply;
  let main;
  if (reply) {
    // An overdue check-in stays on top of any reply.
    const head = due < 0 ? [countdown(due)] : [];
    const body = fit([`${String(reply.by || '').trim() || 'Coordinator'}: ${reply.text}`], BOXES[0].lines - head.length - flash.length);
    main = [...head, body, ...flash];
  } else {
    main = [countdown(due), '', String(s.area).slice(0, COLS * 2), ...(flash.length ? ['', ...flash] : [])];
  }
  const first = reply && due >= 0 ? countdown(due) : [teamLine, String(s.runName).slice(0, 18)].filter(Boolean).join(' ━ ');
  const status = [first.slice(0, COLS), warn.join('  ').slice(0, COLS)];
  const hint = reply?.tappable ? 'Tap: got it.  Hold: talk.' : 'Tap: check in. Hold: talk. Double: exit.';
  return screen(main, status, hint);
}

// Screens opened by an action keep the countdown (and any warning) in the dim box underneath,
// and a short answer to a gesture takes the hint line.
function action(state, now, main, hint) {
  const status = state.sync ? [countdown(dueIn(state, now)), warnings(state, now).join('  ').slice(0, COLS)] : [];
  return screen(main, status, (state.flashMode === state.mode && state.flash) || hint);
}

export function view(state, now = Date.now()) {
  const sc = state.screen;
  if (state.mode === 'glance' || !sc) return glanceView(state, now);
  return action(state, now, sc.main, sc.hint);
}

export const MENU = [
  { itemID: 1, itemName: 'Check in' },
  { itemID: 2, itemName: 'Clue by voice' },
  { itemID: 3, itemName: 'Quick clue' },
  { itemID: 8, itemName: 'Ask team for backup' },
  { itemID: 4, itemName: 'Repeat reply' },
  { itemID: 6, itemName: 'Photo: camera' },
  { itemID: 7, itemName: 'Photo: album' },
  { itemID: 5, itemName: 'Sign out' },
];

// Added to the menu while the coordinator's question is open.
export const ANSWER_ITEM = { itemID: 9, itemName: 'Answer question' };

// A question from the coordinator: the words on top, then a list of answers, ending in "Speak".
export const SPEAK = 'Speak';
export const questionText = (q, note) => fit([note || `${String(q.by || '').trim() || 'Coordinator'} asks:`, String(q.text || '')], 3);
export const questionRows = (q) => [...(q.answers || []).map((a) => String(a).slice(0, 16)).filter(Boolean).slice(0, 3), SPEAK];

// One tap each, no typing. The coordinator sets the run's list; these show until the first sync.
export const PRESET_CLUES = ['All done', 'No answer', 'Spoke to them', 'Access blocked'];
export function quickClues(list) {
  const rows = (Array.isArray(list) ? list : []).map((c) => String(c).trim().slice(0, 16)).filter(Boolean).slice(0, 4);
  return rows.length ? rows : PRESET_CLUES;
}

// Hold to talk. The cap stays well under the server's upload limit.
export const HOLD_MAX_S = 10;
export const HOLD_MIN_MS = 500;
export const holdScreen = (what = 'it') => ({ main: ['● Listening', '', `Say ${what} now.`], hint: 'Let go to send.' });
export const listenScreen = (secs, what = 'clue') => ({ main: ['● Listening', '', `Say your ${what}.`, `${secs}s left.`], hint: 'Tap when done. Swipe to cancel.' });
export const thinkScreen = () => ({ main: ['Got it.', '', 'Turning it into text...'], hint: '' });
export const confirmScreen = (text, secs, what = 'clue') => ({
  main: [`Your ${what}:`, fit([`"${String(text)}"`], 5)],
  hint: `Sending in ${secs}s. Tap: send. Swipe: cancel.`,
});

// The "say OK" window opens when a check-in is overdue. Short answers only, so chatter does not count.
// Anything that denies, or asks for help, never counts: "not OK" must not check anyone in.
const REFUSE = /\b(no|not|nope|never|cannot|help|hurt)\b|n['’]t\b|\b(isnt|arent|dont|cant|wont|aint)\b/i;
export function isOk(text) {
  const t = String(text || '').trim();
  if (!t || t.split(/\s+/).length > 5 || REFUSE.test(t)) return false;
  return /\b(ok|okay|here|checking in|check in|all good|fine|yes)\b/i.test(t.replace(/\./g, ''));
}
// What a spoken phrase asks for. The server names it; an older server sends only the words,
// which are then treated as a clue. A phrase that denies is never turned into a check-in.
export function voiceAction(res) {
  const text = String(res?.text || '').trim();
  const type = res?.intent?.type;
  if (!text || type === 'none') return { type: 'none' };
  if (type === 'cancel' || /^cancel[.!]?$/i.test(text)) return { type: 'cancel' };
  if (type === 'checkin') return REFUSE.test(text) ? { type: 'clue', text } : { type: 'checkin' };
  if (type === 'backup') return { type: 'backup' };
  if (type === 'quick_clue' && res.intent.clue) return { type: 'clue', text: String(res.intent.clue) };
  return { type: 'clue', text };
}
export const okScreen = (round) => ({ main: ['▲ Check-in due', '', 'Say "OK" or tap.', `Listening ${round} of 3.`], hint: 'Tap: check in. Swipe: skip.' });
export const stillScreen = (round) => ({ main: ['Still there?', '', 'Say "OK" or tap.', `Listening ${round} of 3.`], hint: 'Tap: yes. Swipe: skip.' });

export const backupScreen = () => ({ main: ['Ask the team for backup?', '', 'Your coordinator and team', 'get your last position.'], hint: 'Tap: send. Swipe: cancel.' });
