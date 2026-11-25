// Telegram bot commands and buttons. Works with privacy mode on: commands,
// replies to the bot's messages and button presses all reach the bot.
import { PRESETS, boardText } from './router.js';
import { parseSheetId } from './sheet.js';
import { trimLine } from './ai.js';

const HELP = [
  'Callout team check-in bot.',
  '/team <name>  set up this group as a team (run it in the group)',
  '/run <name>  start a run',
  '/add <name> | <area>  add a volunteer, get a pairing code for the glasses app',
  '/status  show who is due or overdue',
  '/interval <minutes>  set the check-in gap for this run (5 to 60)',
  '/reply <name> <text>  send a line to a volunteer\'s lens (or reply to their clue)',
  '/app  open the team dashboard (in a private chat with me)',
  '/sheet <link>  connect a Google Sheet (tab Volunteers: name, area)',
  '/import  add every volunteer listed in the sheet',
  '/end  finish the run and post the debrief (/end clear also deletes the position messages)',
  'Team notices only. This is not an emergency service.',
].join('\n');

// What the bot needs as a group admin, and why.
const RIGHTS = [
  ['can_pin_messages', 'pin the status board'],
  ['can_manage_topics', 'make one topic per run'],
];
const ADMIN_LINK = (bot) => `https://t.me/${bot}?startgroup=setup&admin=pin_messages+manage_topics`;

export const COMMANDS = {
  everyone: [{ command: 'start', description: 'How this works' }, { command: 'help', description: 'List the commands' }],
  coordinator: [
    { command: 'team', description: 'Make this group a team' }, { command: 'run', description: 'Start a run' },
    { command: 'add', description: 'Add a volunteer: name | area' }, { command: 'status', description: 'Who is due or overdue' }, { command: 'interval', description: 'Check-in gap in minutes (5 to 60)' },
    { command: 'reply', description: 'Send a line to a volunteer' }, { command: 'app', description: 'Open the team dashboard' }, { command: 'sheet', description: 'Connect a Google Sheet' }, { command: 'import', description: 'Add volunteers from the sheet' },
    { command: 'end', description: 'Finish the run' },
    { command: 'coordinator', description: 'Send private notices to me' }, { command: 'help', description: 'List the commands' },
  ],
};

// Commands that change a run. Everyone in the group can read the board; only the coordinator or a group admin can do these.
const COORD_ONLY = new Set(['coordinator', 'interval', 'run', 'add', 'reply', 'sheet', 'import', 'end']);

