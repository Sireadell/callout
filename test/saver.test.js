import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Engine } from '../server/engine.js';
import { makeSaver } from '../server/saver.js';

function setup() {
  const clock = { t: 1_000_000, now() { return this.t; } };
  const engine = new Engine({ clock });
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'callout-')), 'state.json');
  const writes = [];
  const sheet = { writeState: async (id, s) => { writes.push(s); } };
  const saver = makeSaver({ engine, file, sheet, sheetId: 'sheet', now: clock.now.bind(clock), log: () => {} });
  let pending = Promise.resolve();
  engine.changed = () => { pending = saver.saveNow(); };
  const team = engine.addTeam({ name: 'Wardens' });
  const run = engine.startRun({ teamId: team.id, name: 'Elm Street' });
  const settled = () => pending;
  return { clock, engine, run, file, writes, saver, settled };
}

test('a pairing and a check-in reach the Sheet copy at once, not after 30 seconds', async () => {
  const { engine, run, writes, saver, settled, clock } = setup();
  await saver.save();
  const { code, volunteer } = engine.addVolunteer(run.id, { name: 'Ana', area: 'A1' });
  const { token } = engine.pair(code);
  await settled();
  assert.equal(writes.at(-1).runs[run.id].volunteers[volunteer.id].status, 'active');
  clock.t += 1000;
  engine.checkIn(token);
  await settled();
  assert.equal(writes.at(-1).runs[run.id].volunteers[volunteer.id].lastCheckin, clock.t);
});

test('routine changes wait 30 seconds, and a shutdown save writes straight away', async () => {
  const { engine, run, file, writes, saver } = setup();
  await saver.save();
  engine.startRun({ teamId: run.teamId, name: 'Second' });
  await saver.save();
  assert.equal(writes.length, 1);
  await saver.saveNow();
  assert.equal(writes.length, 2);
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')).runs).length, 2);
});

test('a failed Sheet write is tried again on a later save', async () => {
  const { engine, file, clock } = setup();
  let fail = true; const writes = [];
  const sheet = { writeState: async (id, s) => { if (fail) throw new Error('quota'); writes.push(s); } };
  const saver = makeSaver({ engine, file, sheet, sheetId: 's', now: () => clock.t, log: () => {} });
  await saver.save();
  fail = false; clock.t += 30_000;
  await saver.save();
  assert.equal(writes.length, 1);
});
