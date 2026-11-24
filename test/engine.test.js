import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../server/engine.js';

const MIN = 60_000;

function setup() {
  const clock = { t: 1_000_000, now() { return this.t; }, advance(ms) { this.t += ms; } };
  const sent = [];
  const e = new Engine({ clock, notify: (n) => sent.push(n) });
  const team = e.addTeam({ name: 'Flood wardens' });
  const run = e.startRun({ teamId: team.id, name: 'Elm Street' });
  const add = (name, area) => {
    const { code, volunteer } = e.addVolunteer(run.id, { name, area });
    const { token } = e.pair(code);
    return { token, id: volunteer.id };
  };
  const kinds = () => sent.map((n) => n.kind);
  return { clock, sent, e, run, add, kinds };
}

test('pairing code works once and expires after 15 minutes', () => {
  const { e, run, clock } = setup();
  const a = e.addVolunteer(run.id, { name: 'Ana', area: 'A1' });
  e.pair(a.code);
  assert.throws(() => e.pair(a.code), /not valid/);
  const b = e.addVolunteer(run.id, { name: 'Ben', area: 'A2' });
  clock.advance(15 * MIN + 1);
  assert.throws(() => e.pair(b.code), /expired/);
  assert.throws(() => e.pair('NOPE'), /not valid/);
});

test('on-time check-ins send no missed notice', () => {
  const { e, add, clock, kinds } = setup();
  const ana = add('Ana', 'A1');
  for (let i = 0; i < 4; i++) {
    clock.advance(14 * MIN);
    e.checkIn(ana.token);
    e.tick();
  }
  assert.ok(!kinds().includes('missed_checkin'));
});

test('missed check-in steps up: coordinator first, then the team, once each', () => {
  const { e, add, clock, sent } = setup();
  const ana = add('Ana', 'A1');
  e.heartbeat(ana.token, { pos: { lat: 51.5, lng: -0.12 } });
  clock.advance(15 * MIN + 2 * MIN - 1);
  e.heartbeat(ana.token); // still reachable, only the check-in is missing
  e.tick();
  assert.equal(sent.filter((n) => n.kind === 'missed_checkin').length, 0);
  clock.advance(1);
  e.tick(); e.tick();
  const c = sent.filter((n) => n.kind === 'missed_checkin');
  assert.equal(c.length, 1);
  assert.equal(c[0].audience, 'coordinator');
  assert.match(c[0].text, /51\.50000, -0\.12000/);
  clock.advance(5 * MIN - 1);
  e.heartbeat(ana.token);
  e.tick();
  assert.equal(sent.filter((n) => n.kind === 'missed_checkin_team').length, 0);
  clock.advance(1);
  e.tick(); e.tick();
  const t = sent.filter((n) => n.kind === 'missed_checkin_team');
  assert.equal(t.length, 1);
  assert.equal(t[0].audience, 'team');
});

test('a late check-in tells whoever was told, and restarts the timer', () => {
  const { e, add, clock, sent } = setup();
  const ana = add('Ana', 'A1');
  const ben = add('Ben', 'A2');
  e.heartbeat(ben.token);
  clock.advance(17 * MIN); e.heartbeat(ben.token); e.tick();
  e.checkIn(ana.token);
  assert.equal(sent.at(-1).kind, 'back_in_touch');
  assert.equal(sent.at(-1).audience, 'coordinator');
  assert.equal(e.teamStatus(Object.keys(e.runs)[0]).find((s) => s.name === 'Ana').state, 'ok');
  clock.advance(5 * MIN); e.heartbeat(ana.token); e.heartbeat(ben.token); e.tick();
  e.checkIn(ben.token);
  assert.equal(sent.at(-1).audience, 'team');
});

test('went silent: heartbeat stops, coordinator told once, back online later', () => {
  const { e, add, clock, sent } = setup();
  const ana = add('Ana', 'A1');
  clock.advance(3 * MIN);
  e.tick(); e.tick();
  assert.equal(sent.filter((n) => n.kind === 'went_silent').length, 1);
  e.heartbeat(ana.token);
  assert.equal(sent.at(-1).kind, 'back_online');
});

