import { waitForEvenAppBridge, OsEventTypeList, StartUpPageCreateResult, DeviceConnectType, AudioInputSource, AudioSpeakerRole, ImuReportPace } from '@evenrealities/even_hub_sdk';
import { glanceText, MENU, PRESET_CLUES, listenText, thinkText, confirmText, isOk, okText, stillText } from './view.js';
import { makeStillness } from './motion.js';

const SERVER = localStorage.getItem('callout.server') || 'http://localhost:8787';
const state = { mode: 'glance', screen: '', pending: null, token: null, sync: null, syncedAt: 0, flash: '', device: {}, lastReply: '' };
let bridge;
let flashTimer;

async function api(path, body) {
  if (window.__quiet) throw new Error('quiet');
  const r = await fetch(`${SERVER}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: state.token, ...body }),
  });
  if (!r.ok) throw new Error(`${path} ${r.status}`);
  return r.json();
}

async function paint() {
  if (!bridge || state.mode === 'presets') return;
  const content = state.mode === 'glance' ? glanceText(state) : state.screen;
  await bridge.textContainerUpgrade({ containerID: 1, containerName: 'main', content });
}
function setScreen(text) { state.screen = text; paint(); }

const TEXT_PAGE = () => ({
  containerTotalNum: 1,
  textObject: [{ xPosition: 0, yPosition: 0, width: 576, height: 288, containerID: 1, containerName: 'main', content: glanceText(state), isEventCapture: 1 }],
  menuObject: { menuItems: MENU },
});

// ---- voice clue: tap to talk, up to 4 seconds, server turns it into text ----
const voice = { frames: [], timer: null, t0: 0 };
const toBase64 = (bytes) => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

async function startTalk() {
  if (!state.token) return flash('Pair first');
  state.mode = 'listen'; voice.frames = []; voice.t0 = Date.now();
  if (!(await bridge.audioControl(true, AudioInputSource.Glasses))) { state.mode = 'glance'; return flash('▲ Microphone not available'); }
  setScreen(listenText(4));
  clearInterval(voice.timer);
  voice.timer = setInterval(() => {
    const left = 4 - (Date.now() - voice.t0) / 1000;
    if (left <= 0) stopTalk(); else setScreen(listenText(Math.ceil(left)));
  }, 500);
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
      voice.frames = []; setScreen(kind === 'still' ? stillText(round) : okText(round));
      if (!(await bridge.audioControl(true, AudioInputSource.Glasses))) break;
      await sleep(3000);
      await bridge.audioControl(false);
      if (state.mode !== 'ok' || ok.run !== mine) return;
      const { text } = await api('/api/voice', { audio: toBase64(joinFrames()) }).catch(() => ({ text: '' }));
      if (ok.run === mine && isOk(text)) {
        answered = true; state.mode = 'glance';
        if (kind === 'still') { motion.reset(); state.stillUnanswered = false; flash('● Thanks'); } else await checkIn();
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
  state.mode = 'think'; setScreen(thinkText());
  await bridge.audioControl(false);
  try {
    const { text } = await api('/api/voice', { audio: toBase64(joinFrames()) });
    if (!text) return cancelClue('Heard nothing. Try again');
    if (/^cancel[.!]?$/i.test(text.trim())) return cancelClue('Cancelled');
    showConfirm(text);
  } catch { cancelClue('▲ Could not hear you. Try again'); }
}

function showConfirm(text) {
  state.mode = 'confirm'; state.pending = text;
  let left = 3; setScreen(confirmText(text, left));
  clearInterval(voice.timer);
  voice.timer = setInterval(() => { left -= 1; if (left <= 0) sendPending(); else setScreen(confirmText(text, left)); }, 1000);
}

async function sendClue(text) {
  try { const r = await api('/api/clue', { text, pos: await pos() }); state.lastClueId = r.id; flash('● Clue sent'); } catch { flash('▲ Not sent. Try again'); }
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
  if (text) await sendClue(text);
}
function cancelClue(msg) {
  ok.run += 1; clearInterval(voice.timer); state.pending = null; state.mode = 'glance';
  bridge.audioControl(false).catch(() => {});
  if (msg) flash(msg); else paint();
}

// ---- quick clues: a list on the lens, one tap ----
async function openPresets() {
  if (!state.token) return flash('Pair first');
  state.mode = 'presets';
  await bridge.rebuildPageContainer({
    containerTotalNum: 1,
    listObject: [{ xPosition: 0, yPosition: 0, width: 576, height: 288, containerID: 2, containerName: 'presets',
      itemContainer: { itemCount: PRESET_CLUES.length, itemName: PRESET_CLUES }, isEventCapture: 1 }],
    menuObject: { menuItems: MENU },
  });
}
async function closePresets() {
  state.mode = 'glance';
  await bridge.rebuildPageContainer(TEXT_PAGE());
}
function flash(msg, ms = 3000) {
  state.flash = msg; paint(); clearTimeout(flashTimer);
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
    state.sync = await api('/api/sync', { pos: await pos() });
    state.syncedAt = Date.now();
    if (state.sync.replies?.length) {
      state.lastReply = state.sync.replies.at(-1).full || state.sync.replies.at(-1).text;
      flash(`Reply: ${state.sync.replies.at(-1).text}`, 8000);
    }
    paint();
  } catch { /* offline: keep the last screen. The server notices if we stay silent. */ }
}

async function checkIn() {
  if (!state.token) return flash('Pair first');
  try { await api('/api/checkin', { pos: await pos() }); flash('● Checked in'); await sync(); }
  catch { flash('▲ Not sent. Try again'); }
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
  state.token = j.token;
  await bridge.setLocalStorage('callout.token', j.token);
  await sync(); await heartbeat();
}

async function onMenu(id) {
  if (state.mode === 'presets') await closePresets();
  else if (state.mode !== 'glance') cancelClue('');
  if (id === 1) checkIn();
  else if (id === 2) startTalk();
  else if (id === 3) openPresets();
  else if (id === 4) flash(state.lastReply ? `Reply: ${state.lastReply}` : 'No reply yet', 6000);
  else if (id === 5) bridge.shutDownPageContainer(1);
  else if (id === 6) addPhoto(true);
  else if (id === 7) addPhoto(false);
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
  if (state.mode === 'listen') { if (click) stopTalk(); else if (swipe || dbl) cancelClue('Cancelled'); return; }
  if (state.mode === 'ok') { if (click) { const still = ok.kind === 'still'; cancelClue(''); if (still) { motion.reset(); state.stillUnanswered = false; flash('● Thanks'); } else checkIn(); } else if (swipe || dbl) cancelClue('Skipped'); return; }
  if (state.mode === 'confirm') { if (click) sendPending(); else if (swipe || dbl) cancelClue('Cancelled'); return; }
  if (state.mode === 'think') return;
  if (state.mode === 'presets') {
    if (dbl) return closePresets();
    if (click && e.listEvent) {
      const name = e.listEvent.currentSelectItemName || PRESET_CLUES[e.listEvent.currentSelectItemIndex ?? 0];
      closePresets().then(() => sendClue(name));
    }
    return;
  }
  if (click) checkIn();                                   // ring or temple tap
  else if (dbl) bridge.shutDownPageContainer(1);          // store rule: system exit dialog
}

async function start() {
  bridge = await waitForEvenAppBridge();
  state.token = (await bridge.getLocalStorage('callout.token')) || null;
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
  setInterval(() => { paint(); watchDue(); }, 1000); setInterval(sync, 5000); setInterval(heartbeat, 30000);
  sync();
}
start();

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
