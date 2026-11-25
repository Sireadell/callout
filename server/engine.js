// Callout run engine. All time comes from an injected clock, so tests can
// jump forward with a fake clock. Everything is plain objects so a run can be
// saved to a file and restored.
import { randomBytes } from 'node:crypto';

export const DEFAULTS = Object.freeze({
  checkinMs: 15 * 60_000, // time between check-ins
  coordinatorGraceMs: 2 * 60_000, // overdue time before the coordinator is told
  teamGraceMs: 5 * 60_000, // further overdue time before the whole team is told
  silentMs: 3 * 60_000, // no contact from the glasses app for this long
  lowBatteryPct: 15,
  pairingTtlMs: 15 * 60_000,
  trailMax: 500,
});

const ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789'; // no 0/O/1/I/L
const newCode = () => Array.from(randomBytes(10), (b) => ALPHABET[b % ALPHABET.length]).join('');
const newId = (p) => `${p}_${randomBytes(5).toString('hex')}`;
const mins = (ms) => Math.max(0, Math.floor(ms / 60_000));
const place = (p) => (p ? `${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}` : 'no position yet');
const TEAM_ONLY = 'This notice goes only to your own team.';

export class Engine {
  constructor({ clock = { now: () => Date.now() }, notify = () => {}, config = {} } = {}) {
    this.clock = clock;
    this.notify = notify;
    this.cfg = { ...DEFAULTS, ...config };
    this.teams = {};
    this.runs = {};
    this.pairings = {};
    this.tokens = {};
  }

  // Check-in gap for a run: set with /interval, else the default.
  gap(run) { return run.checkinMs || this.cfg.checkinMs; }
  setGap(runId, minutes) {
    const run = this._run(runId);
    const m = Math.round(Number(minutes));
    if (!(m >= 5 && m <= 60)) throw new Error('between 5 and 60 minutes');
    run.checkinMs = m * 60_000;
    this._emit(run, 'team', 'interval', `Check-in gap is now ${m} min.`);
    return m;
  }

  // ---------- setup ----------
  addTeam({ name, telegram = null, discord = null }) {
    const id = newId('team');
    this.teams[id] = { id, name, telegram, discord };
    return this.teams[id];
  }

  startRun({ teamId, name }) {
    if (!this.teams[teamId]) throw new Error('unknown team');
    const id = newId('run');
    this.runs[id] = {
      id, teamId, name, status: 'active', startedAt: this.clock.now(),
      volunteers: {}, clues: [], replies: [], log: [],
    };
    this._emit(this.runs[id], 'team', 'run_started', `Run "${name}" started.`);
    return this.runs[id];
  }

  addVolunteer(runId, { name, area }) {
    const run = this._run(runId);
    const v = {
      id: newId('vol'), name, area, status: 'waiting', lastCheckin: null, lastSeen: null,
      step: 0, pos: null, trail: [], battery: null,
      flags: { low: false, off: false, silent: false }, checkins: 0, missed: 0,
    };
    run.volunteers[v.id] = v;
    const code = newCode();
    const expiresAt = this.clock.now() + this.cfg.pairingTtlMs;
    this.pairings[code] = { runId, volunteerId: v.id, expiresAt, used: false };
    return { volunteer: v, code, expiresAt };
  }

  // The glasses app trades a single-use code for a token.
  pair(code) {
    const p = this.pairings[String(code || '').toUpperCase()];
    if (!p || p.used) throw new Error('code not valid');
    if (this.clock.now() > p.expiresAt) throw new Error('code expired');
    p.used = true;
    const run = this._run(p.runId);
    const v = run.volunteers[p.volunteerId];
    const now = this.clock.now();
    v.status = 'active';
    v.lastCheckin = now;
    v.lastSeen = now;
    const token = randomBytes(24).toString('hex');
    this.tokens[token] = { runId: run.id, volunteerId: v.id };
    this._emit(run, 'team', 'joined', `${v.name} joined (${v.area}).`);
    return { token, runId: run.id, name: v.name, area: v.area, nextDueAt: now + this.gap(run) };
  }

  // ---------- events from the glasses app ----------
  checkIn(token, { pos } = {}) {
    const { run, v } = this._auth(token);
    this._touch(v, pos);
    const prevStep = v.step;
    v.lastCheckin = this.clock.now();
    v.step = 0;
    v.nudge = 0;
    v.checkins += 1;
    v.firstAt ||= v.lastCheckin; v.lastAt = v.lastCheckin;
    if (prevStep === 1) this._emit(run, 'coordinator', 'back_in_touch', `${v.name} (${v.area}) has checked in again.`, { volunteerId: v.id });
    if (prevStep === 2) this._emit(run, 'team', 'back_in_touch', `${v.name} (${v.area}) has checked in again.`, { volunteerId: v.id });
    return { nextDueAt: v.lastCheckin + this.gap(run) };
  }

