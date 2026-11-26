// Joining by a short code shown on the lens. The volunteer sends /join 4821 in the team group and the
// coordinator picks the area. Codes live in memory only, for 10 minutes, and are never saved.
import { randomBytes, randomInt } from 'node:crypto';

export const JOIN_TTL_MS = 10 * 60_000;
const KEEP_PAIRED_MS = 60_000; // the paired reply can be read again if the first one was lost
const MAX_OPEN = 200; // a small share of the 10,000 codes, so guessing one rarely hits

export function makeJoins({ engine }) {
  const open = []; // { id, code, secret, expiresAt, claim, result, doneAt }
  const now = () => engine.clock.now();
  function sweep() {
    for (let i = open.length - 1; i >= 0; i--) {
      const j = open[i];
      if (j.result ? now() - j.doneAt > KEEP_PAIRED_MS : now() > j.expiresAt) open.splice(i, 1);
    }
  }

  return {
    create() {
      sweep();
      if (open.length >= MAX_OPEN) throw new Error('slow down');
      let code;
      do { code = String(randomInt(0, 10_000)).padStart(4, '0'); } while (open.some((j) => j.code === code));
      const j = { id: `join_${randomBytes(5).toString('hex')}`, code, secret: randomBytes(24).toString('hex'), expiresAt: now() + JOIN_TTL_MS, claim: null, result: null, doneAt: 0 };
      open.push(j);
      return { code, secret: j.secret, expiresInMs: JOIN_TTL_MS };
    },
    status(secret) {
      sweep();
      const j = open.find((x) => x.secret === secret);
      if (!j) return { state: 'expired' };
      if (j.result) return { state: 'paired', ...j.result };
      if (j.claim) return { state: 'claimed', name: j.claim.name, team: engine.teams[engine.runs[j.claim.runId]?.teamId]?.name };
      return { state: 'waiting' };
    },
    // The code was sent in a team group. One group only: a claimed code cannot be claimed again.
    claim(code, { runId, userId, name }) {
      sweep();
      const j = open.find((x) => x.code === code && !x.claim && !x.result);
      if (!j) return null;
      j.claim = { runId, userId, name };
      j.expiresAt = now() + JOIN_TTL_MS; // time for the coordinator to choose
      return { id: j.id, ...j.claim };
    },
    pending(id) {
      sweep();
      const j = open.find((x) => x.id === id && x.claim && !x.result);
      return j ? { id, ...j.claim } : null;
    },
    // The coordinator chose: either someone already on the list, or a new person in an area.
    admit(id, { volunteerId, area }) {
      const claim = this.pending(id);
      if (!claim) throw new Error('code expired');
      const joined = engine.join(claim.runId, { volunteerId, name: claim.name, area, chatId: claim.userId });
      const j = open.find((x) => x.id === id);
      const run = engine.runs[claim.runId];
      j.result = { ...joined, team: engine.teams[run.teamId].name };
      j.doneAt = now();
      return j.result;
    },
  };
}
