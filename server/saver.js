// Saves the state to disk and keeps the copy in the Sheet up to date. Routine changes reach the Sheet at
// most every 30 seconds; a pairing, check-in or run end (and shutdown) is written at once.
import fs from 'node:fs';
import path from 'node:path';
import { withoutPositions } from './persist.js';

export function makeSaver({ engine, file, sheet = null, sheetId = null, everyMs = 30_000, now = Date.now, log = console.log }) {
  let lastDisk = ''; let lastRemote = ''; let remoteAt = -Infinity;
  let chain = Promise.resolve(); let waiting = false;

  function disk() {
    const s = JSON.stringify(engine.snapshot());
    if (s === lastDisk) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.tmp`, s);
    fs.renameSync(`${file}.tmp`, file);
    lastDisk = s;
  }

  // One write at a time. Changes made while one is running are picked up by the next.
  function remote(atOnce) {
    if (!sheet || !sheetId || waiting || (!atOnce && now() - remoteAt < everyMs)) return chain;
    waiting = true;
    chain = chain.then(async () => {
      waiting = false;
      const s = JSON.stringify(withoutPositions(engine.snapshot()));
      if (s === lastRemote) return;
      remoteAt = now();
      try { await sheet.writeState(sheetId, JSON.parse(s)); lastRemote = s; } catch (e) { log('state copy failed:', e.message); }
    });
    return chain;
  }

  const save = (atOnce = false) => {
    try { disk(); } catch (e) { log('state save failed:', e.message); }
    return remote(atOnce);
  };
  return { save: () => save(false), saveNow: () => save(true) };
}
