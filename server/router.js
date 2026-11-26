// Sends engine notices to the team's chat apps and keeps one pinned status
// board per run, edited in place. Also keeps live locations and the run's topic.
const ICON = { ok: '●', due: '◐', overdue: '▲', silent: '○', waiting: '○', out: '○' };
// Loud notices buzz phones. Everything else arrives quietly.
const LOUD = new Set(['missed_checkin', 'missed_checkin_team', 'went_silent', 'still', 'need_backup', 'nudge_overdue', 'answer']);
// Notices that carry a position or a person's details cannot be forwarded or saved from the chat.
// Notices that show a position. With "/end clear" they are deleted from the chat after the run.
const POS_KINDS = new Set(['clue', 'clue_photo', 'need_backup', 'missed_checkin', 'missed_checkin_team', 'went_silent', 'battery_low', 'glasses_off', 'still', 'back_in_touch']);
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
    const left = v.status === 'active' ? Math.round((v.lastCheckin + engine.gap(run) - engine.clock.now()) / 60000) : null;
    const when = v.status === 'signed_out' ? 'signed out' : left === null ? 'not joined' : left >= 0 ? `next check-in in ${left} min` : `${-left} min overdue`;
    return `${ICON[s.state]} ${s.name} (${s.area}) ${when}${s.battery != null ? `, glasses ${s.battery}%` : ''}`;
  });
  return `Run: ${run.name}${run.status === 'ended' ? ' (finished)' : ''}\n${rows.join('\n') || 'No volunteers yet.'}\nTeam notices only. Not an emergency service.`;
}

