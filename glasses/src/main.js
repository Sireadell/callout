import { waitForEvenAppBridge, OsEventTypeList, StartUpPageCreateResult, DeviceConnectType } from '@evenrealities/even_hub_sdk';
import { glanceText, MENU } from './view.js';

const SERVER = localStorage.getItem('callout.server') || 'http://localhost:8787';
const state = { token: null, sync: null, syncedAt: 0, flash: '', device: {}, lastReply: '' };
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
  if (!bridge) return;
  await bridge.textContainerUpgrade({ containerID: 1, containerName: 'main', content: glanceText(state) });
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

function onEvent(e) {
  if (e.menuItemClickEvent) {
    const id = e.menuItemClickEvent.itemID;
    if (id === 1) checkIn();
    else if (id === 2) flash(state.lastReply ? `Reply: ${state.lastReply}` : 'No reply yet', 6000);
    else if (id === 3) bridge.shutDownPageContainer(1);
    return;
  }
  const ev = e.textEvent || e.sysEvent || e.listEvent;
  if (!ev) return;
  // A plain tap arrives with no eventType (click is code 0, which the host leaves out).
  const t = ev.eventType ?? OsEventTypeList.CLICK_EVENT;
  if (t === OsEventTypeList.CLICK_EVENT) checkIn(); // ring or temple tap
  else if (t === OsEventTypeList.DOUBLE_CLICK_EVENT) bridge.shutDownPageContainer(1);   // store rule: system exit dialog
  else if (t === OsEventTypeList.FOREGROUND_ENTER_EVENT) { sync(); heartbeat(); }
}

async function start() {
  bridge = await waitForEvenAppBridge();
  state.token = (await bridge.getLocalStorage('callout.token')) || null;
  const res = await bridge.createStartUpPageContainer({
    containerTotalNum: 1,
    textObject: [{ xPosition: 0, yPosition: 0, width: 576, height: 288, containerID: 1, containerName: 'main', content: glanceText(state), isEventCapture: 1 }],
    menuObject: { menuItems: MENU },
  });
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