  heartbeat(token, { battery, charging, inCase, worn, still, pos } = {}) {
    const { run, v } = this._auth(token);
    const wasSilent = v.flags.silent;
    this._touch(v, pos);
    if (wasSilent) this._emit(run, 'coordinator', 'back_online', `${v.name} (${v.area}) is back online.`, { volunteerId: v.id });
    if (typeof battery === 'number') {
      v.battery = battery;
      const low = battery <= this.cfg.lowBatteryPct && !charging;
      if (low && !v.flags.low) {
        v.flags.low = true;
        this._emit(run, 'coordinator', 'battery_low', `${v.name} (${v.area}): glasses battery low (${battery}%). Last position: ${place(v.pos)}.`, { volunteerId: v.id });
      } else if (!low && (charging || battery > this.cfg.lowBatteryPct + 10)) v.flags.low = false;
    }
    if (worn !== undefined) {
      const off = worn === false && !charging && !inCase;
      if (off && !v.flags.off) {
        v.flags.off = true;
        this._emit(run, 'coordinator', 'glasses_off', `${v.name} (${v.area}) has taken the glasses off. Last position: ${place(v.pos)}.`, { volunteerId: v.id });
      } else if (!off) v.flags.off = false;
    }
    if (still === true && !v.flags.still && worn !== false) {
      v.flags.still = true;
      this._emit(run, 'coordinator', 'still', `${v.name} (${v.area}): no head movement was seen for a while and Still there? got no answer. This only means no movement was seen. Last position: ${place(v.pos)}.`, { volunteerId: v.id });
    } else if (!still) v.flags.still = false;
  }

  clue(token, { text, pos, voiceNoteId = null, photoId = null }) {
    const { run, v } = this._auth(token);
    this._touch(v, pos);
    const clue = { id: newId('clue'), volunteerId: v.id, text: String(text || '').slice(0, 500), pos: v.pos, voiceNoteId, photoId, at: this.clock.now() };
    run.clues.push(clue);
    this._emit(run, 'team', 'clue', `${v.name} (${v.area}): ${clue.text} [${place(clue.pos)}]`, {
      volunteerId: v.id, clueId: clue.id, clueText: clue.text, who: `${v.name} (${v.area})`, pos: clue.pos,
    });
    return clue;
  }

  // A photo for a clue already sent. The picture is passed straight to the chat apps and never kept here.
  attachPhoto(token, { clueId, bytes }) {
    const { run, v } = this._auth(token);
    this._touch(v);
    const clue = run.clues.find((c) => c.id === clueId && c.volunteerId === v.id);
    if (!clue) throw new Error('unknown clue');
    if (!bytes?.length || bytes.length > 600 * 1024) throw new Error('photo too large');
    clue.photoId = newId('photo');
    this._emit(run, 'team', 'clue_photo', `${v.name} (${v.area}): photo added to "${clue.text}"`, {
      volunteerId: v.id, clueId: clue.id, photo: bytes,
    });
    return { photoId: clue.photoId };
  }

  // What the lens shows. Counts as contact from the glasses app.
  sync(token, { pos } = {}) {
    const { run, v } = this._auth(token);
    this._touch(v, pos);
    const now = this.clock.now();
    const replies = run.replies.filter((r) => r.volunteerId === v.id && !r.delivered);
    replies.forEach((r) => { r.delivered = true; });
    return {
      runName: run.name, area: v.area, dueInMs: v.lastCheckin + this.gap(run) - now,
      step: v.step, replies: replies.map((r) => ({ id: r.id, text: r.short || r.text, full: r.text, by: r.by })),
      team: this.teamStatus(run.id),
    };
  }

  confirmReply(token, replyId) {
    const { run, v } = this._auth(token);
    const r = run.replies.find((x) => x.id === replyId && x.volunteerId === v.id);
    if (!r) throw new Error('unknown reply');
    if (r.confirmedAt) return; // a second tap changes nothing
    r.confirmedAt = this.clock.now();
    this._emit(run, 'coordinator', 'reply_confirmed', `${v.name} saw: "${r.text}"`, { volunteerId: v.id, src: r.src });
  }

  // The volunteer signs out from the lens menu: no more check-in notices for them.
  signOut(token) {
    const { run, v } = this._auth(token);
    if (v.status === 'signed_out') return;
    v.status = 'signed_out';
    v.step = 0;
    this._emit(run, 'team', 'signed_out', `${v.name} (${v.area}) signed out.`, { volunteerId: v.id });
  }