test('battery low alerts once, not while charging, resets after recharge', () => {
  const { e, add, sent } = setup();
  const ana = add('Ana', 'A1');
  e.heartbeat(ana.token, { battery: 14 });
  e.heartbeat(ana.token, { battery: 12 });
  assert.equal(sent.filter((n) => n.kind === 'battery_low').length, 1);
  e.heartbeat(ana.token, { battery: 40, charging: true });
  e.heartbeat(ana.token, { battery: 10 });
  assert.equal(sent.filter((n) => n.kind === 'battery_low').length, 2);
  const ben = add('Ben', 'A2');
  e.heartbeat(ben.token, { battery: 5, charging: true });
  assert.equal(sent.filter((n) => n.kind === 'battery_low').length, 2);
});

test('glasses off alerts, but not when charging or in the case', () => {
  const { e, add, sent } = setup();
  const ana = add('Ana', 'A1');
  e.heartbeat(ana.token, { worn: false, inCase: true });
  e.heartbeat(ana.token, { worn: false, charging: true });
  assert.equal(sent.filter((n) => n.kind === 'glasses_off').length, 0);
  e.heartbeat(ana.token, { worn: false });
  e.heartbeat(ana.token, { worn: false });
  assert.equal(sent.filter((n) => n.kind === 'glasses_off').length, 1);
  e.heartbeat(ana.token, { worn: true });
  e.heartbeat(ana.token, { worn: false });
  assert.equal(sent.filter((n) => n.kind === 'glasses_off').length, 2);
});

test('clue goes to the team with a place; reply reaches the lens once; confirm tells the coordinator', () => {
  const { e, add, run, sent } = setup();
  const ana = add('Ana', 'A1');
  const clue = e.clue(ana.token, { text: 'Person inside, upstairs', pos: { lat: 1, lng: 2 } });
  assert.equal(sent.at(-1).kind, 'clue');
  assert.match(sent.at(-1).text, /1\.00000, 2\.00000/);
  const r = e.reply(run.id, { volunteerId: ana.id, text: 'Boat is 10 minutes away. Stay put.' });
  const s1 = e.sync(ana.token);
  assert.equal(s1.replies.length, 1);
  assert.equal(e.sync(ana.token).replies.length, 0);
  e.confirmReply(ana.token, r.id);
  assert.equal(sent.at(-1).kind, 'reply_confirmed');
  assert.ok(clue.id);
});

test('notices never use alarm or emergency wording', () => {
  const { e, add, clock, sent } = setup();
  const ana = add('Ana', 'A1');
  e.heartbeat(ana.token, { battery: 5, worn: false });
  clock.advance(30 * MIN);
  e.tick();
  assert.ok(sent.length > 3);
  for (const n of sent) assert.doesNotMatch(n.text, /\bsos\b|emergency|help is coming|ambulance|police/i);
});

test('ending a run gives a debrief and deletes positions and tokens', () => {
  const { e, add, run } = setup();
  const ana = add('Ana', 'A1');
  e.checkIn(ana.token, { pos: { lat: 3, lng: 4 } });
  e.clue(ana.token, { text: 'Road blocked', pos: { lat: 3, lng: 4 } });
  const d = e.endRun(run.id);
  assert.equal(d.volunteers[0].checkins, 1);
  assert.equal(d.volunteers[0].trail.length, 2);
  assert.equal(d.clues.length, 1);
  const v = Object.values(e.runs[run.id].volunteers)[0];
  assert.equal(v.pos, null);
  assert.equal(v.trail.length, 0);
  assert.equal(e.runs[run.id].clues[0].pos, null);
  assert.throws(() => e.checkIn(ana.token), /unknown token/);
});

test('a run can be saved and restored', () => {
  const { e, add, clock } = setup();
  const ana = add('Ana', 'A1');
  const copy = new Engine({ clock });
  copy.restore(e.snapshot());
  assert.doesNotThrow(() => copy.checkIn(ana.token));
});
