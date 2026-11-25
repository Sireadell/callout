// Short summaries. Server side only, so no key ever reaches the glasses app.
// Works without any key: it falls back to plain trimming, so the lens never waits on the network.
const SYSTEM_LINE = 'Rewrite the message as one plain line of at most 60 characters for a small glasses display. Keep names, places and numbers. No quotes, no emoji. Reply with the line only.';
const SYSTEM_DEBRIEF = 'Summarise a volunteer search run in at most 3 short plain sentences from the facts given. State only what the facts say. Do not guess, diagnose or give advice. Reply with the sentences only.';

// No key: first sentence, cut at a word boundary.
export function trimLine(text, max = 60) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  const first = t.split(/(?<=[.!?])\s/)[0];
  if (first.length <= max) return first;
  const cut = first.slice(0, max - 4);
  return `${cut.slice(0, cut.lastIndexOf(' ') > 20 ? cut.lastIndexOf(' ') : cut.length)}...`;
}

// What the AI is allowed to see about a run: counts and clue words. No names, no positions.
export function debriefFacts(d) {
  const mins = Math.max(0, Math.round((d.endedAt - d.startedAt) / 60000));
  const lines = [`Run length: ${mins} minutes.`, `Volunteers: ${d.volunteers.length}.`];
  const checkins = d.volunteers.reduce((n, v) => n + v.checkins, 0);
  const missed = d.volunteers.reduce((n, v) => n + v.missedNotices, 0);
  lines.push(`Check-ins: ${checkins}. Missed-check-in notices: ${missed}.`);
  lines.push(`Clues (${d.clues.length}):`);
  d.clues.slice(0, 40).forEach((c, i) => lines.push(`${i + 1}. ${c.text}`));
  return lines.join('\n');
}

export function makeAi({ anthropicKey, openrouterKey, openrouterModel = 'anthropic/claude-haiku-4.5', model = 'claude-haiku-5-5', fetchImpl = fetch, timeoutMs = 3500 } = {}) {
  async function ask(system, user, maxTokens) {
    const signal = AbortSignal.timeout(timeoutMs);
    if (anthropicKey) {
      try {
      const r = await fetchImpl('https://api.anthropic.com/v1/messages', {
        method: 'POST', signal,
        headers: { 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] }),
      });
      if (!r.ok) throw new Error(`ai ${r.status}`);
      const j = await r.json();
      return String(j.content?.[0]?.text || '').trim();
      } catch (e) { if (!openrouterKey) throw e; /* no credit or a bad key: try the other provider */ }
    }
    if (openrouterKey) {
      const r = await fetchImpl('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST', signal,
        headers: { authorization: `Bearer ${openrouterKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: openrouterModel, max_tokens: maxTokens, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
      });
      if (!r.ok) throw new Error(`ai ${r.status}`);
      const j = await r.json();
      return String(j.choices?.[0]?.message?.content || '').trim();
    }
    throw new Error('no key');
  }

  return {
    enabled: Boolean(anthropicKey || openrouterKey),
    // One short line for the lens. Short text passes through untouched.
    async oneLine(text) {
      const t = String(text || '').trim();
      if (t.length <= 60) return t;
      try { const s = (await ask(SYSTEM_LINE, t, 60)).replace(/^["']|["']$/g, ''); if (s) return s.slice(0, 80); } catch { /* fall back */ }
      return trimLine(t);
    },
    // Debrief paragraph. Returns '' when no key or on failure: the debrief still goes out without it.
    async debrief(d) {
      if (!d.clues.length) return '';
      try { return (await ask(SYSTEM_DEBRIEF, debriefFacts(d), 200)).slice(0, 700); } catch { return ''; }
    },
  };
}