  // A team request from the lens menu. Worded as a request to the team, never as an alarm.
  needBackup(token, { pos } = {}) {
    const { run, v } = this._auth(token);
    this._touch(v, pos);
    this._emit(run, 'team', 'need_backup', `${v.name} (${v.area}) asked the team for backup. Last position: ${place(v.pos)}. ${TEAM_ONLY}`, { volunteerId: v.id, pos: v.pos, clueText: `${v.name} asked the team for backup`, who: `${v.name} (${v.area}), team notice only` });
  }

  // ---------- events from the coordinator (chat apps) ----------
  // The coordinator reached them another way (radio, phone): clear the overdue steps.
  markOk(runId, volunteerId, by = 'coordinator') {
    const run = this._run(runId);
    const v = run.volunteers[volunteerId];
    if (!v || v.status !== 'active') throw new Error('unknown volunteer');
    v.lastCheckin = this.clock.now();
    v.lastSeen = this.clock.now();
    v.step = 0; v.nudge = 0; v.flags.silent = false; v.flags.still = false;
    v.marked = (v.marked || 0) + 1;
    this._emit(run, 'team', 'marked_ok', `${v.name} (${v.area}) marked OK by ${by}.`, { volunteerId: v.id });
  }

  // A check-in pressed in the volunteer's own private chat with the bot.
  checkInFor(volunteerId) {
    const { run, v } = this.findVolunteer(volunteerId);
    if (run.status !== 'active' || v.status !== 'active') throw new Error('not active');
    const prev = v.step;
    v.lastCheckin = this.clock.now(); v.lastSeen = v.lastCheckin;
    v.step = 0; v.nudge = 0; v.checkins += 1; v.flags.silent = false;
    v.firstAt ||= v.lastCheckin; v.lastAt = v.lastCheckin;
    if (prev === 1) this._emit(run, 'coordinator', 'back_in_touch', `${v.name} (${v.area}) has checked in again.`, { volunteerId: v.id });
    if (prev === 2) this._emit(run, 'team', 'back_in_touch', `${v.name} (${v.area}) has checked in again.`, { volunteerId: v.id });
  }

  reply(runId, { volunteerId, text, by = 'coordinator', short, src }) {
    const run = this._run(runId);
    if (!run.volunteers[volunteerId]) throw new Error('unknown volunteer');
    const r = { id: newId('rep'), volunteerId, text: String(text).slice(0, 500), short: short ? String(short).slice(0, 80) : undefined, by, src, at: this.clock.now(), delivered: false, confirmedAt: null };
    run.replies.push(r);
    return r;
  }

  // A notice from outside the glasses flow (summary, run closed). Works on finished runs too.
  announce(runId, audience, kind, text, extra = {}) { this._emit(this._run(runId), audience, kind, text, extra); }

  // ---------- the clock ----------
  tick() {
    const now = this.clock.now();
    for (const run of Object.values(this.runs)) {
      if (run.status !== 'active') continue;
      for (const v of Object.values(run.volunteers)) {
        if (v.status !== 'active') continue;
        const overdue = now - (v.lastCheckin + this.gap(run));
        // Private phone nudges for the volunteer, only if they linked their chat. Never include a position.
        if (v.tgChatId) {
          const soon = Math.min(2 * 60_000, Math.floor(this.gap(run) / 3));
          if (overdue >= 0 && (v.nudge || 0) < 2) {
            v.nudge = 2;
            this._emit(run, 'volunteer', 'nudge_overdue', `Check-in time, ${v.name}. Press the button or check in on your glasses. If there is none, your coordinator is told in ${Math.max(1, Math.round(this.cfg.coordinatorGraceMs / 60_000))} min.`, { volunteerId: v.id });
          } else if (overdue >= -soon && overdue < 0 && !v.nudge) {
            v.nudge = 1;
            this._emit(run, 'volunteer', 'nudge_soon', `Check-in due in about ${Math.max(1, Math.ceil(-overdue / 60_000))} min.`, { volunteerId: v.id });
          }
        }
        if (overdue >= this.cfg.coordinatorGraceMs && v.step < 1) {
          v.step = 1; v.missed += 1;
          this._emit(run, 'coordinator', 'missed_checkin',
            `Missed check-in notice: ${v.name} (${v.area}) is ${mins(overdue)} min overdue. Last position: ${place(v.pos)}. ${TEAM_ONLY}`, { volunteerId: v.id });
        }
        if (overdue >= this.cfg.coordinatorGraceMs + this.cfg.teamGraceMs && v.step < 2) {
          v.step = 2;
          this._emit(run, 'team', 'missed_checkin_team',
            `Still no check-in from ${v.name} (${v.area}), ${mins(overdue)} min overdue. Last position: ${place(v.pos)}. ${TEAM_ONLY}`, { volunteerId: v.id });
        }
        if (now - v.lastSeen >= this.cfg.silentMs && !v.flags.silent) {
          v.flags.silent = true;
          this._emit(run, 'coordinator', 'went_silent',
            `${v.name} (${v.area}): the glasses app has gone quiet for ${mins(now - v.lastSeen)} min (phone, signal or app paused). Last position: ${place(v.pos)}.`, { volunteerId: v.id });
        }
      }
    }
  }

