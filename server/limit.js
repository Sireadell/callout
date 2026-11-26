// Counts tries per key in a time window. allow() counts a try and says whether it is within the limit.
export function makeLimiter({ max, windowMs, now = Date.now }) {
  const seen = new Map();
  const fresh = (key) => (seen.get(key) || []).filter((t) => now() - t < windowMs);
  return {
    full(key) { return fresh(key).length >= max; },
    allow(key) {
      if (seen.size > 5000) seen.clear();
      const list = fresh(key);
      if (list.length >= max) return false;
      seen.set(key, [...list, now()]);
      return true;
    },
  };
}
