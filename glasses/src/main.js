import { waitForEvenAppBridge, OsEventTypeList, StartUpPageCreateResult, DeviceConnectType, AudioInputSource, AudioSpeakerRole, ImuReportPace } from '@evenrealities/even_hub_sdk';
import { view, BOXES, MENU, ANSWER_ITEM, questionText, questionRows, SPEAK, PRESET_CLUES, HOLD_MAX_S, HOLD_MIN_MS, holdScreen, listenScreen, thinkScreen, confirmScreen, isOk, voiceAction, okScreen, stillScreen, backupScreen } from './view.js';
import { makeStillness } from './motion.js';

const SERVER = import.meta.env?.VITE_SERVER_URL || localStorage.getItem('callout.server') || 'http://localhost:8787';
const state = { mode: 'glance', screen: null, reply: null, pending: null, token: null, sync: null, syncedAt: 0, flash: '', device: {}, lastReply: '' };
let bridge;
let flashTimer;

async function api(path, body) {
  if (window.__quiet) throw new Error('quiet');
  const r = await fetch(`${SERVER}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: state.token, ...body }),
  });
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    if (/unknown token|run ended/.test(j.error || '')) endedByServer();
    throw new Error(`${path} ${r.status} ${j.error || ''}`);
  }
  return r.json();
}

// The server says the run is over: show it once, forget the token, go back to the pairing screen.
function endedByServer() {
  if (!state.token) return;
  const listUp = onListPage();
  state.token = null; state.sync = null; state.ended = true; state.mode = 'glance'; state.reply = null; state.question = null; state.answering = null;
  bridge?.setLocalStorage('callout.token', '').catch(() => {});
  if (listUp) bridge.rebuildPageContainer(TEXT_PAGE()).catch(() => {}); else paint();
}

// Only boxes whose text changed are sent to the glasses, one paint at a time.
let drawn = {};
let painting = Promise.resolve();
function paint() {
  painting = painting.then(draw).catch(() => {});
  return painting;
}
async function draw() {
  if (!bridge || onListPage()) return;
  const now = view(state);
  for (const box of BOXES) {
    const content = now[box.key] || ' ';
    if (drawn[box.key] === content) continue;
    if (await bridge.textContainerUpgrade({ containerID: box.id, containerName: box.name, content })) drawn[box.key] = content;
  }
}
function setScreen(screen) { state.screen = screen; paint(); }
// The quick clue and question pages replace the text boxes until they are closed.
const onListPage = () => state.mode === 'presets' || state.mode === 'question';
const menuItems = () => (state.question ? [...MENU, ANSWER_ITEM] : MENU);

const TEXT_PAGE = () => {
  const now = view(state);
  drawn = {};
  return {
    containerTotalNum: BOXES.length,
    textObject: BOXES.map((box) => ({
      xPosition: 0, yPosition: box.y, width: 576, height: box.height, paddingLength: 4, textColor: box.brightness,
      containerID: box.id, containerName: box.name, content: now[box.key] || ' ', isEventCapture: box.capture,
    })),
    menuObject: { menuItems: menuItems() },
  };
};

// ---- voice clue: hold to talk (let go to send), or the menu route with a 4 second window ----
const voice = { frames: [], timer: null, t0: 0, id: 0, hold: false };
const toBase64 = (bytes) => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

async function startTalk(hold = false) {
  if (!state.token) return flash('Pair first');
  const id = ++voice.id;
  const secs = hold ? HOLD_MAX_S : 4;
  state.mode = 'listen'; voice.hold = hold; voice.frames = []; voice.t0 = Date.now();
  clearInterval(voice.timer);
  const what = state.answering ? 'answer' : undefined;
  setScreen(hold ? holdScreen(what && 'your answer') : listenScreen(secs, what));
  const on = await bridge.audioControl(true, AudioInputSource.Glasses).catch(() => false);
  if (voice.id !== id || state.mode !== 'listen') {
    // Let go or cancelled before the microphone had opened: make sure it does not stay open.
    if (on && state.mode !== 'listen' && state.mode !== 'ok') bridge.audioControl(false).catch(() => {});
    return;
  }
  if (!on) { state.mode = 'glance'; return flash('▲ Microphone not available'); }
  voice.timer = setInterval(() => {
    const left = secs - (Date.now() - voice.t0) / 1000;
    if (left <= 0) stopTalk(); else if (!hold) setScreen(listenScreen(Math.ceil(left), what));
  }, 500);
}

function releaseTalk() {
  if (state.mode !== 'listen' || !voice.hold) return;
  if (Date.now() - voice.t0 < HOLD_MIN_MS) return cancelClue('Too short. Hold while you talk');
  stopTalk();
}

function joinFrames() {
  const pcm = new Uint8Array(voice.frames.reduce((n, f) => n + f.length, 0));
  let at = 0;
  for (const f of voice.frames) { pcm.set(f, at); at += f.length; }
  return pcm;
}

// ---- spoken OK: when a check-in is overdue the mic opens for three short rounds ----
// Nothing listens in the background. The window opens once per due check-in, and only while the app is showing.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = { run: 0, kind: 'checkin' };
const motion = makeStillness();
async function okWindow(kind = 'checkin') {
  if (state.mode !== 'glance' || !state.token) return;
  state.mode = 'ok'; ok.kind = kind; const mine = ++ok.run;
  let answered = false;
  try {
    for (let round = 1; round <= 3 && state.mode === 'ok' && ok.run === mine; round++) {
      voice.frames = []; setScreen(kind === 'still' ? stillScreen(round) : okScreen(round));
      if (!(await bridge.audioControl(true, AudioInputSource.Glasses))) break;
      await sleep(3000);
      // Skipped or replaced (for example by hold to talk): the microphone now belongs to someone else.
      if (state.mode !== 'ok' || ok.run !== mine) return;
      await bridge.audioControl(false);
      const res = await api('/api/voice', { audio: toBase64(joinFrames()) }).catch(() => ({ text: '' }));
      if (ok.run !== mine) return;
      const asked = voiceAction(res).type;
      if (isOk(res.text) || asked === 'checkin' || asked === 'backup') {
        answered = true; state.mode = 'glance';
        if (kind === 'still') { motion.reset(); state.stillUnanswered = false; }
        if (asked === 'backup') askBackup(); // only opens the confirm screen
        else if (kind === 'still') flash('● Thanks');
        else await checkIn();
        return;
      }
    }
  } finally {
    // A question that got no answer is passed on as a plain fact, never as a guess about the wearer.
    if (kind === 'still' && !answered && ok.run === mine) { state.stillUnanswered = true; heartbeat(); } if (ok.run === mine && state.mode === 'ok') { state.mode = 'glance'; paint(); } }
}
function dueMs() { return state.sync ? state.sync.dueInMs - (Date.now() - state.syncedAt) : 1; }
function watchDue() {
  if (state.mode !== 'glance' || !state.token || !state.sync) return;
  if (dueMs() > 0) state.okTried = false;
  else if (!state.okTried) { state.okTried = true; okWindow(); }
  // No head movement for a while: ask once, then wait for movement before asking again.
  if (state.mode === 'glance' && state.device?.isWearing !== false) {
    if (!motion.isStill()) { state.stillAsked = false; state.stillUnanswered = false; }
    else if (!state.stillAsked) { state.stillAsked = true; okWindow('still'); }
  }
}

async function stopTalk() {
  if (state.mode !== 'listen') return;
  clearInterval(voice.timer);
  state.mode = 'think'; setScreen(thinkScreen());
  const id = voice.id;
  const left = () => voice.id !== id || state.mode !== 'think'; // left through the menu while waiting
  await bridge.audioControl(false);
  try {
    const res = await api('/api/voice', { audio: toBase64(joinFrames()) });
    if (left()) return;
    const asked = voiceAction(res);
    if (asked.type === 'none') return cancelClue('Heard nothing. Try again');
    if (asked.type === 'cancel') return cancelClue('Cancelled');
    if (state.answering) return showConfirm(String(res.text).trim()); // an answer is only words
    if (asked.type === 'clue') return showConfirm(asked.text);
    state.mode = 'glance';
    if (asked.type === 'backup') return askBackup(); // never sent from voice alone
    return checkIn();
  } catch { if (!left()) cancelClue('▲ Could not hear you. Try again'); }
}

function showConfirm(text) {
  state.mode = 'confirm'; state.pending = text;
  const what = state.answering ? 'answer' : undefined;
  let left = 3; setScreen(confirmScreen(text, left, what));
  clearInterval(voice.timer);
  voice.timer = setInterval(() => { left -= 1; if (left <= 0) sendPending(); else setScreen(confirmScreen(text, left, what)); }, 1000);
}

async function sendClue(text) {
  flash('○ Sending clue...', 8000);
  const here = await pos();
  try { const r = await api('/api/clue', { text, pos: here }); state.lastClueId = r.id; flash('● Clue sent'); }
  catch (e) { if (isNetwork(e)) hold('/api/clue', { text, pos: here }, 'Clue'); else flash('▲ Not sent. Try again'); }
}

// ---- no signal: keep check-ins and clues, send them in order when the server answers again ----
// Each keeps the time it was made. The server caps that time (never the future, at most 30 minutes old).
const isNetwork = (e) => e instanceof TypeError || /quiet/.test(e?.message || '');
function saveQueue() { bridge?.setLocalStorage('callout.queue', JSON.stringify(state.queue)).catch(() => {}); }
function hold(path, body, label) {
  (state.queue ||= []).push({ path, body, at: Date.now() });
  if (state.queue.length > 20) state.queue.shift();
  saveQueue(); flash(`○ ${label} saved. Sends when signal returns`, 5000);
}
let flushing = false;
async function flush() {
  if (flushing || !state.queue?.length || !state.token) return;
  flushing = true;
  try {
    while (state.queue.length) {
      const item = state.queue[0];
      try { await api(item.path, { ...item.body, at: item.at }); }
      catch (e) { if (isNetwork(e)) break; } // a refusal from the server drops the item so it cannot block the rest
      state.queue.shift(); saveQueue();
    }
  } finally { flushing = false; }
}

// ---- photo for the last clue: never needed for the core flow, added after the clue ----
// Shrunk to 800 px wide JPEG so it stays small on a phone connection.
function shrink(asset, maxW = 800) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, maxW / img.width);
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      resolve(c.toDataURL('image/jpeg', 0.6).split(',')[1]);
    };
    img.onerror = reject;
    img.src = `data:${asset.mimeType || 'image/jpeg'};base64,${asset.base64}`;
  });
}
async function addPhoto(fromCamera) {
  if (!state.token) return flash('Pair first');
  if (!state.lastClueId) return flash('Send a clue first');
  try {
    const asset = fromCamera ? await bridge.captureImageFromCamera() : await bridge.pickImageFromAlbum();
    if (!asset) return flash('No photo taken');
    flash('Sending photo...', 8000);
    await api('/api/photo', { clueId: state.lastClueId, image: await shrink(asset) });
    flash('● Photo sent');
  } catch { flash('▲ Photo not sent'); }
}
async function sendPending() {
  clearInterval(voice.timer);
  const text = state.pending; state.pending = null; state.mode = 'glance';
  const q = state.answering; state.answering = null;
  if (!text) return;
  if (q) await sendAnswer(q, text); else await sendClue(text);
}
function cancelClue(msg) {
  ok.run += 1; clearInterval(voice.timer); state.pending = null; state.answering = null; state.mode = 'glance';
  bridge.audioControl(false).catch(() => {});
  if (msg) flash(msg); else paint();
}

// ---- quick clues: a list on the lens, one tap ----
async function openPresets() {
  if (!state.token) return flash('Pair first');
  state.mode = 'presets';
  await bridge.rebuildPageContainer({
    containerTotalNum: 1,
    listObject: [{ xPosition: 0, yPosition: 0, width: 576, height: 288, containerID: 4, containerName: 'presets',
      itemContainer: { itemCount: PRESET_CLUES.length, itemName: PRESET_CLUES }, isEventCapture: 1 }],
    menuObject: { menuItems: menuItems() },
  });
}
async function closePresets() {
  state.mode = 'glance';
  await bridge.rebuildPageContainer(TEXT_PAGE());
}
// ---- a question from the coordinator, answered with one tap or by voice ----
// Opens once per question, and only from the main screen. Skipped ones stay in the menu.
const TAP_GUARD_MS = 800; // a tap meant for the main screen must not pick an answer
function askIfNew() {
  if (state.mode === 'glance' && state.token && state.question && state.askedId !== state.question.id) openQuestion(state.question);
}
async function openQuestion(q) {
  state.mode = 'question'; state.askedId = q.id; state.openQ = q; state.openedAt = Date.now();
  const rows = questionRows(q);
  await bridge.rebuildPageContainer({
    containerTotalNum: 2,
    textObject: [{ xPosition: 0, yPosition: 0, width: 576, height: 96, paddingLength: 4, textColor: 4, containerID: 5, containerName: 'question', content: questionText(q), isEventCapture: 0 }],
    listObject: [{ xPosition: 0, yPosition: 100, width: 576, height: 188, containerID: 6, containerName: 'answers',
      itemContainer: { itemCount: rows.length, itemName: rows }, isEventCapture: 1 }],
    menuObject: { menuItems: menuItems() },
  });
}
async function closeQuestion() {
  state.mode = 'glance'; state.openQ = null;
  await bridge.rebuildPageContainer(TEXT_PAGE());
}
async function speakAnswer(hold) {
  const q = state.openQ;
  await closeQuestion();
  state.answering = q;
  return startTalk(hold);
}
async function onQuestionEvent(click, dbl, listEvent) {
  const q = state.openQ;
  if (dbl) { await closeQuestion(); return flash('Skipped. Menu: Answer question', 5000); }
  if (!click || !listEvent) return;
  if (Date.now() - state.openedAt < TAP_GUARD_MS) {
    return bridge.textContainerUpgrade({ containerID: 5, containerName: 'question', content: questionText(q, 'Tap again to answer.') });
  }
  const rows = questionRows(q);
  const picked = listEvent.currentSelectItemName || rows[listEvent.currentSelectItemIndex ?? 0];
  if (picked === SPEAK) return speakAnswer(false);
  await closeQuestion();
  return sendAnswer(q, picked);
}
async function sendAnswer(q, answer) {
  if (state.question?.id === q.id) state.question = null;
  flash('○ Sending answer...', 8000);
  const body = { questionId: q.id, answer };
  try { await api('/api/answer', body); flash('● Answer sent'); await sync(); }
  catch (e) {
    if (isNetwork(e)) hold('/api/answer', body, 'Answer');
    else flash(/unknown question/.test(e.message) ? '▲ That question has closed' : '▲ Not sent. Try again');
  }
}

// A short answer on the lens. Every gesture gets one, or a new screen.
function flash(msg, ms = 3000) {
  state.flash = msg; state.flashMode = state.mode; paint(); clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { state.flash = ''; paint(); }, ms);
}

async function pos() {
  try {
    const l = await bridge.getAppLocation({ timeoutMs: 3000 });
    return l ? { lat: l.latitude, lng: l.longitude } : undefined;
  } catch { return undefined; }
}

async function sync() {
  if (!state.token) return;
  try {
    applySync(await api('/api/sync', { pos: await pos() }));
  } catch { /* offline: keep the last screen. The server notices if we stay silent. */ }
}
function applySync(reply) {
  if (!state.token) return;
  state.sync = reply;
  state.syncedAt = Date.now();
  flush();
  if (reply.replies?.length) {
    const last = reply.replies.at(-1);
    state.lastReply = last.full || last.text; state.lastReplyBy = last.by;
    showReply(last);
  }
  state.question = reply.question || null;
  if (state.mode === 'question' && state.openQ.id !== state.question?.id) {
    closeQuestion().then(() => { flash('That question has closed'); askIfNew(); });
  } else askIfNew();
  paint();
}

// A reply takes the main box for 10 seconds. While it shows, a tap says "got it".
function showReply(r) {
  state.reply = { id: r.id, by: r.by, text: r.text, tappable: Boolean(r.id) };
  state.flash = '';
  clearTimeout(state.replyTimer); state.replyTimer = setTimeout(expireReply, 10000);
  paint();
}

// A reply that arrived while another screen was up waits for the main screen, so it is not lost.
function expireReply() {
  if (state.mode !== 'glance') { state.replyTimer = setTimeout(expireReply, 5000); return; }
  state.reply = null; paint();
}

async function checkIn() {
  if (!state.token) return flash('Pair first');
  flash('○ Checking in...', 8000);
  const here = await pos();
  try { await api('/api/checkin', { pos: here }); flash('● Checked in'); await sync(); }
  catch (e) { if (isNetwork(e)) hold('/api/checkin', { pos: here }, 'Check-in'); else flash('▲ Not sent. Try again'); }
}

async function heartbeat() {
  if (!state.token) return;
  const d = state.device;
  try {
    await api('/api/heartbeat', { battery: d.batteryLevel, charging: d.isCharging, inCase: d.isInCase, worn: d.isWearing, still: state.stillUnanswered || undefined, pos: await pos() });
  } catch { /* ignore */ }
}

async function pair(code) {
  const r = await fetch(`${SERVER}/api/pair`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }),
  });
  if (!r.ok) throw new Error('bad code');
  const j = await r.json();
  state.token = j.token; state.ended = false;
  await bridge.setLocalStorage('callout.token', j.token); phoneStatus();
  await sync(); await heartbeat();
}

// Sign out: stops this person's check-in notices, then the system exit dialog.
async function signOut() {
  flash('○ Signing out...', 8000);
  try { await api('/api/signout', {}); } catch { return flash('▲ Not signed out. Try again'); }
  bridge.shutDownPageContainer(1);
}

// Backup request: asks first, never sends by one stray tap, and times out without sending.
function askBackup() {
  if (!state.token) return flash('Pair first');
  state.mode = 'backup'; setScreen(backupScreen());
  clearTimeout(state.backupTimer); state.backupTimer = setTimeout(() => { if (state.mode === 'backup') cancelClue('Not sent'); }, 8000);
}
async function sendBackup() {
  clearTimeout(state.backupTimer); state.mode = 'glance';
  flash('○ Sending...', 8000);
  try { await api('/api/backup', { pos: await pos() }); flash('● Team asked for backup', 6000); } catch { flash('▲ Not sent. Try again'); }
}

async function confirmReplyNow() {
  const r = state.reply;
  if (!r?.id) return;
  clearTimeout(state.replyTimer); state.reply = null; flash('● Got it', 2000);
  try { await api('/api/confirm', { replyId: r.id }); } catch { /* the coordinator just does not see the reaction */ }
}

async function onMenu(id) {
  if (state.mode === 'presets') await closePresets();
  else if (state.mode === 'question') await closeQuestion();
  else if (state.mode !== 'glance') cancelClue('');
  if (id === 1) checkIn();
  else if (id === 2) startTalk(false);
  else if (id === 3) openPresets();
  else if (id === 4) { if (state.lastReply) showReply({ by: state.lastReplyBy, text: state.lastReply }); else flash('No reply yet', 6000); }
  else if (id === 5) signOut();
  else if (id === 8) askBackup();
  else if (id === 6) addPhoto(true);
  else if (id === 7) addPhoto(false);
  else if (id === 9) { if (state.question) openQuestion(state.question); else flash('No open question'); }
}

function onEvent(e) {
  // Motion samples arrive as system events with no tap type. Handle them first so they never count as a tap.
  if (e.sysEvent?.imuData) { motion.feed(e.sysEvent.imuData); return; }
  if (e.audioEvent) {
    // Self-speech filter: keep the wearer's voice, drop frames the app classes as someone else.
    if ((state.mode === 'listen' || state.mode === 'ok') && e.audioEvent.speakerRole !== AudioSpeakerRole.Other) voice.frames.push(e.audioEvent.audioPcm);
    return;
  }
  if (e.menuItemClickEvent) return onMenu(e.menuItemClickEvent.itemID);
  const ev = e.textEvent || e.sysEvent || e.listEvent;
  if (!ev) return;
  // A plain tap arrives with no eventType (click is code 0, which the host leaves out).
  const t = ev.eventType ?? OsEventTypeList.CLICK_EVENT;
  const click = t === OsEventTypeList.CLICK_EVENT;
  const dbl = t === OsEventTypeList.DOUBLE_CLICK_EVENT;
  const swipe = t === OsEventTypeList.SCROLL_TOP_EVENT || t === OsEventTypeList.SCROLL_BOTTOM_EVENT;
  if (t === OsEventTypeList.FOREGROUND_ENTER_EVENT) { sync(); heartbeat(); return; }
  if (t === OsEventTypeList.LONG_PRESS_EVENT) return onHold();
  if (t === OsEventTypeList.LONG_PRESS_RELEASE_EVENT) return releaseTalk();
  if (state.mode === 'listen') { if (click) stopTalk(); else if (swipe || dbl) cancelClue('Cancelled'); return; }
  if (state.mode === 'ok') { if (click) { const still = ok.kind === 'still'; cancelClue(''); if (still) { motion.reset(); state.stillUnanswered = false; flash('● Thanks'); } else checkIn(); } else if (swipe || dbl) cancelClue('Skipped'); return; }
  if (state.mode === 'confirm') { if (click) sendPending(); else if (swipe || dbl) cancelClue('Cancelled'); return; }
  if (state.mode === 'think') return flash(BUSY);
  if (state.mode === 'question') return onQuestionEvent(click, dbl, e.listEvent);
  if (state.mode === 'backup') { if (click) sendBackup(); else if (swipe || dbl) { clearTimeout(state.backupTimer); cancelClue('Cancelled'); } return; }
  if (state.mode === 'presets') {
    if (dbl) return closePresets();
    if (click && e.listEvent) {
      const name = e.listEvent.currentSelectItemName || PRESET_CLUES[e.listEvent.currentSelectItemIndex ?? 0];
      closePresets().then(() => sendClue(name));
    }
    return;
  }
  if (click && state.reply?.tappable) confirmReplyNow();      // a tap while a reply shows means got it
  else if (click) checkIn();                              // ring or temple tap
  else if (dbl) bridge.shutDownPageContainer(1);          // store rule: system exit dialog
  else if (swipe) flash(GESTURES);
}

// Holding works from the main screen, the quick clue list, the "say OK" window and the confirm screen
// (hold again to say it afresh). It never answers the backup question.
function onHold() {
  if (state.mode === 'presets') return closePresets().then(() => startTalk(true));
  if (state.mode === 'question') return speakAnswer(true);
  if (state.mode === 'ok' || state.mode === 'confirm') { const q = state.answering; cancelClue(''); state.answering = q; return startTalk(true); }
  if (state.mode === 'glance') return startTalk(true);
  if (state.mode === 'think') return flash(BUSY);
  if (state.mode === 'backup') return flash('Tap: send. Swipe: cancel.');
}
const BUSY = '○ Still working...';
const GESTURES = 'Tap: check in. Hold: talk. Menu: more.';

async function start() {
  bridge = await waitForEvenAppBridge();
  // The host says once, right after load, whether the app was opened from the phone or the glasses menu.
  bridge.onLaunchSource((source) => { state.launch = source; phoneStatus(); paint(); });
  state.token = (await bridge.getLocalStorage('callout.token')) || null;
  try { state.queue = JSON.parse((await bridge.getLocalStorage('callout.queue')) || '[]'); } catch { state.queue = []; }
  const res = await bridge.createStartUpPageContainer(TEXT_PAGE());
  if (res !== StartUpPageCreateResult.success) console.warn('startup page', res);
  bridge.onEvenHubEvent(onEvent);
  bridge.imuControl(true, ImuReportPace.P1000).catch(() => {}); // one sample a second is enough to see stillness
  bridge.onDeviceStatusChanged((s) => {
    const before = state.device || {};
    state.device = s;
    // Tell the server at once when the glasses are put down, taken off, or the battery drops low.
    const worn = before.isWearing !== s.isWearing || before.isCharging !== s.isCharging || before.isInCase !== s.isInCase;
    const lowNow = typeof s.batteryLevel === 'number' && s.batteryLevel <= 15 && !(typeof before.batteryLevel === 'number' && before.batteryLevel <= 15);
    if (s.connectType === DeviceConnectType.Connected || worn || lowNow) heartbeat();
    paint();
  });
  window.callout = { pair, sync, checkIn };
  // Local testing: open the page with ?code=XXXX to pair without typing.
  const urlCode = new URLSearchParams(location.search).get('code');
  if (urlCode && !state.token) await pair(urlCode.toUpperCase()).catch(() => {});
  setInterval(() => { paint(); askIfNew(); watchDue(); }, 1000); setInterval(sync, 5000); setInterval(heartbeat, 30000);
  sync();
}
start();

// One line on the phone page that matches how the app was opened.
function phoneStatus() {
  const out = document.getElementById('pairMsg');
  if (!out) return;
  if (state.token) out.textContent = 'Callout is running on your glasses.';
  else if (state.launch === 'glassesMenu') out.textContent = 'Opened from your glasses. Enter your code here.';
}

// Phone-side pairing form (glasses cannot type).
document.getElementById('pairForm')?.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const out = document.getElementById('pairMsg');
  try { await pair(document.getElementById('code').value.trim().toUpperCase()); out.textContent = 'Paired. Look at your glasses.'; }
  catch { out.textContent = 'That code did not work. Ask your coordinator for a new one.'; }
});

// Developer panel, only with ?dev=1. The simulator sends no battery, wearing or signal events,
// so this fakes them to show the notices. It is not part of the real app.
if (new URLSearchParams(location.search).get('dev') === '1') {
  const box = document.createElement('div');
  box.style.cssText = 'margin-top:24px;padding:12px;border:1px dashed #999';
  box.innerHTML = '<b>Developer panel</b><br><small>Fakes device state for testing. Not part of the real app.</small>';
  const add = (label, fn) => { const b = document.createElement('button'); b.textContent = label; b.type = 'button'; b.onclick = fn; box.append(b); };
  const set = (patch) => { state.device = { ...state.device, ...patch }; heartbeat(); paint(); };
  add('Battery 10%', () => set({ batteryLevel: 10, isCharging: false }));
  add('Battery 80% on charge', () => set({ batteryLevel: 80, isCharging: true }));
  add('Glasses off', () => set({ isWearing: false, isCharging: false, isInCase: false }));
  add('Glasses back on', () => set({ isWearing: true }));
  add('Fake: no movement for 5 min', () => motion.forceStill());
  add('Go quiet (stop talking to server)', () => { window.__quiet = true; });
  add('Come back', () => { window.__quiet = false; sync(); heartbeat(); });
  document.body.append(box);
}
