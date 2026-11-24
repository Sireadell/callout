import { waitForEvenAppBridge, OsEventTypeList, StartUpPageCreateResult, DeviceConnectType, AudioInputSource, AudioSpeakerRole } from '@evenrealities/even_hub_sdk';
import { glanceText, MENU, PRESET_CLUES, listenText, thinkText, confirmText } from './view.js';

const SERVER = localStorage.getItem('callout.server') || 'http://localhost:8787';
const state = { mode: 'glance', screen: '', pending: null, token: null, sync: null, syncedAt: 0, flash: '', device: {}, lastReply: '' };
let bridge;
let flashTimer;

async function api(path, body) {
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

async function stopTalk() {
  if (state.mode !== 'listen') return;
  clearInterval(voice.timer);
  state.mode = 'think'; setScreen(thinkText());
  await bridge.audioControl(false);
  const total = voice.frames.reduce((n, f) => n + f.length, 0);
  const pcm = new Uint8Array(total);
  let at = 0;
  for (const f of voice.frames) { pcm.set(f, at); at += f.length; }
  try {
    const { text } = await api('/api/voice', { audio: toBase64(pcm) });
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
  try { await api('/api/clue', { text, pos: await pos() }); flash('● Clue sent'); } catch { flash('▲ Not sent. Try again'); }
}
async function sendPending() {
  clearInterval(voice.timer);
  const text = state.pending; state.pending = null; state.mode = 'glance';
  if (text) await sendClue(text);
}
function cancelClue(msg) {
  clearInterval(voice.timer); state.pending = null; state.mode = 'glance';
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
      state.lastReply = state.sync.replies.at(-1).text;
      flash(`Reply: ${state.lastReply}`, 8000);
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
    await api('/api/heartbeat', { battery: d.batteryLevel, charging: d.isCharging, inCase: d.isInCase, worn: d.isWearing, pos: await pos() });
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
}

function onEvent(e) {
  if (e.audioEvent) {
    // Self-speech filter: keep the wearer's voice, drop frames the app classes as someone else.
    if (state.mode === 'listen' && e.audioEvent.speakerRole !== AudioSpeakerRole.Other) voice.frames.push(e.audioEvent.audioPcm);
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
  bridge.onDeviceStatusChanged((s) => { state.device = s; if (s.connectType === DeviceConnectType.Connected) heartbeat(); });
  window.callout = { pair, sync, checkIn };
  // Local testing: open the page with ?code=XXXX to pair without typing.
  const urlCode = new URLSearchParams(location.search).get('code');
  if (urlCode && !state.token) await pair(urlCode.toUpperCase()).catch(() => {});
  setInterval(paint, 1000); setInterval(sync, 5000); setInterval(heartbeat, 30000);
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
