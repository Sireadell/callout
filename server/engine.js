// Callout run engine. All time comes from an injected clock, so tests can
// jump forward with a fake clock. Everything is plain objects so a run can be
// saved to a file and restored.
import { randomBytes } from 'node:crypto';
import { hashKey, isHash, noCoords, stripPositions } from './persist.js';

export const DEFAULTS = Object.freeze({
  checkinMs: 15 * 60_000, // time between check-ins
  coordinatorGraceMs: 2 * 60_000, // overdue time before the coordinator is told
  teamGraceMs: 5 * 60_000, // further overdue time before the whole team is told
  silentMs: 3 * 60_000, // no contact from the glasses app for this long
  closedGraceMs: 20_000, // an app moved to the background is reported only if it stays away this long
  lowBatteryPct: 15,
  pairingTtlMs: 15 * 60_000,
  trailMax: 500,
});

const QUESTION_TTL_MS = 15 * 60_000;
export const QUICK_CLUES = Object.freeze(['All done', 'No answer', 'Spoke to them', 'Access blocked']);

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
    this.timings = {};
  }

  // Check-in gap for a run: set with /interval, else the default.
  gap(run) { return run.checkinMs || this.cfg.checkinMs; }
  setGap(runId, minutes) {
    const run = this._run(runId);
    const m = Math.round(Number(minutes));
    if (!(m >= 5 && m <= 60)) throw new Error('between 5 and 60 minutes');
    run.checkinMs = m * 60_000;
    this._bumpAll(run);
    this._emit(run, 'team', 'interval', `Check-in gap is now ${m} min.`);
    return m;
  }

  // Set with /clues: 1 to 4 short lines. An empty list goes back to the everyday defaults.
  setQuickClues(runId, list) {
    const run = this._run(runId);
    const clues = [...new Set(list.map((c) => String(c).replace(/\s+/g, ' ').trim()).filter(Boolean))];
    if (clues.length > 4 || clues.some((c) => c.length > 16)) throw new Error('up to 4 clues of up to 16 characters');
    run.quickClues = clues.length ? clues : undefined;
    this._bumpAll(run);
    this.changed();
    return this.quickClues(run);
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
    return { volunteer: v, ...this._issue(runId, v.id) };
  }

  // A fresh code for someone who has not joined yet. Their earlier code stops working.
  newCodeFor(runId, volunteerId, area) {
    const run = this._run(runId);
    const v = run.volunteers[volunteerId];
    if (!v || v.status !== 'waiting') throw new Error('already joined');
    if (area) v.area = area;
    for (const [k, p] of Object.entries(this.pairings)) if (p.volunteerId === volunteerId) delete this.pairings[k];
    return { volunteer: v, ...this._issue(runId, volunteerId) };
  }
  _issue(runId, volunteerId) {
    const code = newCode();
    const expiresAt = this.clock.now() + this.cfg.pairingTtlMs;
    this.pairings[hashKey(code)] = { runId, volunteerId, expiresAt, used: false };
    this.changed();
    return { code, expiresAt };
  }

  // Codes and sign-in keys are only ever stored as hashes.
  findPairing(code) { return this.pairings[hashKey(String(code || '').toUpperCase())]; }

  // Something worth saving at once happened. The server replaces this.
  changed() {}

  // The glasses app trades a single-use code for a token.
  pair(code) {
    const p = this.findPairing(code);
    if (!p || p.used) throw new Error('code not valid');
    if (this.clock.now() > p.expiresAt) throw new Error('code expired');
    p.used = true;
    const run = this._run(p.runId);
    return this._admit(run, run.volunteers[p.volunteerId]);
  }

  // Joining with the short lens code, approved by the coordinator. The Telegram person who sent the code
  // becomes this volunteer's private chat.
  join(runId, { volunteerId, name, area, chatId }) {
    const run = this._run(runId);
    if (run.status !== 'active') throw new Error('run ended');
    let v = volunteerId ? run.volunteers[volunteerId] : null;
    if (volunteerId && !v) throw new Error('unknown volunteer');
    v ||= this.addVolunteer(runId, { name, area }).volunteer;
    // One lens per volunteer: earlier sign-in keys and unused codes stop working.
    for (const keys of [this.tokens, this.pairings]) for (const [k, ref] of Object.entries(keys)) if (ref.volunteerId === v.id) delete keys[k];
    v.tgChatId = chatId;
    return this._admit(run, v);
  }

  _admit(run, v) {
    const now = this.clock.now();
    v.status = 'active';
    v.lastCheckin = now;
    v.lastSeen = now;
    v.step = 0; v.nudge = 0;
    const token = randomBytes(24).toString('hex');
    this.tokens[hashKey(token)] = { runId: run.id, volunteerId: v.id };
    this._emit(run, 'team', 'joined', `${v.name} joined (${v.area}).`);
    this._bumpAll(run);
    this.changed();
    return { token, runId: run.id, name: v.name, area: v.area, nextDueAt: now + this.gap(run) };
  }

  // ---------- events from the glasses app ----------
  // The glasses app can hold a check-in until the signal returns and send it with the time it was made.
  // That time is capped: never in the future, never more than 30 minutes old, never before the last check-in.
  _when(v, at) {
    const now = this.clock.now();
    if (typeof at !== 'number' || !Number.isFinite(at)) return now;
    return Math.min(now, Math.max(at, now - 30 * 60_000, v.lastCheckin || 0));
  }

  checkIn(token, { pos, at } = {}) {
    const { run, v } = this._auth(token);
    this._touch(v, pos);
    const prevStep = v.step;
    v.lastCheckin = this._when(v, at);
    v.step = 0;
    v.nudge = 0;
    v.checkins += 1;
    v.firstAt ||= v.lastCheckin; v.lastAt = v.lastCheckin;
    if (prevStep === 1) this._emit(run, 'coordinator', 'back_in_touch', `${v.name} (${v.area}) has checked in again.`, { volunteerId: v.id });
    if (prevStep === 2) this._emit(run, 'team', 'back_in_touch', `${v.name} (${v.area}) has checked in again.`, { volunteerId: v.id });
    this.changed();
    this._bumpAll(run);
    return { nextDueAt: v.lastCheckin + this.gap(run) };
  }

  heartbeat(token, { battery, charging, inCase, worn, still, pos, app, reason } = {}) {
    const { run, v } = this._auth(token);
    if (app === 'closed') return this._appClosed(run, v, reason);
    const wasSilent = v.flags.silent || v.closed?.told;
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

  // The glasses app says it is closing. Moving to the background is often brief, so that one waits a moment.
  _appClosed(run, v, reason) {
    v.lastSeen = this.clock.now();
    if (v.status !== 'active' || v.closed?.told) return;
    v.closed ||= { at: v.lastSeen, told: false };
    // Also covers a move to the background that turns into a real exit.
    if (reason !== 'foreground_exit') this._tellClosed(run, v);
  }
  _tellClosed(run, v) {
    v.closed.told = true;
    const at = new Date(v.closed.at).toISOString().slice(11, 16);
    this._emit(run, 'coordinator', 'app_closed', `${v.name} (${v.area}): the glasses app was closed at ${at} UTC. Last position: ${place(v.pos)}.`, { volunteerId: v.id });
  }

  clue(token, { text, pos, photoId = null, at = undefined }) {
    const { run, v } = this._auth(token);
    this._touch(v, pos);
    const madeAt = this._when({ lastCheckin: 0 }, at);
    const lateMin = mins(this.clock.now() - madeAt);
    const clue = { id: newId('clue'), volunteerId: v.id, text: String(text || '').slice(0, 500), pos: v.pos, photoId, at: madeAt };
    run.clues.push(clue);
    this._emit(run, 'team', 'clue', `${v.name} (${v.area}): ${clue.text}${lateMin >= 1 ? ` (sent ${lateMin} min late)` : ''} [${place(clue.pos)}]`, {
      volunteerId: v.id, clueId: clue.id, clueText: clue.text, who: `${v.name} (${v.area})${lateMin >= 1 ? `, sent ${lateMin} min late` : ''}`, pos: clue.pos,
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

  // Checks a sign-in key and counts as contact, without handing out any waiting reply.
  touch(token, pos) { const found = this._auth(token); this._touch(found.v, pos); return found; }

  // ---------- telling a waiting lens ----------
  // Called when something this volunteer's lens shows has changed. The long poll replaces it.
  wake() {}
  _bump(v) { v.rev = (v.rev || 0) + 1; this.wake(v.id); }
  _bumpAll(run) { Object.values(run.volunteers).forEach((v) => this._bump(v)); }
  hasNews(run, v, rev) { return (v.rev || 0) !== rev || run.replies.some((r) => r.volunteerId === v.id && !r.delivered); }
  // A lens that asks with an older number never got the later replies (a dropped connection): send them again.
  resend(run, v, rev) {
    if (rev < 0) return;
    for (const r of run.replies) if (r.volunteerId === v.id && r.delivered && !r.confirmedAt && r.rev > rev) r.delivered = false;
  }

  // The one-tap clues on the lens for this run.
  quickClues(run) { return run.quickClues || [...QUICK_CLUES]; }

  // What the lens shows. Counts as contact from the glasses app.
  // peek: hand out no replies. contact: false when the contact was already counted (a held request ending).
  sync(token, { pos, peek = false, contact = true } = {}) {
    const { run, v } = this._auth(token);
    if (contact) this._touch(v, pos);
    const now = this.clock.now();
    const replies = peek ? [] : run.replies.filter((r) => r.volunteerId === v.id && !r.delivered);
    for (const r of replies) {
      r.delivered = true;
      if (!r.sentAt) { r.sentAt = now; this.measure('replyToLens', now - r.at); }
    }
    return {
      rev: v.rev || 0,
      runName: run.name, area: v.area, dueInMs: v.lastCheckin + this.gap(run) - now,
      step: v.step, replies: replies.map((r) => ({ id: r.id, text: r.short || r.text, full: r.text, by: r.by })),
      team: this.teamStatus(run.id), quickClues: this.quickClues(run), question: this._openQuestion(v),
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
    this._bumpAll(run);
    this.changed();
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
    this._bumpAll(run);
    this.changed();
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
    this.changed();
    this._bumpAll(run);
  }

  reply(runId, { volunteerId, text, by = 'coordinator', short, src }) {
    const run = this._run(runId);
    if (!run.volunteers[volunteerId]) throw new Error('unknown volunteer');
    const r = { id: newId('rep'), volunteerId, text: String(text).slice(0, 500), short: short ? String(short).slice(0, 80) : undefined, by, src, at: this.clock.now(), delivered: false, confirmedAt: null };
    run.replies.push(r);
    r.rev = (run.volunteers[volunteerId].rev || 0) + 1;
    this._bump(run.volunteers[volunteerId]);
    return r;
  }

  // A coordinator question for the lens, with answers the volunteer can send in one tap.
  // A volunteer has one open question at a time: a new one replaces it.
  ask(runId, { volunteerId, text, by = 'coordinator', answers = [], src }) {
    const run = this._run(runId);
    const v = run.volunteers[volunteerId];
    if (!v) throw new Error('unknown volunteer');
    const line = String(text || '').replace(/\s+/g, ' ').trim();
    if (!line) throw new Error('empty question');
    v.question = { id: newId('q'), text: line.slice(0, 80), by, answers: answers.slice(0, 3).map((a) => String(a).slice(0, 16)), src, at: this.clock.now(), answeredAt: null };
    this._bump(v);
    return v.question;
  }

  // A tapped or spoken answer. It goes back to whoever asked, as a reply to the question. It is not a check-in.
  answer(token, { questionId, answer, at } = {}) {
    const { run, v } = this._auth(token);
    this._touch(v);
    const q = v.question;
    if (!q || q.id !== questionId) throw new Error('unknown question');
    if (q.answeredAt) return; // a second send changes nothing
    if (this._when({ lastCheckin: 0 }, at) - q.at > QUESTION_TTL_MS) throw new Error('unknown question');
    const text = String(answer || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!text) throw new Error('empty answer');
    q.answeredAt = this.clock.now();
    this._bump(v);
    this._emit(run, 'coordinator', 'answer', `${v.name} (${v.area}) answered "${q.text}": ${text}`, { volunteerId: v.id, src: q.src });
  }

  _openQuestion(v) {
    const q = v.question;
    if (!q || q.answeredAt || this.clock.now() - q.at > QUESTION_TTL_MS) return null;
    return { id: q.id, text: q.text, by: q.by, answers: q.answers };
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
          v.step = 1; v.missed += 1; this._bumpAll(run);
          this._emit(run, 'coordinator', 'missed_checkin',
            `Missed check-in notice: ${v.name} (${v.area}) is ${mins(overdue)} min overdue. Last position: ${place(v.pos)}. ${TEAM_ONLY}`, { volunteerId: v.id });
        }
        if (overdue >= this.cfg.coordinatorGraceMs + this.cfg.teamGraceMs && v.step < 2) {
          v.step = 2; this._bumpAll(run);
          this._emit(run, 'team', 'missed_checkin_team',
            `Still no check-in from ${v.name} (${v.area}), ${mins(overdue)} min overdue. Last position: ${place(v.pos)}. ${TEAM_ONLY}`, { volunteerId: v.id });
        }
        if (v.closed && !v.closed.told && now - v.closed.at >= this.cfg.closedGraceMs) this._tellClosed(run, v);
        // A closed app has been reported already, so "gone quiet" is not repeated for it.
        if (!v.closed && now - v.lastSeen >= this.cfg.silentMs && !v.flags.silent) {
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
        state = v.flags.silent || v.closed?.told ? 'silent' : v.step > 0 ? 'overdue' : left <= 0 ? 'due' : 'ok';
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
    // Areas where nobody on the list checked in at all. A count of what was recorded, nothing more.
    const reached = new Set(debrief.volunteers.filter((v) => v.checkins > 0).map((v) => v.area));
    debrief.areasWithoutCheckin = [...new Set(debrief.volunteers.map((v) => v.area))].filter((a) => !reached.has(a));
    run.status = 'ended';
    // The notice carries the counts for a table. Trails and positions stay out of it.
    this._emit(run, 'team', 'debrief', this.debriefText(debrief), {
      table: { title: `Run "${debrief.run}" finished after ${mins(debrief.endedAt - debrief.startedAt)} min`, clues: debrief.clues.length, areasWithoutCheckin: debrief.areasWithoutCheckin,
        rows: debrief.volunteers.map((v) => ({ name: v.name, area: v.area, checkins: v.checkins, missed: v.missedNotices, note: [v.markedOk ? `marked OK ${v.markedOk}x` : '', v.signedOut ? 'signed out' : ''].filter(Boolean).join(', ') })) },
    });
    for (const v of Object.values(run.volunteers)) v.tgChatId = null;
    stripPositions(run);
    for (const keys of [this.tokens, this.pairings]) for (const [k, ref] of Object.entries(keys)) if (ref.runId === run.id) delete keys[k];
    this.changed();
    this._bumpAll(run); // held requests end now and learn the run is over
    return debrief;
  }

  debriefText(d) {
    const lines = [`Run "${d.run}" finished after ${mins(d.endedAt - d.startedAt)} min.`];
    for (const v of d.volunteers) lines.push(`${v.name} (${v.area}): ${v.checkins} check-ins, ${v.missedNotices} missed notices${v.markedOk ? `, marked OK ${v.markedOk}x` : ''}${v.signedOut ? ', signed out' : ''}.`);
    lines.push(`${d.clues.length} clue(s) reported.`);
    if (d.areasWithoutCheckin?.length) lines.push(`Areas with no check-in: ${d.areasWithoutCheckin.length} (${d.areasWithoutCheckin.join(', ')}).`);
    return lines.join('\n');
  }

  findVolunteer(volId) {
    for (const run of Object.values(this.runs)) if (run.volunteers[volId]) return { run, v: run.volunteers[volId] };
    throw new Error('unknown volunteer');
  }
  // A group's own team comes before a team that only uses the chat for private notices.
  teamByChat(chatId) {
    const teams = this.teamsByChat(chatId);
    return teams.find((t) => t.telegram.chatId === chatId) || teams[0];
  }
  // One coordinator can run several teams from one private chat, so a chat can lead to more than one team.
  teamsByChat(chatId) {
    return Object.values(this.teams).filter((t) => t.telegram && (t.telegram.chatId === chatId || t.telegram.coordinatorChatId === chatId));
  }
  // Which active run, and which map in it, knows this bot message.
  findMessage(chatId, messageId, map = 'msgIndex') {
    for (const team of this.teamsByChat(chatId)) {
      const run = this.activeRun(team.id);
      const volunteerId = run?.[map]?.[`${chatId}:${messageId}`];
      if (volunteerId) return { team, run, volunteerId };
    }
    return null;
  }
  activeRun(teamId) {
    return Object.values(this.runs).filter((r) => r.teamId === teamId && r.status === 'active').at(-1);
  }

  // ---------- timings ----------
  // The last 50 measured times of each kind, in memory only.
  measure(name, ms) {
    const list = (this.timings[name] ||= []);
    list.push(Math.max(0, Math.round(ms)));
    if (list.length > 50) list.shift();
  }
  timingSummary() {
    const at = (sorted, p) => sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
    return Object.fromEntries(Object.entries(this.timings).map(([name, list]) => {
      const s = [...list].sort((a, b) => a - b);
      return [name, { samples: s.length, p50Ms: at(s, 0.5), p95Ms: at(s, 0.95) }];
    }));
  }

  // ---------- saving ----------
  snapshot() { return JSON.parse(JSON.stringify({ teams: this.teams, runs: this.runs, pairings: this.pairings, tokens: this.tokens })); }
  restore(s) {
    // State saved by an earlier version may hold raw keys and positions in old text: both are cleaned on load.
    const hashed = (keys = {}) => Object.fromEntries(Object.entries(keys).map(([k, v]) => [isHash(k) ? k : hashKey(k), v]));
    this.teams = s.teams || {}; this.runs = s.runs || {}; this.pairings = hashed(s.pairings); this.tokens = hashed(s.tokens);
    for (const run of Object.values(this.runs)) {
      if (run.status !== 'active') stripPositions(run);
      else for (const e of run.log || []) e.text = noCoords(e.text);
    }
  }

  // ---------- inside ----------
  _run(id) { const r = this.runs[id]; if (!r) throw new Error('unknown run'); return r; }
  _auth(token) {
    const ref = typeof token === 'string' ? this.tokens[hashKey(token)] : undefined;
    if (!ref) throw new Error('unknown token');
    const run = this._run(ref.runId);
    if (run.status !== 'active') throw new Error('run ended');
    return { run, v: run.volunteers[ref.volunteerId] };
  }
  _touch(v, pos) {
    v.lastSeen = this.clock.now();
    v.flags.silent = false;
    v.closed = null;
    if (pos && typeof pos.lat === 'number' && typeof pos.lng === 'number') {
      v.pos = { lat: pos.lat, lng: pos.lng, at: v.lastSeen };
      v.trail.push(v.pos);
      if (v.trail.length > this.cfg.trailMax) v.trail.shift();
    }
  }
  _emit(run, audience, kind, text, extra = {}) {
    run.log.push({ at: this.clock.now(), kind, text: noCoords(text) }); // the saved record never holds a position
    this.notify({ runId: run.id, teamId: run.teamId, audience, kind, text, ...extra });
  }
}
