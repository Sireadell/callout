// Discord channel: a webhook is enough to post notices into a team channel.
// Mentions are switched off so a clue can never ping @everyone.
export class Discord {
  constructor({ fetchImpl = fetch } = {}) { this.fetch = fetchImpl; }

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
}
