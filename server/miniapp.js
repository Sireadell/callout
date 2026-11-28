// Coordinator dashboard inside Telegram (a Mini App). Every call carries Telegram's signed
// initData, checked here with the bot token, so only the person who set the team up can see it.
import { createHmac, timingSafeEqual } from 'node:crypto';

// Telegram's check: HMAC of the sorted fields, keyed from the bot token.
export function validateInitData(initData, botToken, { maxAgeSec = 3600, now = () => Date.now() } = {}) {
  try {
    const params = new URLSearchParams(String(initData || ''));
    const hash = params.get('hash');
    if (!hash || !botToken) return null;
    params.delete('hash');
    const check = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
    const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
    const want = createHmac('sha256', secret).update(check).digest();
    const got = Buffer.from(hash, 'hex');
    if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
    const age = now() / 1000 - Number(params.get('auth_date') || 0);
    if (!(age >= 0 && age <= maxAgeSec)) return null;
    return JSON.parse(params.get('user') || 'null');
  } catch { return null; }
}

export function makeMiniApp({ engine, botToken, presets, now = () => Date.now() }) {
  function who(initData) {
    const user = validateInitData(initData, botToken, { now });
    if (!user?.id) throw new Error('not signed in');
    const mine = Object.values(engine.teams).filter((t) => t.telegram?.coordinatorUserId === user.id);
    if (!mine.length) throw new Error('not a coordinator');
    // Someone who set up more than one team sees the one with the newest run still going, else the newest run.
    const runs = Object.values(engine.runs).filter((r) => mine.some((t) => t.id === r.teamId));
    const run = runs.filter((r) => r.status === 'active').sort((a, b) => a.startedAt - b.startedAt).at(-1) || runs.sort((a, b) => a.startedAt - b.startedAt).at(-1);
    return { user, team: run ? engine.teams[run.teamId] : mine.at(-1), run };
  }
  return {
    state(initData) {
      const { team, run } = who(initData);
      // Only the coordinator sees this: the tier and the end date, never who paid or the charge.
      const plan = team.plan?.tier === 'team' && team.plan.until > now() ? { tier: 'team', until: team.plan.until } : { tier: 'free' };
      if (!run) return { team: team.name, run: null, plan, volunteers: [], clues: [], presets };
      const status = engine.teamStatus(run.id);
      return {
        team: team.name, run: run.name, status: run.status, plan, presets,
        volunteers: status.map((s) => { const v = run.volunteers[s.id]; return { ...s, pos: v.pos ? { lat: v.pos.lat, lng: v.pos.lng, at: v.pos.at } : null, checkins: v.checkins }; }),
        clues: run.clues.slice(-20).reverse().map((c) => ({ id: c.id, by: run.volunteers[c.volunteerId]?.name, text: c.text, at: c.at, pos: c.pos })),
      };
    },
    reply(initData, { volunteerId, preset, text }) {
      const { user, run } = who(initData);
      if (!run || run.status !== 'active') throw new Error('no active run');
      const line = presets[Number(preset)] ?? String(text || '').trim();
      if (!line) throw new Error('empty line');
      engine.reply(run.id, { volunteerId, text: line, by: user.first_name || 'coordinator' });
      return { ok: true };
    },
  };
}
