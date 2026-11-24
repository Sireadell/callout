// Sends engine notices to the team's chat apps and keeps one pinned status
// board per run, edited in place. Also keeps live locations and the run's topic.
const ICON = { ok: '●', due: '◐', overdue: '▲', silent: '○', waiting: '○' };
// Loud notices buzz phones. Everything else arrives quietly.
const LOUD = new Set(['missed_checkin', 'missed_checkin_team', 'went_silent', 'still']);
// Notices that carry a position or a person's details cannot be forwarded or saved from the chat.
const OPEN = new Set(['run_started', 'joined', 'debrief', 'summary']);
export const PRESETS = ['Stay where you are', 'Move to your next area', 'Return to base', 'Call me'];

const MIN_MOVE_M = 25;      // a live location moves only after this many metres...
const MIN_GAP_MS = 60_000;  // ...and at most once a minute, to stay under Telegram's group limit

export function metres(a, b) {
  const R = 6371000, rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
// Direction of travel as 1 to 360 degrees (Telegram's heading range).
export function bearing(a, b) {
  const rad = (d) => (d * Math.PI) / 180;
  const y = Math.sin(rad(b.lng - a.lng)) * Math.cos(rad(b.lat));
  const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lng - a.lng));
  const deg = ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
  return Math.round(deg) || 360;
}

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

  // One forum topic per run, if the group is a forum. If not, everything stays in the main chat.
  async function ensureTopic(run, team) {
    if (!telegram || run.topicTried) return;
    run.topicTried = true;
    try { run.topicId = (await telegram.createForumTopic(team.telegram.chatId, run.name)).message_thread_id; } catch { /* not a forum group */ }
  }
  const threadOf = (run, chat, team) => (run?.topicId && chat === team.telegram.chatId ? { message_thread_id: run.topicId } : {});

  async function toTelegram(team, n) {
    const t = team.telegram;
    const run = engine.runs[n.runId];
    const toCoordinator = n.audience === 'coordinator' && t.coordinatorChatId != null;
    const chat = toCoordinator ? t.coordinatorChatId : t.chatId;
    if (run && !toCoordinator) await ensureTopic(run, team);
    const base = {
      reply_markup: keyboardFor(n),
      disable_notification: !LOUD.has(n.kind),
      protect_content: !OPEN.has(n.kind),
      ...threadOf(run, chat, team),
    };
    let sent;
    if (n.kind === 'clue' && n.pos) {
      sent = await telegram.sendVenue(chat, n.pos.lat, n.pos.lng, n.clueText, n.who, base); // a clue is a map pin
    } else if (n.kind === 'clue_photo') {
      const replyTo = run?.clueMsg?.[`${chat}:${n.clueId}`];
      sent = await telegram.sendPhoto(chat, n.photo, n.text, { ...base, ...(replyTo ? { reply_to_message_id: replyTo } : {}) });
    } else {
      sent = await telegram.send(chat, n.text, base);
    }
    if (run && n.volunteerId) (run.msgIndex ||= {})[`${chat}:${sent.message_id}`] = n.volunteerId;
    if (run && n.kind === 'clue') (run.clueMsg ||= {})[`${chat}:${n.clueId}`] = sent.message_id;
    if (run && n.kind === 'debrief') await stopLive(run.id);
  }

  async function notify(n) {
    const team = engine.teams[n.teamId];
    if (!team) return;
    if (n.kind === 'run_closed') { // last step of a run: close its topic
      const run = engine.runs[n.runId];
      if (run?.topicId && team.telegram && telegram) await telegram.closeForumTopic(team.telegram.chatId, run.topicId).catch(() => {});
      return;
    }
    const jobs = [];
    if (team.telegram && telegram) jobs.push(toTelegram(team, n));
    if (team.discord && discord && n.kind !== 'clue_photo' && n.kind !== 'run_closed') {
      const buttons = keyboardFor(n) ? PRESETS.map((p, i) => ({ label: p, id: `r|${n.volunteerId}|${i}` })) : [];
      if (buttons.length && discord.botToken && team.discord.channelId) jobs.push(discord.postWithButtons(team.discord.channelId, n.text, buttons));
      else if (team.discord.webhookUrl) jobs.push(discord.post(team.discord.webhookUrl, n.text));
    }
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
      await ensureTopic(run, team);
      if (!b.messageId) {
        const m = await telegram.send(team.telegram.chatId, text, threadOf(run, team.telegram.chatId, team));
        b.messageId = m.message_id;
        await telegram.pin(team.telegram.chatId, m.message_id).catch(() => {});
      } else {
        await telegram.edit(team.telegram.chatId, b.messageId, text);
      }
      b.text = text;
    } catch (e) { log('board update failed:', e.message); }
  }

  // One live location per volunteer, started the first time we know where they are,
  // then moved only when they have gone 25 m and a minute has passed.
  async function updateLocations(runId) {
    const run = engine.runs[runId];
    const team = run && engine.teams[run.teamId];
    if (!run || run.status !== 'active' || !team?.telegram || !telegram) return;
    const chat = team.telegram.chatId;
    const live = (run.live ||= {});
    const now = engine.clock.now();
    for (const v of Object.values(run.volunteers)) {
      if (!v.pos) continue;
      const L = live[v.id];
      try {
        if (!L) {
          live[v.id] = { starting: true }; // stops a second start while the first is still sending
          await ensureTopic(run, team);
          const th = threadOf(run, chat, team);
          const label = await telegram.send(chat, `Live location: ${v.name} (${v.area})`, { disable_notification: true, protect_content: true, ...th });
          const m = await telegram.sendLiveLocation(chat, v.pos.lat, v.pos.lng, { disable_notification: true, protect_content: true, reply_to_message_id: label.message_id, ...th });
          live[v.id] = { messageId: m.message_id, lat: v.pos.lat, lng: v.pos.lng, at: now };
          (run.msgIndex ||= {})[`${chat}:${label.message_id}`] = v.id;
        } else if (L.messageId && now - L.at >= MIN_GAP_MS && metres(L, v.pos) >= MIN_MOVE_M) {
          const heading = bearing(L, v.pos);
          await telegram.editLiveLocation(chat, L.messageId, v.pos.lat, v.pos.lng, heading);
          Object.assign(L, { lat: v.pos.lat, lng: v.pos.lng, at: now });
        }
      } catch (e) { if (!live[v.id]?.messageId) delete live[v.id]; log('live location failed:', e.message); }
    }
  }

  async function stopLive(runId) {
    const run = engine.runs[runId];
    const team = run && engine.teams[run.teamId];
    if (!run?.live || !team?.telegram || !telegram) return;
    for (const L of Object.values(run.live)) if (L.messageId) await telegram.stopLiveLocation(team.telegram.chatId, L.messageId).catch(() => {});
    run.live = {};
  }

  return { notify: (n) => notify(n).catch((e) => log('notify failed:', e.message)), updateBoard, updateLocations, stopLive };
}
