// Short summaries. Server side only, so no key ever reaches the glasses app.
// Works without any key: it falls back to plain trimming, so the lens never waits on the network.
const SYSTEM_LINE = 'Rewrite the message as one plain line of at most 60 characters for a small glasses display. Keep names, places and numbers. No quotes, no emoji. Reply with the line only.';
const SYSTEM_DEBRIEF = 'Summarise a field team check-in run in at most 3 short plain sentences from the facts given. Call it a run, never a search or a rescue. State only what the facts say. Do not guess, diagnose or give advice. Reply with the sentences only.';

const SYSTEM_ANSWERS = 'A team coordinator asks a field volunteer a question. Give 3 short answers the volunteer could send, one per line, each at most 16 characters. Plain words, no numbering, no emoji, no medical or emergency wording. Reply with the lines only.';
const SYSTEM_DRAFTS = 'A field volunteer sent a short report to the team coordinator. Suggest 2 short replies the coordinator could send back, one per line, each at most 40 characters. Plain words: an acknowledgement or a practical next step or question. No promises about help arriving, no medical or emergency wording, no emoji, no numbering. Reply with the lines only.';
// Words an AI suggestion may never contain: nothing that sounds like rescue, dispatch or a medical judgement.
export const UNSAFE = /\b(sos|911|999|112|emergency|ambulance|rescu\w*|dispatch\w*|diagnos\w*|help is coming|on the way to save|dead|dying|injur\w*|unconscious|safe now|you are safe)\b/i;

// Short suggestions, one per line, from an AI answer: cleaned, guarded, never longer than asked.
export function cleanLines(text, max, count) {
  const lines = String(text || '').split('\n')
    .map((l) => l.replace(/^[\s\d.)*•-]+(?=\D)/, '').replace(/^["']+|["'.]+$/g, '').trim())
    .filter((l) => l && l.length <= max && !UNSAFE.test(l) && /^[\x20-\x7E]+$/.test(l));
  return [...new Set(lines)].slice(0, count);
}

// Common question shapes need no AI.
export function ruleAnswers(question) {
  const q = String(question || '').toLowerCase().trim();
  if (/^how (many|much)\b/.test(q)) return ['None', '1', '2 or more'];
  if (/^(how long|when)\b|\beta\b/.test(q)) return ['5 min', '15 min', '30 min'];
  if (/^(is|are|am|was|were|do|does|did|can|could|have|has|had|will|would|should|any|anyone|anybody|you ok)\b/.test(q)) return ['Yes', 'No', 'Not sure'];
  return null;
}
const OPEN_ANSWERS = ['Not sure', 'Give me 5 min', 'Call me'];
export const suggestAnswers = (question) => ruleAnswers(question) || [...OPEN_ANSWERS];

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
  // Whole minutes, counted the same way as the debrief message, so the two never disagree.
  const mins = Math.max(0, Math.floor((d.endedAt - d.startedAt) / 60000));
  const lines = [`Run length: ${mins} minutes.`, `Volunteers: ${d.volunteers.length}.`];
  const checkins = d.volunteers.reduce((n, v) => n + v.checkins, 0);
  const missed = d.volunteers.reduce((n, v) => n + v.missedNotices, 0);
  lines.push(`Check-ins: ${checkins}. Missed-check-in notices: ${missed}.`);
  if (d.areasWithoutCheckin?.length) lines.push(`Areas with no check-in: ${d.areasWithoutCheckin.length}.`);
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
    // Up to 3 one-tap answers for a coordinator question. Word rules first, AI only for open questions.
    async answers(question) {
      const ruled = ruleAnswers(question);
      if (ruled) return ruled;
      try { const lines = cleanLines(await ask(SYSTEM_ANSWERS, String(question).slice(0, 300), 60), 16, 3); if (lines.length >= 2) return lines; } catch { /* fall back */ }
      return [...OPEN_ANSWERS];
    },
    // Up to 2 reply suggestions for the coordinator. An empty list leaves just the fixed buttons.
    async drafts(clue) {
      if (!clue) return [];
      try { return cleanLines(await ask(SYSTEM_DRAFTS, String(clue).slice(0, 500), 80), 40, 2); } catch { return []; }
    },
    // Debrief paragraph. Returns '' when no key or on failure: the debrief still goes out without it.
    async debrief(d) {
      if (!d.clues.length) return '';
      try { return (await ask(SYSTEM_DEBRIEF, debriefFacts(d), 200)).slice(0, 700); } catch { return ''; }
    },
  };
}
