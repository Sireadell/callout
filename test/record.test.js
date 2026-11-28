import test from 'node:test';
import assert from 'node:assert/strict';
import { recordCsv, recordFilename } from '../server/record.js';
import { setup, start, msg, settle } from './helpers.js';

// Times are ISO text, so they are taken out before looking for coordinate-shaped numbers.
const noTimes = (t) => t.replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, '');

const debrief = {
  run: 'Elm "Street"', startedAt: Date.UTC(2026, 10, 29, 9, 0), endedAt: Date.UTC(2026, 10, 29, 10, 0),
  volunteers: [{ name: '=HYPERLINK("x")', area: 'A1', checkins: 3, missedNotices: 1, firstAt: Date.UTC(2026, 10, 29, 9, 5), lastAt: Date.UTC(2026, 10, 29, 9, 50), markedOk: 1, signedOut: true, trail: [{ lat: 51.5012345, lng: -0.1212345 }] }],
  clues: [{ by: 'Ana', text: '+1 door, "open"', pos: { lat: 51.5012345, lng: -0.1212345 }, at: Date.UTC(2026, 10, 29, 9, 20) }],
};

test('the record lists people and clues with ISO times, quoted and escaped', () => {
  const csv = recordCsv(debrief);
  assert.match(csv, /"name","area","check-ins","missed notices","first check-in","last check-in","marked OK","signed out"/);
  assert.match(csv, /"'=HYPERLINK\(""x""\)","A1","3","1","2026-11-29T09:05:00.000Z","2026-11-29T09:50:00.000Z","1","yes"/);
  assert.match(csv, /"2026-11-29T09:20:00.000Z","Ana","'\+1 door, ""open"""/);
  assert.match(csv, /"Run","Elm ""Street"""/);
});

test('the record holds no coordinates and no trail', () => {
  const csv = recordCsv(debrief);
  assert.doesNotMatch(noTimes(csv), /\d\.\d{3,}/);
  assert.doesNotMatch(csv, /lat|lng|trail/i);
});

test('the file name has the run name and the date', () => {
  assert.equal(recordFilename(debrief), 'safety-record-elm-street-2026-11-29.csv');
});

async function ended(opts) {
  const s = setup(opts);
  await start(s);
  s.tg.docs.length = 0;
  return s;
}

test('/end sends exactly one record file to the group, quietly and protected', async () => {
  const s = await ended();
  await s.bot.handle(msg('/end')); await settle();
  assert.equal(s.tg.docs.length, 1);
  const d = s.tg.docs[0];
  assert.equal(d.chat, -500);
  assert.match(d.filename, /^safety-record-elm-street-\d{4}-\d{2}-\d{2}\.csv$/);
  assert.equal(d.caption, 'Safety record for "Elm Street": 1 people, 0 clues. No positions included.');
  assert.equal(d.extra.protect_content, true);
  assert.equal(d.extra.disable_notification, true);
  assert.doesNotMatch(noTimes(d.bytes.toString('utf8')), /\d\.\d{3,}/);
});

test('/end still finishes when the file cannot be sent', async () => {
  const s = await ended();
  s.tg.sendDocument = async () => { throw new Error('boom'); };
  const log = console.error; console.error = () => {};
  try { await s.bot.handle(msg('/end')); await settle(); } finally { console.error = log; }
  assert.equal(Object.values(s.engine.runs)[0].status, 'ended');
  assert.ok(s.tg.out.some((m) => /finished after/.test(m.text || '')));
});
