// Telegram bot commands and buttons. Works with privacy mode on: commands,
// replies to the bot's messages and button presses all reach the bot.
import { PRESETS, boardText } from './router.js';
import { parseSheetId } from './sheet.js';
import { trimLine, suggestAnswers } from './ai.js';
import { makeLimiter } from './limit.js';

const HELP = [
  'Callout team check-in bot.',
  '/team <name>  set up this group as a team (run it in the group)',
  '/run <name>  start a run',
  '/add <name> | <area>  add a volunteer, get a pairing code for the glasses app',
  '/join <code>  join with the 4 digit code on your glasses (the coordinator picks the area)',
  '/status  show who is due or overdue',
  '/interval <minutes>  set the check-in gap for this run (5 to 60)',
  '/clues a, b, c, d  set the one-tap clues on the lens (/clues default to reset)',
  '/reply <name> <text>  send a line to a volunteer\'s lens (or reply to their clue)',
  '/ask <name> <question>  ask on a volunteer\'s lens, with one-tap answers',
  '/app  open the team dashboard (in a private chat with me)',
  '/sheet <link>  connect a Google Sheet (tab Volunteers: name, area)',
  '/import  add every volunteer listed in the sheet',
  '/end  finish the run and post the debrief (/end clear also deletes the position messages)',
  'Team notices only. This is not an emergency service.',
].join('\n');

// Said when a run starts on a server with an AI key.
export const AI_NOTICE = 'AI is on: clue words are sent to an AI service to write the summary, long coordinator replies to shorten them, and some coordinator questions to suggest answers. Volunteer names and positions are not added.';

// What the bot needs as a group admin, and why.
const RIGHTS = [
  ['can_pin_messages', 'pin the status board'],
  ['can_manage_topics', 'make one topic per run'],
];
const ADMIN_LINK = (bot) => `https://t.me/${bot}?startgroup=setup&admin=pin_messages+manage_topics`;

export const COMMANDS = {
  everyone: [{ command: 'start', description: 'How this works' }, { command: 'join', description: 'Join with the code on your glasses' }, { command: 'help', description: 'List the commands' }],
  coordinator: [
    { command: 'team', description: 'Make this group a team' }, { command: 'run', description: 'Start a run' },
    { command: 'add', description: 'Add a volunteer: name | area' }, { command: 'status', description: 'Who is due or overdue' }, { command: 'join', description: 'Join with the code on your glasses' }, { command: 'interval', description: 'Check-in gap in minutes (5 to 60)' }, { command: 'clues', description: 'Set the one-tap clues on the lens' },
    { command: 'reply', description: 'Send a line to a volunteer' }, { command: 'ask', description: 'Ask a volunteer a question' }, { command: 'app', description: 'Open the team dashboard' }, { command: 'sheet', description: 'Connect a Google Sheet' }, { command: 'import', description: 'Add volunteers from the sheet' },
    { command: 'end', description: 'Finish the run' },
    { command: 'coordinator', description: 'Send private notices to me' }, { command: 'help', description: 'List the commands' },
  ],
};

// Commands that change a run. Everyone in the group can read the board; only the coordinator or a group admin can do these.
const COORD_ONLY = new Set(['coordinator', 'ask', 'clues', 'interval', 'run', 'add', 'reply', 'sheet', 'import', 'end']);

