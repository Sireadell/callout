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

export function makeBot({ engine, telegram, router, onDebrief = async () => {} }) {
  const say = (chatId, text, extra) => telegram.send(chatId, text, extra);

  async function onMessage(m) {
    const chatId = m.chat.id;
    const text = (m.text || '').trim();
    const cmd = text.match(/^\/(\w+)(?:@\w+)?\s*([\s\S]*)$/);
    if (!cmd) return replyToClue(m);
    const [, name, arg] = cmd;
    const isGroup = m.chat.type === 'group' || m.chat.type === 'supergroup';

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
      return say(chatId, `${vn} (${area}): enter this code in the glasses app within 15 minutes, once only:\n${code}`);
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
  }

  return { handle };
}
