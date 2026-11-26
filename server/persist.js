// What may be kept after a run, and what may leave the server (the copy in the Sheet):
// no positions, no trails, and sign-in keys and pairing codes only as one-way hashes.
import { createHash } from 'node:crypto';

export const hashKey = (s) => createHash('sha256').update(String(s)).digest('hex');
export const isHash = (s) => /^[0-9a-f]{64}$/.test(s);

// Anything shaped like a coordinate (three or more decimals), alone or as a pair.
const COORD = /-?\d{1,3}\.\d{3,}(?:\s*,\s*-?\d{1,3}\.\d+)?/g;
export const noCoords = (text) => String(text).replace(COORD, '[position]');

function scrubText(o) {
  for (const [k, v] of Object.entries(o)) {
    if (typeof v === 'string') o[k] = noCoords(v);
    else if (v && typeof v === 'object') scrubText(v);
  }
}

// Takes every position out of one run, in place.
export function stripPositions(run) {
  for (const v of Object.values(run.volunteers || {})) { v.pos = null; v.trail = []; }
  for (const c of run.clues || []) c.pos = null;
  // Live locations keep their message ids, so the bot can still stop them.
  for (const l of Object.values(run.live || {})) { delete l.lat; delete l.lng; }
  scrubText(run);
}

export function withoutPositions(snap) {
  const c = JSON.parse(JSON.stringify(snap));
  for (const r of Object.values(c.runs || {})) stripPositions(r);
  return c;
}
