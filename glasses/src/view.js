// Pure screen text for the lenses. No emoji: the lens drops them. Glyphs used: ● ○ ▲ ━
export function fmtClock(ms) {
  const neg = ms < 0;
  const s = Math.floor(Math.abs(ms) / 1000);
  const mm = String(Math.floor(s / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${neg ? '-' : ''}${mm}:${ss}`;
}

export function glanceText(state, now = Date.now()) {
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
  if (state.flash) lines.push('', state.flash);
  else if (s.replies?.length) lines.push('', `Reply: ${s.replies.at(-1).text}`);
  else lines.push('', 'Tap = check in. Double tap = exit.');
  return lines.join('\n').slice(0, 900);
}

export const MENU = [
  { itemID: 1, itemName: 'Check in' },
  { itemID: 2, itemName: 'Clue by voice' },
  { itemID: 3, itemName: 'Quick clue' },
  { itemID: 4, itemName: 'Repeat reply' },
  { itemID: 5, itemName: 'End run' },
  { itemID: 6, itemName: 'Photo: camera' },
  { itemID: 7, itemName: 'Photo: album' },
];

// One tap each, no typing. Short so they fit on the lens.
export const PRESET_CLUES = ['House empty', 'Person inside', 'Road blocked', 'Need boat'];

export const listenText = (secs) => ['● Listening', '', 'Say your clue.', `${secs}s left. Tap when done.`, 'Swipe to cancel.'].join('\n');
export const thinkText = () => ['Got it.', '', 'Turning it into text...'].join('\n');
export const confirmText = (text, secs) => ['Your clue:', '', `"${String(text).slice(0, 300)}"`, '', `Sending in ${secs}s.`, 'Tap = send now. Swipe or say "cancel".'].join('\n');

