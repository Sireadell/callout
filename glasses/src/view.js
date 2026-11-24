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
  { itemID: 2, itemName: 'Repeat reply' },
  { itemID: 3, itemName: 'End run' },
];