  teamStatus(runId) {
    const run = this._run(runId);
    const now = this.clock.now();
    return Object.values(run.volunteers).map((v) => {
      let state = 'waiting';
      if (v.status === 'signed_out') state = 'out';
      if (v.status === 'active') {
        const left = v.lastCheckin + this.gap(run) - now;
        state = v.flags.silent ? 'silent' : v.step > 0 ? 'overdue' : left <= 0 ? 'due' : 'ok';
      }
      return { id: v.id, name: v.name, area: v.area, state, battery: v.battery };
    });
  }

  // Ends the run, returns the debrief, then deletes positions and tokens.
  endRun(runId) {
    const run = this._run(runId);
    if (run.status !== 'active') throw new Error('run already ended');
    const debrief = {
      run: run.name, startedAt: run.startedAt, endedAt: this.clock.now(),
      volunteers: Object.values(run.volunteers).map((v) => ({
        name: v.name, area: v.area, checkins: v.checkins, missedNotices: v.missed, firstAt: v.firstAt || null, lastAt: v.lastAt || null, markedOk: v.marked || 0, signedOut: v.status === 'signed_out', trail: v.trail.slice(),
      })),
      clues: run.clues.map((c) => ({ by: run.volunteers[c.volunteerId].name, text: c.text, pos: c.pos, at: c.at })),
    };
    run.status = 'ended';
    this._emit(run, 'team', 'debrief', this.debriefText(debrief));
    for (const v of Object.values(run.volunteers)) { v.pos = null; v.trail = []; v.tgChatId = null; }
    run.clues.forEach((c) => { c.pos = null; });
    for (const [t, ref] of Object.entries(this.tokens)) if (ref.runId === run.id) delete this.tokens[t];
    return debrief;
  }

  debriefText(d) {
    const lines = [`Run "${d.run}" finished after ${mins(d.endedAt - d.startedAt)} min.`];
    for (const v of d.volunteers) lines.push(`${v.name} (${v.area}): ${v.checkins} check-ins, ${v.missedNotices} missed notices${v.markedOk ? `, marked OK ${v.markedOk}x` : ''}${v.signedOut ? ', signed out' : ''}.`);
    lines.push(`${d.clues.length} clue(s) reported.`);
    return lines.join('\n');
  }

  findVolunteer(volId) {
    for (const run of Object.values(this.runs)) if (run.volunteers[volId]) return { run, v: run.volunteers[volId] };
    throw new Error('unknown volunteer');
  }
  teamByChat(chatId) {
    return Object.values(this.teams).find((t) => t.telegram && (t.telegram.chatId === chatId || t.telegram.coordinatorChatId === chatId));
  }
  activeRun(teamId) {
    return Object.values(this.runs).filter((r) => r.teamId === teamId && r.status === 'active').at(-1);
  }

  // ---------- saving ----------
  snapshot() { return JSON.parse(JSON.stringify({ teams: this.teams, runs: this.runs, pairings: this.pairings, tokens: this.tokens })); }
  restore(s) { this.teams = s.teams || {}; this.runs = s.runs || {}; this.pairings = s.pairings || {}; this.tokens = s.tokens || {}; }

  // ---------- inside ----------
  _run(id) { const r = this.runs[id]; if (!r) throw new Error('unknown run'); return r; }
  _auth(token) {
    const ref = this.tokens[token];
    if (!ref) throw new Error('unknown token');
    const run = this._run(ref.runId);
    if (run.status !== 'active') throw new Error('run ended');
    return { run, v: run.volunteers[ref.volunteerId] };
  }
  _touch(v, pos) {
    v.lastSeen = this.clock.now();
    v.flags.silent = false;
    if (pos && typeof pos.lat === 'number' && typeof pos.lng === 'number') {
      v.pos = { lat: pos.lat, lng: pos.lng, at: v.lastSeen };
      v.trail.push(v.pos);
      if (v.trail.length > this.cfg.trailMax) v.trail.shift();
    }
  }
  _emit(run, audience, kind, text, extra = {}) {
    run.log.push({ at: this.clock.now(), kind, text });
    this.notify({ runId: run.id, teamId: run.teamId, audience, kind, text, ...extra });
  }
}
