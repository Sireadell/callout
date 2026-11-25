// The copy of the server's state that may leave the server (kept in the Sheet): no positions, no trails.
export function withoutPositions(snap) {
  const c = JSON.parse(JSON.stringify(snap));
  for (const r of Object.values(c.runs || {})) {
    for (const v of Object.values(r.volunteers || {})) { v.pos = null; v.trail = []; }
    for (const k of r.clues || []) k.pos = null;
  }
  return c;
}