export function makeBot({ engine, telegram, router, botUsername = 'callout_bot', ai = null, sheet = null, discordDefault = null, appUrl = null }) {
  const say = (chatId, text, extra) => telegram.send(chatId, text, extra);

  // The person who set up the team, or a group admin.
  async function isCoord(team, userId, chatId) {
    if (userId == null) return false;
    if (userId === team.telegram?.coordinatorUserId) return true;
    try { const mem = await telegram.getChatMember?.(chatId, userId); return mem?.status === 'creator' || mem?.status === 'administrator'; } catch { return false; }
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
      return say(chatId, `Team set up. Start a run with /run <name>. For private notices, ${m.from.first_name || 'coordinator'} should press Start in a private chat with this bot, then send /coordinator in this group.`);
    }
    const team = engine.teamByChat(chatId);
    if (!team) return say(chatId, 'No team yet. Add me to your group and send /team <name>.');

    if (COORD_ONLY.has(name) && !(await isCoord(team, m.from?.id, chatId))) return say(chatId, 'Only the coordinator can do that.', { disable_notification: true });

    if (name === 'coordinator') {
      if (m.from.id !== team.telegram.coordinatorUserId) return say(chatId, 'Only the person who set up the team can do that.');
      // A bot cannot message someone who never pressed Start, so try it now and say what happened.
      try { await say(m.from.id, 'Private notices are on. Missed check-ins and quiet glasses will be sent here.', { disable_notification: true }); }
      catch { return say(chatId, `I cannot reach you privately yet. Press Start in a private chat with me (https://t.me/${botUsername}), then send /coordinator again. Until then notices stay in this group.`); }
      team.telegram.coordinatorChatId = m.from.id;
      return say(chatId, 'Done. Coordinator notices now go to your private chat. If that ever fails, they come back to this group.', { disable_notification: true });
    }
    if (name === 'run') {
      if (engine.activeRun(team.id)) return say(chatId, 'A run is already active. Send /end first.');
      const run = engine.startRun({ teamId: team.id, name: arg || 'Run' });
      return say(chatId, `Run "${run.name}" started. Add volunteers with /add <name> | <area>.

Everyone who joins agrees to share their position with this group while the run is active. Positions are deleted when the run ends.`);
    }
    const run = engine.activeRun(team.id);
    if (!run) return say(chatId, 'No active run. Start one with /run <name>.');

    if (name === 'add') {
      const [vn, area] = arg.split('|').map((s) => s.trim());
      if (!vn || !area) return say(chatId, 'Use: /add <name> | <area>');
      const { code } = engine.addVolunteer(run.id, { name: vn, area });
      return say(chatId, `${vn} (${area}): enter this code in the glasses app within 15 minutes, once only:\n${code}\n\nOptional: ${vn} can open https://t.me/${botUsername}?start=${code} to get private messages from me.`);
    }
    if (name === 'status') return say(chatId, boardText(engine, run.id));
    if (name === 'interval') {
      try { engine.setGap(run.id, arg); } catch { return say(chatId, 'Use: /interval <minutes>, between 5 and 60.'); }
      return;
    }
    if (name === 'reply') {
      const v = Object.values(run.volunteers).find((x) => arg.toLowerCase().startsWith(x.name.toLowerCase() + ' '));
      if (!v) return say(chatId, 'Use: /reply <volunteer name> <text>');
      await lensReply(run, v.id, arg.slice(v.name.length + 1), m.from.first_name || 'coordinator', { chat: chatId, id: m.message_id });
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
      return say(chatId, `Added ${fresh.length}${skipped ? `, ${skipped} already in the run` : ''}. Each person enters their code in the glasses app within 15 minutes, once only:\n${lines.join('\n')}`);
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

  // The volunteer opens t.me/<bot>?start=<code>. A bot cannot message anyone first, so this
  // is the moment we learn where to reach them. The code stays valid for the glasses app.
  async function linkVolunteer(m, code) {
    const p = engine.pairings[code];
    if (!p || p.used || engine.clock.now() > p.expiresAt) return say(m.chat.id, 'That link is not valid any more. Ask your coordinator for a new one.');
    const { v } = engine.findVolunteer(p.volunteerId);
    v.tgChatId = m.chat.id;
    return say(m.chat.id, `Linked: ${v.name}, ${v.area}. I will only message you here about your own check-ins. Not an emergency service.`, { disable_notification: true });
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
    const team = engine.teamByChat(m.chat.id);
    const run = team && engine.activeRun(team.id);
    const volId = run?.msgIndex?.[`${m.chat.id}:${ref.message_id}`];
    if (!volId) return;
    if (!(await isCoord(team, m.from?.id, m.chat.id))) return;
    await lensReply(run, volId, m.text, m.from.first_name || 'coordinator', { chat: m.chat.id, id: m.message_id });
    return ack(m, run.volunteers[volId]);
  }

  // Confirms a line reached the lens queue: a small OK reaction on the coordinator's own message,
  // or a short reply when reactions are not allowed in this chat.
  async function ack(m, v) {
    try { await telegram.setReaction(m.chat.id, m.message_id, '👌'); }
    catch { await say(m.chat.id, `Sent to ${v.name}'s lens.`, { reply_to_message_id: m.message_id, disable_notification: true }); }
  }

  // A coordinator reacts to a clue or notice: thumbs up reads "Seen" on the lens, OK hand reads "OK", heart "Thanks".
  const REACTIONS = { '👍': 'Seen', '👌': 'OK', '❤': 'Thanks', '❤️': 'Thanks' };
  async function onReaction(u) {
    const team = engine.teamByChat(u.chat.id);
    const run = team && engine.activeRun(team.id);
    const volId = run?.msgIndex?.[`${u.chat.id}:${u.message_id}`];
    if (!volId) return;
    if (!(await isCoord(team, u.user?.id, u.chat.id))) return;
    const added = (u.new_reaction || []).filter((x) => x.type === 'emoji' && REACTIONS[x.emoji]);
    const before = new Set((u.old_reaction || []).map((x) => x.emoji));
    const fresh = added.find((x) => !before.has(x.emoji));
    if (fresh) engine.reply(run.id, { volunteerId: volId, text: REACTIONS[fresh.emoji], by: u.user?.first_name || 'coordinator' });
  }

  async function onCallback(q) {
    const [kind, volId, idx] = String(q.data || '').split('|');
    try {
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