export function makeRouter({ engine, telegram = null, discord = null, log = console.error }) {
  const keyboardFor = (n) => {
    if (n.kind === 'nudge_overdue') return { inline_keyboard: [[{ text: 'Check in', callback_data: `ci|${n.volunteerId}` }]] };
    if (['clue', 'answer', 'missed_checkin', 'went_silent', 'need_backup', 'missed_checkin_team'].includes(n.kind)) {
      const rows = PRESETS.map((p, i) => [{ text: p, callback_data: `r|${n.volunteerId}|${i}` }]);
      if (['clue', 'answer', 'need_backup'].includes(n.kind)) rows.push([{ text: 'Ask a question', callback_data: `a|${n.volunteerId}` }]);
      else rows.push([{ text: 'Reached them, mark OK', callback_data: `ok|${n.volunteerId}` }]);
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
    // A reaction on the coordinator's own line: the volunteer saw it on the lens.
    if (n.kind === 'reply_confirmed' && n.src) {
      await telegram.setReaction(n.src.chat, n.src.id, '👀').catch(() => {});
      return;
    }
    // Private nudges go only to the volunteer's own chat, never to the group.
    if (n.audience === 'volunteer') {
      const { v } = engine.findVolunteer(n.volunteerId);
      if (!v.tgChatId) return;
      const sentPrivate = await telegram.send(v.tgChatId, n.text, { reply_markup: keyboardFor(n), disable_notification: !LOUD.has(n.kind), protect_content: true });
      return sentPrivate;
    }
    // An answer goes back to whoever asked, under their question. If that fails it takes the usual route.
    if (n.kind === 'answer' && n.src) {
      try {
        const sent = await telegram.send(n.src.chat, n.text, { reply_markup: keyboardFor(n), protect_content: true, reply_to_message_id: n.src.id, allow_sending_without_reply: true });
        if (run) (run.msgIndex ||= {})[`${n.src.chat}:${sent.message_id}`] = n.volunteerId;
        return sent;
      } catch (e) { log('answer not threaded:', e.message); }
    }
    let toCoordinator = n.audience === 'coordinator' && t.coordinatorChatId != null;
    let chat = toCoordinator ? t.coordinatorChatId : t.chatId;
    if (run && !toCoordinator) await ensureTopic(run, team);
    const post = async () => {
      const base = {
        reply_markup: keyboardFor(n),
        disable_notification: !LOUD.has(n.kind),
        protect_content: !OPEN.has(n.kind),
        ...threadOf(run, chat, team),
      };
      if ((n.kind === 'clue' || n.kind === 'need_backup') && n.pos) return telegram.sendVenue(chat, n.pos.lat, n.pos.lng, n.clueText || 'Backup requested', n.who, base); // a map pin
      if (n.kind === 'clue_photo') {
        const replyTo = run?.clueMsg?.[`${chat}:${n.clueId}`];
        return telegram.sendPhoto(chat, n.photo, n.text, { ...base, ...(replyTo ? { reply_to_message_id: replyTo } : {}) });
      }
      return telegram.send(chat, n.text, base);
    };
    let sent;
    try { sent = await post(); } catch (e) {
      if (!toCoordinator) throw e;
      // The coordinator never pressed Start with the bot. A missed check-in must still reach someone: post it in the group.
      t.coordinatorChatId = null; toCoordinator = false; chat = t.chatId;
      if (run) await ensureTopic(run, team);
      await telegram.send(chat, 'I cannot message the coordinator privately yet (they need to press Start in a private chat with me). Notices will stay in this group.', { disable_notification: true, ...threadOf(run, chat, team) }).catch(() => {});
      sent = await post();
    }
    if (run && n.volunteerId) (run.msgIndex ||= {})[`${chat}:${sent.message_id}`] = n.volunteerId;
    if (run && POS_KINDS.has(n.kind)) (run.posMsgs ||= []).push([chat, sent.message_id]);
    if (run && (n.kind === 'clue' || n.kind === 'need_backup')) (run.clueMsg ||= {})[`${chat}:${n.clueId}`] = sent.message_id;
    if (run && n.kind === 'debrief') await stopLive(run.id);
  }

  async function notify(n) {
    const team = engine.teams[n.teamId];
    if (!team) return;
    if (n.kind === 'run_closed') { // last step of a run: close its topic
      const run = engine.runs[n.runId];
      if (n.clear && run && team.telegram && telegram) { for (const [c, id] of run.posMsgs || []) await telegram.deleteMessage?.(c, id).catch(() => {}); run.posMsgs = []; }
      if (run?.topicId && team.telegram && telegram) await telegram.closeForumTopic(team.telegram.chatId, run.topicId).catch(() => {});
      return;
    }
    const from = engine.clock.now();
    const jobs = [];
    // A clue's time: from the server having it to Telegram accepting it.
    if (team.telegram && telegram) jobs.push(toTelegram(team, n).then((sent) => { if (n.kind === 'clue') engine.measure('clueToChat', engine.clock.now() - from); return sent; }));
    if (team.discord && discord && n.kind !== 'clue_photo' && n.kind !== 'run_closed' && n.audience !== 'volunteer' && !(n.kind === 'reply_confirmed' && n.src)) {
      const buttons = keyboardFor(n) ? PRESETS.map((p, i) => ({ label: p, id: `r|${n.volunteerId}|${i}` })) : [];
      if (buttons.length && discord.botToken && team.discord.channelId) jobs.push(discord.postWithButtons(team.discord.channelId, n.text, buttons));
      else if (team.discord.webhookUrl) jobs.push(discord.post(team.discord.webhookUrl, n.text));
    }
    const results = await Promise.allSettled(jobs);
    results.filter((r) => r.status === 'rejected').forEach((r) => log('send failed:', r.reason?.message));
    await updateBoard(n.runId);
  }

  // One pinned message per run, rewritten only when its text changes.
  // Updates for one run run one at a time. Without this, notices arriving together each saw "no board yet"
  // and posted their own copy (found in the first live Telegram test).
  const boardChain = new Map();
  function updateBoard(runId) {
    const next = (boardChain.get(runId) || Promise.resolve()).then(() => updateBoardNow(runId)).catch(() => {});
    boardChain.set(runId, next);
    return next;
  }
  async function updateBoardNow(runId) {
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
          (run.posMsgs ||= []).push([chat, label.message_id], [chat, m.message_id]);
        } else if (L.messageId && now - L.at >= MIN_GAP_MS && (L.lat === undefined || metres(L, v.pos) >= MIN_MOVE_M)) {
          const heading = L.lat === undefined ? undefined : bearing(L, v.pos); // a restored copy has no last point
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