export function makeBot({ engine, telegram, router, joins = null, botUsername = 'callout_bot', ai = null, sheet = null, discordDefault = null, appUrl = null }) {
  const say = (chatId, text, extra) => telegram.send(chatId, text, extra);

  // Wrong join codes are counted, so a code cannot be found by trying numbers.
  const clockNow = () => engine.clock.now();
  const wrongByUser = makeLimiter({ max: 5, windowMs: 10 * 60_000, now: clockNow });
  const wrongByChat = makeLimiter({ max: 15, windowMs: 10 * 60_000, now: clockNow });

  async function onJoin(m, team, run, code) {
    const chatId = m.chat.id;
    const quiet = { disable_notification: true };
    if (!joins) return say(chatId, 'Joining by code is not set up on this server.', quiet);
    if (!/^\d{4}$/.test(code)) return say(chatId, 'Use: /join with the 4 digit code shown on your glasses.', quiet);
    const who = m.from?.id;
    if (wrongByUser.full(who) || wrongByChat.full(chatId)) return say(chatId, 'Too many wrong codes. Try again in 10 minutes.', quiet);
    const name = (m.from?.first_name || 'Volunteer').slice(0, 40);
    const claim = joins.claim(code, { runId: run.id, userId: who, name });
    if (!claim) {
      wrongByUser.allow(who); wrongByChat.allow(chatId);
      return say(chatId, 'That code is not waiting. Check the number on the glasses, or get a new one.', quiet);
    }
    // People on the list who have not joined, or this same person on a new phone, then the run's areas.
    const people = Object.values(run.volunteers).filter((v) => v.status === 'waiting' || v.tgChatId === who)
      .sort((a, b) => (b.name.toLowerCase() === name.toLowerCase()) - (a.name.toLowerCase() === name.toLowerCase())).slice(0, 6);
    const areas = [...new Set(Object.values(run.volunteers).map((v) => v.area))].slice(0, 6);
    const rows = [
      ...people.map((v) => [{ text: `This is ${v.name}, ${v.area}`.slice(0, 60), callback_data: `j|${claim.id}|v|${v.id}` }]),
      ...areas.map((a, i) => [{ text: `New: ${name} in ${a}`.slice(0, 60), callback_data: `j|${claim.id}|a|${i}` }]),
    ];
    const prompt = await say(chatId, `${name} wants to join with their glasses. Coordinator: choose below, or reply to this message with an area name.`, rows.length ? { reply_markup: { inline_keyboard: rows } } : undefined);
    (run.joinPrompts ||= {})[`${chatId}:${prompt.message_id}`] = claim.id;
    (run.joinAreas ||= {})[claim.id] = areas;
  }

  async function admit(chatId, claimId, choice) {
    let joined;
    try { joined = joins.admit(claimId, choice); } catch { return say(chatId, 'That code has expired. Get a new one on the glasses.'); }
    return say(chatId, `${joined.name} is in (${joined.area}). For private check-in reminders, press Start in a private chat with me: https://t.me/${botUsername}`, { disable_notification: true });
  }

  // The person who set up the team, or a group admin.
  async function isCoord(team, userId, chatId) {
    if (userId == null) return false;
    if (userId === team.telegram?.coordinatorUserId) return true;
    try { const mem = await telegram.getChatMember?.(chatId, userId); return mem?.status === 'creator' || mem?.status === 'administrator'; } catch { return false; }
  }

  // Shows a line in the group to one person only. "sent" is false when Telegram refused it, and "hidden"
  // is true only when Telegram confirms nobody else sees it. Never used for safety notices.
  async function onlyTo(chatId, userId, text) {
    if (chatId >= 0 || userId == null || !telegram.sendOnlyTo) return { sent: false, hidden: false };
    try {
      const r = await telegram.sendOnlyTo(chatId, userId, text);
      return { sent: true, hidden: r?.ephemeral_message_id != null };
    } catch { return { sent: false, hidden: false }; }
  }
  async function refuse(chatId, userId) {
    const text = 'Only the coordinator can do that.';
    if (!(await onlyTo(chatId, userId, text)).sent) await say(chatId, text, { disable_notification: true });
  }

  // Pairing codes go to the coordinator's private chat. In the group they are shown only to the person who
  // asked, when Telegram allows it. A code the whole group can see is the last resort, and is said to be one.
  async function sendCodes(team, chatId, userId, text, short) {
    const priv = team.telegram.coordinatorChatId;
    if (priv != null && priv !== chatId) {
      try {
        await say(priv, text);
        return say(chatId, `${short} Sent to the coordinator's private chat.`);
      } catch { /* cannot reach them: fall back to this chat */ }
    }
    if (chatId === priv) return say(chatId, text);
    const how = 'To get codes in your private chat, press Start in a private chat with me, then send /coordinator here (the person who set up the team).';
    const one = await onlyTo(chatId, userId, `${text}\n\nOnly you can see this. Not there? Send the same command again.`);
    if (one.hidden) return say(chatId, `${short} Shown only to the person who asked. ${how}`, { disable_notification: true });
    if (one.sent) return say(chatId, `Anyone in this group can see the code above. ${how}`, { disable_notification: true });
    return say(chatId, `${text}

Anyone in this group can see this. ${how}`);
  }

  async function onMessage(m) {
    // Turning on Topics changes a group into a supergroup with a new chat id. Follow it.
    if (m.migrate_to_chat_id) {
      const t = engine.teamByChat(m.chat.id);
      if (t?.telegram?.chatId === m.chat.id) t.telegram.chatId = m.migrate_to_chat_id;
      if (t?.telegram?.coordinatorChatId === m.chat.id) t.telegram.coordinatorChatId = m.migrate_to_chat_id;
      return;
    }
    const chatId = m.chat.id;
    const text = (m.text || '').trim();
    const cmd = text.match(/^\/(\w+)(?:@\w+)?\s*([\s\S]*)$/);
    if (!cmd) return replyToClue(m);
    const [, name, arg] = cmd;
    const isGroup = m.chat.type === 'group' || m.chat.type === 'supergroup';

    if (name === 'app' || (name === 'start' && !isGroup && arg.trim() === 'app')) {
      if (!appUrl) return say(chatId, 'The dashboard needs a public address, which is not set on this server yet.');
      if (isGroup) return say(chatId, `Open the dashboard in a private chat with me: https://t.me/${botUsername}?start=app`);
      return say(chatId, 'Team dashboard. Only the person who set up the team can use it.', { reply_markup: { inline_keyboard: [[{ text: 'Open dashboard', web_app: { url: appUrl } }]] } });
    }
    if (name === 'start' && !isGroup && arg) return linkVolunteer(m, arg.trim().toUpperCase());
    if (name === 'start' && !isGroup) return say(chatId, `${HELP}

To set up a team, add me to your group with the right permissions:
${ADMIN_LINK(botUsername)}`);
    if (name === 'start' || name === 'help') return say(chatId, HELP);
    if (name === 'team') {
      if (!isGroup) return say(chatId, 'Run /team inside your team group, with this bot added.');
      if (engine.teamByChat(chatId)) return say(chatId, 'This group is already a team.');
      engine.addTeam({ name: arg || m.chat.title || 'Team', telegram: { chatId, coordinatorChatId: null, coordinatorUserId: m.from.id }, discord: discordDefault });
      engine.changed();
      return say(chatId, `Team set up. Start a run with /run <name>. For private notices, ${m.from.first_name || 'coordinator'} should press Start in a private chat with this bot, then send /coordinator in this group.`);
    }
    const team = engine.teamByChat(chatId);
    if (!team) return say(chatId, 'No team yet. Add me to your group and send /team <name>.');

    if (COORD_ONLY.has(name) && !(await isCoord(team, m.from?.id, chatId))) return refuse(chatId, m.from?.id);

    if (name === 'coordinator') {
      if (m.from.id !== team.telegram.coordinatorUserId) {
        const text = 'Only the person who set up the team can do that.';
        return (await onlyTo(chatId, m.from.id, text)).sent || say(chatId, text);
      }
      // A bot cannot message someone who never pressed Start, so try it now and say what happened.
      try { await say(m.from.id, 'Private notices are on. Missed check-ins and quiet glasses will be sent here.', { disable_notification: true }); }
      catch { return say(chatId, `I cannot reach you privately yet. Press Start in a private chat with me (https://t.me/${botUsername}), then send /coordinator again. Until then notices stay in this group.`); }
      team.telegram.coordinatorChatId = m.from.id;
      engine.changed();
      return say(chatId, 'Done. Coordinator notices now go to your private chat. If that ever fails, they come back to this group.', { disable_notification: true });
    }
    if (name === 'run') {
      if (engine.activeRun(team.id)) return say(chatId, 'A run is already active. Send /end first.');
      const run = engine.startRun({ teamId: team.id, name: arg || 'Run' });
      return say(chatId, `Run "${run.name}" started. Add volunteers with /add <name> | <area>.

Everyone who joins agrees to share their position with this group while the run is active. Positions are deleted when the run ends.${ai?.enabled ? `

${AI_NOTICE}` : ''}`);
    }
    let run = engine.activeRun(team.id);
    // /reply and /ask from a private chat can mean a volunteer in any of the teams that use this chat.
    if (!isGroup && (name === 'reply' || name === 'ask')) {
      const named = engine.teamsByChat(chatId).map((t) => engine.activeRun(t.id))
        .filter((r) => r && Object.values(r.volunteers).some((x) => arg.toLowerCase().startsWith(x.name.toLowerCase() + ' ')));
      if (named.length > 1) return say(chatId, 'That name is in more than one of your teams. Send it in that team group, or reply to their message.');
      if (named.length) {
        if (!(await isCoord(engine.teams[named[0].teamId], m.from?.id, chatId))) return say(chatId, 'Only the coordinator can do that.', { disable_notification: true });
        run = named[0];
      }
    }
    if (!run) return say(chatId, 'No active run. Start one with /run <name>.');
    if (name === 'join') {
      if (!isGroup) return say(chatId, 'Send /join with your code in your team group.');
      return onJoin(m, team, run, arg.trim());
    }

    if (name === 'add') {
      const [vn, area] = arg.split('|').map((s) => s.trim());
      if (!vn || !area) return say(chatId, 'Use: /add <name> | <area>');
      // Someone added but not joined yet gets a fresh code instead of a second place on the list.
      const waiting = Object.values(run.volunteers).find((x) => x.status === 'waiting' && x.name.toLowerCase() === vn.toLowerCase());
      const { code } = waiting ? engine.newCodeFor(run.id, waiting.id, area) : engine.addVolunteer(run.id, { name: vn, area });
      return sendCodes(team, chatId, m.from?.id, `${vn} (${area}): enter this code in the glasses app within 15 minutes, once only:\n${code}\n\nOptional: ${vn} can open https://t.me/${botUsername}?start=${code} to get private messages from me. Give it to ${vn} only.`, `Added ${vn} (${area}). The code is private.`);
    }
    if (name === 'status') return say(chatId, boardText(engine, run.id));
    if (name === 'interval') {
      try { engine.setGap(run.id, arg); } catch { return say(chatId, 'Use: /interval <minutes>, between 5 and 60.'); }
      return;
    }
    if (name === 'clues') {
      const show = (list) => `One-tap clues on the lens: ${list.join(', ')}`;
      if (!arg.trim()) return say(chatId, `${show(engine.quickClues(run))}\nChange them with /clues House empty, No answer (up to 4, up to 16 characters each).`);
      try { return say(chatId, show(engine.setQuickClues(run.id, /^default$/i.test(arg.trim()) ? [] : arg.split(',')))); }
      catch (e) { return say(chatId, `Use: /clues with ${e.message}, separated by commas.`); }
    }
    if (name === 'reply' || name === 'ask') {
      // The longest matching name wins, so "Ana Maria" is not read as "Ana".
      const v = Object.values(run.volunteers).filter((x) => arg.toLowerCase().startsWith(x.name.toLowerCase() + ' ')).sort((a, b) => b.name.length - a.name.length)[0];
      if (!v) return say(chatId, name === 'ask' ? 'Use: /ask <volunteer name> <question>' : 'Use: /reply <volunteer name> <text>');
      const line = arg.slice(v.name.length + 1).trim();
      const send = name === 'ask' ? lensAsk : lensReply;
      await send(run, v.id, line, m.from.first_name || 'coordinator', { chat: chatId, id: m.message_id });
      return ack(m, v);
    }
    if (name === 'sheet') {
      if (!sheet) return say(chatId, 'Google Sheet is not set up on this server.');
      const id = parseSheetId(arg);
      if (!id) return say(chatId, `Use: /sheet <link to your sheet>. Share the sheet with ${sheet.email || 'the Callout account'} first (Editor).`);
      team.sheetId = id;
      return say(chatId, 'Sheet connected. Put names in tab Volunteers (column A name, column B area), then send /import. The debrief is written to tabs Debrief and Clues when the run ends.');
    }
    if (name === 'import') {
      if (!sheet || !team.sheetId) return say(chatId, 'Connect a sheet first with /sheet <link>.');
      let list;
      try { list = await sheet.readVolunteers(team.sheetId); } catch (e) { return say(chatId, `Could not read the sheet: ${e.message}`); }
      if (!list.length) return say(chatId, 'No volunteers found. Use tab Volunteers, name in column A, area in column B.');
      // Someone already in this run is skipped, so sending /import twice does not list them twice.
      const have = new Set(Object.values(run.volunteers).map((x) => x.name.toLowerCase()));
      const fresh = list.filter(({ name: n }) => !have.has(n.toLowerCase()));
      const skipped = list.length - fresh.length;
      if (!fresh.length) return say(chatId, 'Everyone in the sheet is already in this run.');
      const lines = fresh.map(({ name: n, area }) => `${n} (${area}): ${engine.addVolunteer(run.id, { name: n, area }).code}`);
      const added = `Added ${fresh.length}${skipped ? `, ${skipped} already in the run` : ''}.`;
      return sendCodes(team, chatId, m.from?.id, `${added} Each person enters their code in the glasses app within 15 minutes, once only:\n${lines.join('\n')}`, added);
    }
    if (name === 'end') {
      const debrief = engine.endRun(run.id);
      await router.updateBoard(run.id);
      const summary = ai ? await ai.debrief(debrief) : '';
      if (summary) engine.announce(run.id, 'team', 'summary', `Summary: ${summary}`);
      if (sheet && team.sheetId) {
        try { const r = await sheet.writeDebrief(team.sheetId, debrief, summary); await say(chatId, `Debrief written to your sheet (${r.people} people, ${r.clues} clues).`, { disable_notification: true }); }
        catch (e) { await say(chatId, `Could not write to the sheet: ${e.message}`); }
      }
      engine.announce(run.id, 'team', 'run_closed', '', { clear: arg.trim().toLowerCase() === 'clear' });
      return;
    }
    return say(chatId, HELP);
  }

  // A coordinator line for the lens. Long ones get a one-line version on the lens; the full text stays under Repeat reply.
  async function lensReply(run, volunteerId, text, by, src) {
    // With no AI key the first sentence is cut to fit. The full text stays under Repeat reply.
    const short = text.length <= 60 ? undefined : ai?.enabled ? await ai.oneLine(text) : trimLine(text);
    return engine.reply(run.id, { volunteerId, text, by, short, src });
  }

  // A question for the lens, with one-tap answers. The answer comes back as a reply to the asking message.
  async function lensAsk(run, volunteerId, text, by, src) {
    const answers = ai?.answers ? await ai.answers(text) : suggestAnswers(text);
    return engine.ask(run.id, { volunteerId, text, by, answers, src });
  }

  // The volunteer opens t.me/<bot>?start=<code>. A bot cannot message anyone first, so this
  // is the moment we learn where to reach them. The code stays valid for the glasses app.
  async function linkVolunteer(m, code) {
    const p = engine.findPairing(code);
    if (!p || p.used || engine.clock.now() > p.expiresAt) return say(m.chat.id, 'That link is not valid any more. Ask your coordinator for a new one.');
    const { run, v } = engine.findVolunteer(p.volunteerId);
    // The first private chat to use the link keeps it. Nobody else can take it over.
    if (v.tgChatId && v.tgChatId !== m.chat.id) return say(m.chat.id, `${v.name} already has a private chat linked, so this link cannot be used. Ask your coordinator.`);
    const first = !v.tgChatId;
    v.tgChatId = m.chat.id;
    engine.changed();
    await say(m.chat.id, `Linked: ${v.name}, ${v.area}. I will only message you here about your own check-ins. Not an emergency service.`, { disable_notification: true });
    const group = engine.teams[run.teamId]?.telegram?.chatId;
    if (first && group != null) await say(group, `${v.name}'s private chat is linked, opened by ${m.from?.first_name || 'someone'}.`, { disable_notification: true });
  }

  // Runs when the bot is added to a group or its rights change.
  async function onMyChatMember(u) {
    const chat = u.chat;
    if (chat.type !== 'group' && chat.type !== 'supergroup') return;
    const n = u.new_chat_member;
    if (!n || n.status === 'left' || n.status === 'kicked') return;
    if (n.status !== 'administrator') {
      return say(chat.id, `I am not an admin yet, so I cannot pin the status board or make topics. Use this link to add me with the right permissions: ${ADMIN_LINK(botUsername)}`);
    }
    const missing = RIGHTS.filter(([k]) => !n[k]).map(([, why]) => why);
    if (missing.length) return say(chat.id, `I am an admin but cannot: ${missing.join(', ')}. Please turn those permissions on.`);
    return say(chat.id, 'All set. Send /team <name> to make this group a team.', { disable_notification: true });
  }

  // Two command lists: a short one for everyone, the full one for group admins.
  async function register() {
    await telegram.setMyCommands(COMMANDS.everyone);
    await telegram.setMyCommands(COMMANDS.coordinator, { type: 'all_chat_administrators' });
  }

  // A plain reply to one of the bot's clue or notice messages goes to that volunteer.
  async function replyToClue(m) {
    const ref = m.reply_to_message;
    if (!ref || !m.text) return;
    const joining = engine.findMessage(m.chat.id, ref.message_id, 'joinPrompts');
    if (joining) {
      if (!(await isCoord(joining.team, m.from?.id, m.chat.id))) return;
      return admit(m.chat.id, joining.volunteerId, { area: m.text.trim().slice(0, 60) });
    }
    const asked = engine.findMessage(m.chat.id, ref.message_id, 'askPrompts');
    const found = asked || engine.findMessage(m.chat.id, ref.message_id);
    if (!found) return;
    const { team, run, volunteerId: volId } = found;
    if (!(await isCoord(team, m.from?.id, m.chat.id))) return;
    await (asked ? lensAsk : lensReply)(run, volId, m.text, m.from.first_name || 'coordinator', { chat: m.chat.id, id: m.message_id });
    return ack(m, run.volunteers[volId]);
  }

  // Confirms a line reached the lens queue: a small OK reaction on the coordinator's own message,
  // or a short reply when reactions are not allowed in this chat.
  async function ack(m, v) {
    try { await telegram.setReaction(m.chat.id, m.message_id, '👌'); }
    catch {
      const text = `Sent to ${v.name}'s lens.`;
      if (!(await onlyTo(m.chat.id, m.from?.id, text)).sent) await say(m.chat.id, text, { reply_to_message_id: m.message_id, disable_notification: true });
    }
  }

  // A coordinator reacts to a clue or notice: thumbs up reads "Seen" on the lens, OK hand reads "OK", heart "Thanks".
  const REACTIONS = { '👍': 'Seen', '👌': 'OK', '❤': 'Thanks', '❤️': 'Thanks' };
  async function onReaction(u) {
    const found = engine.findMessage(u.chat.id, u.message_id);
    if (!found) return;
    const { team, run, volunteerId: volId } = found;
    if (!(await isCoord(team, u.user?.id, u.chat.id))) return;
    const added = (u.new_reaction || []).filter((x) => x.type === 'emoji' && REACTIONS[x.emoji]);
    const before = new Set((u.old_reaction || []).map((x) => x.emoji));
    const fresh = added.find((x) => !before.has(x.emoji));
    if (fresh) engine.reply(run.id, { volunteerId: volId, text: REACTIONS[fresh.emoji], by: u.user?.first_name || 'coordinator' });
  }

  async function onCallback(q) {
    const [kind, volId, idx, extra] = String(q.data || '').split('|');
    try {
      if (kind === 'j') {
        const claim = joins?.pending(volId);
        const run = claim && engine.runs[claim.runId];
        const team = run && engine.teams[run.teamId];
        const chat = q.message?.chat?.id;
        if (!team || chat !== team.telegram?.chatId) return telegram.answerCallback(q.id, 'Not available');
        if (!(await isCoord(team, q.from?.id, chat))) return telegram.answerCallback(q.id, 'Only the coordinator can do that');
        const choice = idx === 'v' ? { volunteerId: extra } : { area: run.joinAreas?.[volId]?.[Number(extra)] };
        if (!choice.volunteerId && !choice.area) return telegram.answerCallback(q.id, 'Not available');
        await telegram.answerCallback(q.id, 'Adding them');
        return admit(chat, volId, choice);
      }
      const { run, v } = engine.findVolunteer(volId);
      const team = engine.teams[run.teamId];
      const chat = q.message?.chat?.id;
      if (run.status !== 'active') return telegram.answerCallback(q.id, 'Not available');
      // The volunteer's own Check in button: only works from their own private chat.
      if (kind === 'ci') {
        if (!v.tgChatId || chat !== v.tgChatId) return telegram.answerCallback(q.id, 'Not available');
        engine.checkInFor(v.id);
        return telegram.answerCallback(q.id, 'Checked in. Thank you.');
      }
      const allowed = team.telegram && (chat === team.telegram.chatId || chat === team.telegram.coordinatorChatId);
      if (!allowed) return telegram.answerCallback(q.id, 'Not available');
      if (!(await isCoord(team, q.from?.id, chat))) return telegram.answerCallback(q.id, 'Only the coordinator can do that');
      if (kind === 'r' && PRESETS[Number(idx)]) {
        engine.reply(run.id, { volunteerId: v.id, text: PRESETS[Number(idx)], by: q.from.first_name || 'coordinator' });
        return telegram.answerCallback(q.id, `Sent to ${v.name}`);
      }
      if (kind === 'a') {
        // Telegram opens a reply box for the person who pressed, and the reply becomes the question.
        const who = q.from.first_name || 'Coordinator';
        const prompt = await say(chat, `${who}, reply to this message with your question for ${v.name}'s lens.`, {
          reply_markup: { force_reply: true, selective: true, input_field_placeholder: 'Your question' },
          entities: [{ type: 'text_mention', offset: 0, length: who.length, user: { id: q.from.id } }], disable_notification: true,
        });
        (run.askPrompts ||= {})[`${chat}:${prompt.message_id}`] = v.id;
        return telegram.answerCallback(q.id, 'Reply with your question');
      }
      if (kind === 'ok') {
        engine.markOk(run.id, v.id, q.from.first_name || 'coordinator');
        // The notice itself says it was handled, and loses its buttons.
        if (q.message?.message_id) telegram.edit(chat, q.message.message_id, `${q.message.text || 'Notice'}
Marked OK by ${q.from.first_name || 'coordinator'}.`).catch(() => {});
        return telegram.answerCallback(q.id, `${v.name} marked OK`);
      }
    } catch { /* fall through */ }
    return telegram.answerCallback(q.id, 'Not available');
  }

  async function handle(update) {
    if (update.message) return onMessage(update.message);
    if (update.callback_query) return onCallback(update.callback_query);
    if (update.my_chat_member) return onMyChatMember(update.my_chat_member);
    if (update.message_reaction) return onReaction(update.message_reaction);
  }

  return { handle, register };
}
