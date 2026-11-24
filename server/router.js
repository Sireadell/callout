// Sends engine notices to the team's chat apps and keeps one pinned status
// board per run, edited in place.
const ICON = { ok: '●', due: '◐', overdue: '▲', silent: '○', waiting: '○' };
// Loud notices buzz phones. Everything else arrives quietly.
const LOUD = new Set(['missed_checkin', 'missed_checkin_team', 'went_silent']);
// Notices that carry a position or a person's details cannot be forwarded or saved from the chat.
const OPEN = new Set(['run_started', 'joined', 'debrief']);
export const PRESETS = ['Stay where you are', 'Move to your next area', 'Return to base', 'Call me'];

export function boardText(engine, runId) {
  const run = engine.runs[runId];
  const rows = engine.teamStatus(runId).map((s) => {
    const v = run.volunteers[s.id];
    const left = v.status === 'active' ? Math.round((v.lastCheckin + engine.cfg.checkinMs - engine.clock.now()) / 60000) : null;
    const when = left === null ? 'not joined' : left >= 0 ? `next check-in in ${left} min` : `${-left} min overdue`;
    return `${ICON[s.state]} ${s.name} (${s.area}) ${when}${s.battery != null ? `, glasses ${s.battery}%` : ''}`;
  });
  return `Run: ${run.name}${run.status === 'ended' ? ' (finished)' : ''}\n${rows.join('\n') || 'No volunteers yet.'}\nTeam notices only. Not an emergency service.`;
}

export function makeRouter({ engine, telegram = null, discord = null, log = console.error }) {
  const keyboardFor = (n) => {
    if (n.kind === 'clue' || n.kind === 'missed_checkin' || n.kind === 'went_silent') {
      const rows = PRESETS.map((p, i) => [{ text: p, callback_data: `r|${n.volunteerId}|${i}` }]);
      return { inline_keyboard: rows };
    }
    return undefined;
  };

  async function toTelegram(team, n) {
    const t = team.telegram;
    const chat = n.audience === 'coordinator' ? (t.coordinatorChatId ?? t.chatId) : t.chatId;
    const sent = await telegram.send(chat, n.text, {
      reply_markup: keyboardFor(n),
      disable_notification: !LOUD.has(n.kind),
      protect_content: !OPEN.has(n.kind),
    });
    const run = engine.runs[n.runId];
    if (run && n.volunteerId) (run.msgIndex ||= {})[`${chat}:${sent.message_id}`] = n.volunteerId;
  }

  async function notify(n) {
    const team = engine.teams[n.teamId];
    if (!team) return;
    const jobs = [];
    if (team.telegram && telegram) jobs.push(toTelegram(team, n));
    if (team.discord && discord) jobs.push(discord.post(team.discord.webhookUrl, n.text));
    const results = await Promise.allSettled(jobs);
    results.filter((r) => r.status === 'rejected').forEach((r) => log('send failed:', r.reason?.message));
    await updateBoard(n.runId);
  }

  // One pinned message per run, rewritten only when its text changes.
  async function updateBoard(runId) {
    const run = engine.runs[runId];
    const team = run && engine.teams[run.teamId];
    if (!run || !team?.telegram || !telegram) return;
    const text = boardText(engine, runId);
    const b = (run.board ||= {});
    if (b.text === text) return;
    try {
      if (!b.messageId) {
        const m = await telegram.send(team.telegram.chatId, text);
        b.messageId = m.message_id;
        await telegram.pin(team.telegram.chatId, m.message_id).catch(() => {});
      } else {
        await telegram.edit(team.telegram.chatId, b.messageId, text);
      }
      b.text = text;
    } catch (e) { log('board update failed:', e.message); }
  }

  return { notify: (n) => notify(n).catch((e) => log('notify failed:', e.message)), updateBoard };
}
