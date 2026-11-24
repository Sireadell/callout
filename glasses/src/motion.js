// Head movement watcher. Feeds on IMU samples {x, y, z} and says when there has been no
// movement for a set time. It asks a question, it never decides anything about the wearer.
export function makeStillness({ stillMs = 5 * 60_000, delta = 0.15, now = () => Date.now() } = {}) {
  let last = null;
  let movedAt = now();
  return {
    feed(s) {
      if (typeof s?.x !== 'number' || typeof s?.y !== 'number' || typeof s?.z !== 'number') return;
      if (last && Math.abs(s.x - last.x) + Math.abs(s.y - last.y) + Math.abs(s.z - last.z) > delta) movedAt = now();
      last = { x: s.x, y: s.y, z: s.z };
    },
    // True when no movement has been seen for stillMs. Needs at least one sample.
    isStill() { return last !== null && now() - movedAt >= stillMs; },
    reset() { movedAt = now(); },
    // Developer panel only: pretend the time has passed.
    forceStill() { last ||= { x: 0, y: 0, z: 0 }; movedAt = now() - stillMs; },
    sinceMs() { return now() - movedAt; },
  };
}
