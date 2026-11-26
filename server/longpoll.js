// /api/sync that can wait: the lens asks once and the server answers as soon as there is something new,
// or after a few seconds with the normal reply. A plain sync (no wait) answers at once, as before.
export function makeLongPoll({ engine, maxWaitS = 25 }) {
  const waiting = new Map(); // volunteer id -> the one held request

  engine.wake = (volunteerId) => waiting.get(volunteerId)?.('news');

  return function sync({ token, pos, wait, rev } = {}, signal) {
    const seconds = Math.min(maxWaitS, Math.max(0, Number(wait) || 0));
    if (!seconds) return engine.sync(token, { pos });
    const { run, v } = engine.touch(token, pos);
    const seen = Number.isInteger(rev) ? rev : -1;
    engine.resend(run, v, seen);
    waiting.get(v.id)?.('replaced'); // one held request per volunteer
    if (signal?.aborted) return null;
    if (engine.hasNews(run, v, seen)) return engine.sync(token, { contact: false });

    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (why) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', gone);
        if (waiting.get(v.id) === finish) waiting.delete(v.id);
        // Let the change that woke us finish first.
        setImmediate(() => {
          // Nobody is listening: take no replies, they go out on the next sync.
          if (why === 'gone') return resolve(null);
          try { resolve(engine.sync(token, { contact: false, peek: why === 'replaced' })); } catch (e) { reject(e); }
        });
      };
      const gone = () => finish('gone');
      const timer = setTimeout(() => finish('time'), seconds * 1000);
      signal?.addEventListener('abort', gone, { once: true });
      waiting.set(v.id, finish);
    });
  };
}
