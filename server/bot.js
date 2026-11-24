// Telegram bot commands and buttons. Works with privacy mode on: commands,
// replies to the bot's messages and button presses all reach the bot.
import { PRESETS, boardText } from './router.js';

const HELP = [
  'Callout team check-in bot.',
  '/team <name>  set up this group as a team (run it in the group)',
  '/run <name>  start a run',
  '/add <name> | <area>  add a volunteer, get a pairing code for the glasses app',
  '/status  show who is due or overdue',
  '/reply <name> <text>  send a line to a volunteer\'s lens (or reply to their clue)',
  '/end  finish the run and post the debrief',
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
    { command: 'add', description: 'Add a volunteer: name | area' }, { command: 'status', description: 'Who is due or overdue' },
    { command: 'reply', description: 'Send a line to a volunteer' }, { command: 'end', description: 'Finish the run' },
    { command: 'coordinator', description: 'Send private notices to me' }, { command: 'help', description: 'List the commands' },
  ],
};

export function makeBot({ engine, telegram, router, botUsername = 'callout_bot', onDebrief = async () => {} }) {
  const say = (chatId, text, extra) => telegram.send(chatId, text, extra);

  async function onMessage(m) {
    const chatId = m.chat.id;
    const text = (m.text || '').trim();
    const cmd = text.match(/^\/(\w+)(?:@\w+)?\s*([\s\S]*)$/);
    if (!cmd) return replyToClue(m);
    const [, name, arg] = cmd;
    const isGroup = m.chat.type === 'group' || m.chat.type === 'supergroup';

    if (name === 'start' && !isGroup && arg) return linkVolunteer(m, arg.trim().toUpperCase());
    if (name === 'start' && !isGroup) return say(chatId, `${HELP}

To set up a team, add me to your group with the right permissions:
${ADMIN_LINK(botUsername)}`);
    if (name === 'start' || name === 'help') return say(chatId, HELP);
    if (name === 'team') {
      if (!isGroup) return say(chatId, 'Run /team inside your team group, with this bot added.');
      if (engine.teamByChat(chatId)) return say(chatId, 'This group is already a team.');
      engine.addTeam({ name: arg || m.chat.title || 'Team', telegram: { chatId, coordinatorChatId: null, coordinatorUserId: m.from.id } });
      return say(chatId, `Team set up. Start a run with /run <name>. For private notices, ${m.from.first_name || 'coordinator'} should press Start in a private chat with this bot, then send /coordinator in this group.`);
    }
    const team = engine.teamByChat(chatId);
    if (!team) return say(chatId, 'No team yet. Add me to your group and send /team <name>.');

    if (name === 'coordinator') {
      if (m.from.id !== team.telegram.coordinatorUserId) return say(chatId, 'Only the person who set up the team can do that.');
      team.telegram.coordinatorChatId = m.from.id;
      return say(chatId, 'Coordinator notices will now go to your private chat. If you have not pressed Start with me there, they stay in this group.');
    }
    if (name === 'run') {
      if (engine.activeRun(team.id)) return say(chatId, 'A run is already active. Send /end first.');
      const run = engine.startRun({ teamId: team.id, name: arg || 'Run' });
      return say(chatId, `Run "${run.name}" started. Add volunteers with /add <name> | <area>.`);
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
    if (name === 'reply') {
      const v = Object.values(run.volunteers).find((x) => arg.toLowerCase().startsWith(x.name.toLowerCase() + ' '));
      if (!v) return say(chatId, 'Use: /reply <volunteer name> <text>');
      engine.reply(run.id, { volunteerId: v.id, text: arg.slice(v.name.length + 1), by: m.from.first_name || 'coordinator' });
      return say(chatId, `Sent to ${v.name}'s lens.`);
    }
    if (name === 'end') {
      const debrief = engine.endRun(run.id);
      await router.updateBoard(run.id);
      await onDebrief(debrief, team);
      return;
    }
    return say(chatId, HELP);
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
    engine.reply(run.id, { volunteerId: volId, text: m.text, by: m.from.first_name || 'coordinator' });
    return say(m.chat.id, `Sent to ${run.volunteers[volId].name}'s lens.`, { reply_to_message_id: m.message_id });
  }

  async function onCallback(q) {
    const [kind, volId, idx] = String(q.data || '').split('|');
    try {
      const { run, v } = engine.findVolunteer(volId);
      const team = engine.teams[run.teamId];
      const chat = q.message?.chat?.id;
      const allowed = team.telegram && (chat === team.telegram.chatId || chat === team.telegram.coordinatorChatId);
      if (!allowed || run.status !== 'active') return telegram.answerCallback(q.id, 'Not available');
      if (kind === 'r' && PRESETS[Number(idx)]) {
        engine.reply(run.id, { volunteerId: v.id, text: PRESETS[Number(idx)], by: q.from.first_name || 'coordinator' });
        return telegram.answerCallback(q.id, `Sent to ${v.name}`);
      }
    } catch { /* fall through */ }
    return telegram.answerCallback(q.id, 'Not available');
  }

  async function handle(update) {
    if (update.message) return onMessage(update.message);
    if (update.callback_query) return onCallback(update.callback_query);
    if (update.my_chat_member) return onMyChatMember(update.my_chat_member);
  }

  return { handle, register };
}
