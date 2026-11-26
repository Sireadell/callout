// Discord channel. A webhook posts notices into a team channel. If a bot token and channel are set,
// clue notices carry reply buttons, and button presses come back through /discord/interactions.
// Mentions are switched off so a clue can never ping @everyone.
import { createPublicKey, verify } from 'node:crypto';

const SPKI_ED25519 = Buffer.from('302a300506032b6570032100', 'hex');

// Discord signs every interaction. Reject anything that does not verify.
export function verifyInteraction(publicKeyHex, signatureHex, timestamp, rawBody) {
  try {
    const key = createPublicKey({ key: Buffer.concat([SPKI_ED25519, Buffer.from(publicKeyHex, 'hex')]), format: 'der', type: 'spki' });
    return verify(null, Buffer.from(String(timestamp) + rawBody), key, Buffer.from(signatureHex, 'hex'));
  } catch { return false; }
}

export class Discord {
  constructor({ fetchImpl = fetch, botToken = null } = {}) { this.fetch = fetchImpl; this.botToken = botToken; }

  async post(webhookUrl, text) {
    const res = await this.fetch(`${webhookUrl}${webhookUrl.includes('?') ? '&' : '?'}wait=true`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: text.slice(0, 1900), allowed_mentions: { parse: [] } }),
    });
    if (res.status === 429) {
      const d = await res.json().catch(() => ({}));
      await new Promise((r) => setTimeout(r, Math.ceil((d.retry_after || 1) * 1000)));
      return this.post(webhookUrl, text);
    }
    if (!res.ok) throw new Error(`discord webhook: ${res.status}`);
    return res.json().catch(() => ({}));
  }

  // Bot post with buttons. buttons: [{label, id}] (up to 5 in one row).
  async postWithButtons(channelId, text, buttons = []) {
    const body = { content: text.slice(0, 1900), allowed_mentions: { parse: [] } };
    if (buttons.length) body.components = [{ type: 1, components: buttons.slice(0, 5).map((b) => ({ type: 2, style: 2, label: b.label.slice(0, 80), custom_id: b.id })) }];
    const res = await this.fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bot ${this.botToken}` }, body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`discord bot post: ${res.status}`);
    return res.json().catch(() => ({}));
  }
}

// Discord user ids allowed to press reply buttons, from a comma or space separated setting.
export const parseIds = (s) => new Set(String(s || '').split(/[\s,]+/).filter((x) => /^\d{5,25}$/.test(x)));

// Answers Discord's check (type 1) and button presses (type 3). Replies to the clicker are private to them.
// Only the ids in DISCORD_COORDINATOR_IDS can send a reply. With none set, nobody can.
export function makeInteractionHandler({ engine, presets, coordinatorIds = process.env.DISCORD_COORDINATOR_IDS }) {
  const allowed = parseIds(coordinatorIds);
  const priv = (content) => ({ type: 4, data: { content, flags: 64, allowed_mentions: { parse: [] } } });
  return function handle(i) {
    if (i.type === 1) return { type: 1 };
    if (i.type !== 3) return priv('Not available');
    const [kind, volId, idx] = String(i.data?.custom_id || '').split('|');
    try {
      const { run, v } = engine.findVolunteer(volId);
      const team = engine.teams[run.teamId];
      if (kind !== 'r' || !presets[Number(idx)] || run.status !== 'active' || !team.discord?.channelId || team.discord.channelId !== i.channel_id) return priv('Not available');
      const user = i.member?.user || i.user;
      if (!allowed.has(String(user?.id || ''))) {
        return priv(`Only the coordinator can do that.${/^\d+$/.test(user?.id || '') ? ` Your Discord user ID is ${user.id}.` : ''}`);
      }
      engine.reply(run.id, { volunteerId: v.id, text: presets[Number(idx)], by: user.global_name || user.username || 'coordinator' });
      return priv(`Sent to ${v.name}`);
    } catch { return priv('Not available'); }
  };
}
