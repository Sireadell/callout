// Pure screen text for the lenses. No emoji: the lens drops them. Glyphs used: ● ○ ▲ ━
export function fmtClock(ms) {
  const neg = ms < 0;
  const s = Math.floor(Math.abs(ms) / 1000);
  const mm = String(Math.floor(s / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${neg ? '-' : ''}${mm}:${ss}`;
}

export function glanceText(state, now = Date.now()) {
  if (!state.token && state.ended) return ['CALLOUT', '', 'Run finished.', 'Thank you.'].join('\n');
  if (!state.token) {
    return ['CALLOUT', '', 'Not paired yet.', 'Open the Callout page on your', 'phone and enter your code.'].join('\n');
  }
  if (!state.sync) return ['CALLOUT', '', 'Connecting...'].join('\n');
  const s = state.sync;
  const due = s.dueInMs - (now - state.syncedAt);
  const overdue = due < 0;
  const lines = [
    `${s.runName}`,
    `${s.area}`,
    '',
    overdue ? `▲ OVERDUE ${fmtClock(due)}` : `Next check-in ${fmtClock(due)}`,
    '',
  ];
  const team = Array.isArray(s.team) ? s.team : Object.values(s.team || {});
  if (team.length) {
    const ok = team.filter((t) => t.state === 'ok' || t.status === 'ok').length;
    lines.push(`Team ${ok}/${team.length} checked in`);
  }
  const d = state.device || {};
  if (typeof d.batteryLevel === 'number' && d.batteryLevel <= 15 && !d.isCharging) lines.push('', `▲ Glasses battery ${d.batteryLevel}%`);
  else if (now - state.syncedAt > 20000) lines.push('', '○ No signal. Will retry.');
  if (state.flash) lines.push('', state.flash);
  else if (s.replies?.length) lines.push('', `Reply: ${s.replies.at(-1).text}`);
  else lines.push('', 'Tap = check in. Double tap = exit.');
  return lines.join('\n').slice(0, 900);
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

// One tap each, no typing. Short so they fit on the lens.
export const PRESET_CLUES = ['House empty', 'Person inside', 'Road blocked', 'Need boat'];

export const listenText = (secs) => ['● Listening', '', 'Say your clue.', `${secs}s left. Tap when done.`, 'Swipe to cancel.'].join('\n');
export const thinkText = () => ['Got it.', '', 'Turning it into text...'].join('\n');
export const confirmText = (text, secs) => ['Your clue:', '', `"${String(text).slice(0, 300)}"`, '', `Sending in ${secs}s.`, 'Tap = send now. Swipe or say "cancel".'].join('\n');


// The "say OK" window opens when a check-in is overdue. Short answers only, so chatter does not count.
export function isOk(text) {
  const t = String(text || '').trim();
  if (!t || t.split(/\s+/).length > 5) return false;
  return /\b(ok|okay|here|checking in|check in|all good|fine|yes)\b/i.test(t.replace(/\./g, ''));
}
export const okText = (round) => ['▲ Check-in due', '', 'Say "OK" or tap.', `Listening ${round} of 3. Swipe to skip.`].join('\n');
export const stillText = (round) => ['Still there?', '', 'Say "OK" or tap.', `Listening ${round} of 3. Swipe to skip.`].join('\n');

export const backupText = () => ['Ask the team for backup?', '', 'Your coordinator and team', 'get your last position.', '', 'Tap = send. Swipe = cancel.'].join('\n');
export const replyText = (r) => `${r.by || 'Coordinator'}: ${r.text}\nTap = got it`;
