// Browser preview only: draws the lens, passes button presses to the real glasses app code,
// and shows the practice team's chat.
import { OsEventTypeList as Ev } from '@evenrealities/even_hub_sdk';

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, kids = []) => {
  const n = Object.assign(document.createElement(tag), props);
  n.append(...kids);
  return n;
};

// ---------- the lens ----------
let page = {};
let menu = [];
let picked = 0;
let closed = false;
let emit = () => {};
let typed = null;
let picture = '';
const BRIGHT = [0.35, 0.5, 0.65, 0.82, 1];

function box(c, node) {
  Object.assign(node.style, { left: `${c.xPosition}px`, top: `${c.yPosition}px`, width: `${c.width}px`, height: `${c.height}px`, padding: `${c.paddingLength || 0}px` });
  return node;
}
function draw() {
  const lens = $('lens');
  if (closed) { lens.replaceChildren(el('div', { textContent: 'App closed.\nReload the page to start again.' })); return; }
  const texts = (page.textObject || []).map((c) => {
    const n = box(c, el('div', { textContent: c.content }));
    n.style.opacity = BRIGHT[c.textColor ?? 4];
    return n;
  });
  const lists = (page.listObject || []).map((c) => box(c, el('div', {}, c.itemContainer.itemName.map((name, i) => {
    const b = el('button', { type: 'button', textContent: name, onclick: () => { picked = i; choose(); } });
    b.setAttribute('aria-current', String(i === picked));
    return b;
  }))));
  const images = (page.imageObject || []).map((c) => box(c, el('div', {}, picture ? [el('img', { src: picture, alt: 'Photo from the coordinator', width: c.width, height: c.height })] : [])));
  lens.replaceChildren(...texts, ...lists, ...images);
}
function drawMenu() {
  $('menu').replaceChildren(el('b', { textContent: 'Glasses menu' }), ...menu.filter((m) => !/Photo/.test(m.itemName))
    .map((m) => el('button', { type: 'button', textContent: m.itemName, onclick: () => emit({ menuItemClickEvent: { itemID: m.itemID } }) })));
}
function show(next) {
  page = next;
  picture = '';
  picked = 0;
  if (next.menuObject) menu = next.menuObject.menuItems;
  draw(); drawMenu();
}

// ---------- the microphone, only when the visitor asks for it ----------
let audio = null;
let micTurn = 0;
async function micOpen() {
  const turn = micTurn;
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true } });
  // Closed while the browser was still asking: do not leave the microphone on.
  if (turn !== micTurn) { stream.getTracks().forEach((t) => t.stop()); return; }
  const ctx = new AudioContext({ sampleRate: 16000 });
  const source = ctx.createMediaStreamSource(stream);
  const node = ctx.createScriptProcessor(4096, 1, 1);
  node.onaudioprocess = (e) => {
    const f = e.inputBuffer.getChannelData(0);
    const pcm = new Int16Array(f.length);
    for (let i = 0; i < f.length; i++) pcm[i] = Math.max(-1, Math.min(1, f[i])) * 0x7fff;
    emit({ audioEvent: { audioPcm: new Uint8Array(pcm.buffer), speakerRole: 'self' } });
  };
  source.connect(node); node.connect(ctx.destination);
  audio = { stream, ctx, node };
}
function micClose() {
  micTurn += 1;
  if (!audio) return;
  audio.node.disconnect();
  audio.stream.getTracks().forEach((t) => t.stop());
  audio.ctx.close();
  audio = null;
}

const store = new Map();
globalThis.__lensBridge = {
  createStartUpPageContainer: async (p) => { show(p); return 0; },
  rebuildPageContainer: async (p) => { show(p); return true; },
  textContainerUpgrade: async ({ containerID, content }) => {
    const c = page.textObject?.find((x) => x.containerID === containerID);
    if (!c) return false;
    c.content = content; draw(); return true;
  },
  updateImageRawData: async ({ imageData }) => { picture = URL.createObjectURL(new Blob([new Uint8Array(imageData)], { type: 'image/png' })); draw(); return 'success'; },
  onEvenHubEvent: (cb) => { emit = cb; return () => {}; },
  onDeviceStatusChanged: () => () => {},
  onLaunchSource: (cb) => { cb('appMenu'); return () => {}; },
  audioControl: async (on) => {
    micClose();
    if (!on || !$('usemic').checked) return true;
    try { await micOpen(); return true; } catch { $('state').textContent = 'The microphone is not available. Type your words instead.'; return false; }
  },
  imuControl: async () => true,
  getLocalStorage: async (k) => store.get(k) || '',
  setLocalStorage: async (k, v) => { store.set(k, v); return true; },
  getAppLocation: async () => null,
  captureImageFromCamera: async () => null,
  pickImageFromAlbum: async () => null,
  shutDownPageContainer: async () => { closed = true; micClose(); draw(); return true; },
};

// ---------- gestures ----------
function choose() {
  const list = page.listObject?.[0];
  if (!list) return;
  emit({ listEvent: { currentSelectItemIndex: picked, currentSelectItemName: list.itemContainer.itemName[picked] } });
}
function swipe(step) {
  const list = page.listObject?.[0];
  if (!list) return emit({ sysEvent: { eventType: step < 0 ? Ev.SCROLL_TOP_EVENT : Ev.SCROLL_BOTTOM_EVENT } });
  const n = list.itemContainer.itemName.length;
  picked = Math.max(0, Math.min(n - 1, picked + step));
  draw();
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const actions = {
  tap: () => (page.listObject ? choose() : emit({ sysEvent: {} })),
  up: () => swipe(-1),
  down: () => swipe(1),
  double: () => emit({ sysEvent: { eventType: Ev.DOUBLE_CLICK_EVENT } }),
  async say() {
    const words = $('words').value.trim();
    if (!words) { $('words').focus(); return; }
    $('usemic').checked = false;
    typed = words;
    $('words').value = '';
    emit({ sysEvent: { eventType: Ev.LONG_PRESS_EVENT } });
    await sleep(900);
    emit({ sysEvent: { eventType: Ev.LONG_PRESS_RELEASE_EVENT } });
  },
};
document.addEventListener('click', (e) => { const b = e.target.closest('button[data-do]'); if (b && !closed) actions[b.dataset.do](); });
$('words').addEventListener('keydown', (e) => { if (e.key === 'Enter') actions.say(); });

const hold = $('holdkey');
let holding = false;
const press = () => { if (holding || closed) return; if (!$('usemic').checked) { $('state').textContent = 'Tick "Use my microphone" first, or type your words and press Say it.'; return; } holding = true; typed = null; emit({ sysEvent: { eventType: Ev.LONG_PRESS_EVENT } }); };
const letGo = () => { if (!holding) return; holding = false; emit({ sysEvent: { eventType: Ev.LONG_PRESS_RELEASE_EVENT } }); };
hold.addEventListener('pointerdown', press);
['pointerup', 'pointerleave', 'pointercancel'].forEach((n) => hold.addEventListener(n, letGo));
hold.addEventListener('keydown', (e) => { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) { e.preventDefault(); press(); } });
hold.addEventListener('keyup', letGo);

// Typed words travel with the voice request in place of a recording.
const realFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = (url, init) => {
  if (String(url).endsWith('/api/voice') && !$('usemic').checked) {
    const body = JSON.parse(init.body);
    const words = typed || '';
    typed = null;
    return realFetch(url, { ...init, body: JSON.stringify({ token: body.token, devText: words }) });
  }
  return realFetch(url, init);
};

// ---------- the coordinator's chat ----------
let base = '';
let replyTo = null;
let lastDrawn = '';
let over = false;
function bad(text) { $('state').textContent = text; $('state').classList.add('bad'); }

function drawChat(view) {
  const key = JSON.stringify(view.messages);
  const mins = Math.max(0, Math.ceil(view.endsInMs / 60000));
  if (!over) { $('state').classList.remove('bad'); $('state').textContent = `Practice team ready. Ends in ${mins} min.`; }
  if (key === lastDrawn) return;
  lastDrawn = key;
  const chat = $('chat');
  const atEnd = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 40;
  chat.replaceChildren(...view.messages.map((m) => {
    const who = `${m.from === 'you' ? 'You (coordinator)' : 'Lafiya bot'}${m.pinned ? ' · pinned status board' : ''}${m.reaction ? ` · ${m.reaction}` : ''}`;
    const keys = el('div', { className: 'keys' }, m.buttons.map((b) => el('button', { type: 'button', textContent: b.text, onclick: () => send({ press: b.data, messageId: m.message_id }) })));
    const reply = m.from === 'bot' ? el('button', { type: 'button', className: 'reply', textContent: 'Reply', onclick: () => setReply(m) }) : '';
    const shot = m.photo ? el('img', { src: `data:image/jpeg;base64,${m.photo}`, alt: 'Photo you sent', className: 'shot' }) : '';
    return el('div', { className: `msg ${m.from}` }, [el('small', { textContent: who }), shot, m.text, m.voice ? el('audio', { controls: true, src: `data:audio/mpeg;base64,${m.voice}` }) : '', keys, reply]);
  }));
  if (atEnd) chat.scrollTop = chat.scrollHeight;
}
function setReply(m) {
  replyTo = m?.message_id || null;
  $('replying').hidden = !replyTo;
  if (!replyTo) return;
  $('replying').replaceChildren(`Replying to "${m.text.slice(0, 60)}" `, el('button', { type: 'button', textContent: 'Cancel', onclick: () => setReply(null) }));
  $('line').focus();
}
async function call(path, body) {
  const r = await realFetch(`${base}${path}`, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : undefined);
  const j = await r.json();
  if (!r.ok) throw Object.assign(new Error(j.error || r.status), { status: r.status });
  return j;
}
async function send(body) {
  if (over) return;
  try { const view = await call('/chat', body); $('note').textContent = view.note || ''; drawChat(view); }
  catch (e) { $('note').textContent = e.message; }
}
$('send').addEventListener('submit', (e) => {
  e.preventDefault();
  const say = $('line').value.trim();
  if (!say) return;
  $('line').value = '';
  send({ say, replyTo });
  setReply(null);
});
// A photo is shrunk in the browser before it is sent, as Telegram would do.
$('photo').addEventListener('change', async () => {
  const file = $('photo').files[0];
  $('photo').value = '';
  if (!file) return;
  try {
    const img = await createImageBitmap(file);
    const k = Math.min(1, 320 / img.width);
    const c = el('canvas', { width: Math.round(img.width * k), height: Math.round(img.height * k) });
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    const say = $('line').value.trim();
    $('line').value = '';
    send({ photo: c.toDataURL('image/jpeg', 0.7).split(',')[1], say, replyTo });
    setReply(null);
  } catch { $('note').textContent = 'That file is not a picture this browser can read.'; }
});
async function refresh() {
  try { drawChat(await call('/chat')); }
  catch (e) {
    if (e.status === 404) { over = true; closed = true; draw(); bad('This practice team has ended. Reload the page for a new one.'); return; }
    bad('Cannot reach the server. Retrying.');
  }
  setTimeout(refresh, 1500);
}

const fit = () => {
  const k = Math.min(1, ($('frame').clientWidth - 16) / 576);
  $('scale').style.transform = `scale(${k})`;
  $('frame').style.height = `${288 * k + 16}px`;
};
addEventListener('resize', fit);
fit();

async function start() {
  const r = await realFetch('/try/new', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  const j = await r.json();
  if (!r.ok) return bad(`Could not start: ${j.error}.`);
  base = `/try/s/${j.id}`;
  localStorage.setItem('callout.server', location.origin + base);
  await import('/try/app/main.js');
  for (let i = 0; i < 100 && !globalThis.callout; i++) await sleep(50);
  await globalThis.callout.pair(j.code); // the page pairs Alex's lens for the visitor
  refresh();
}
start().catch(() => bad('Could not start. Reload the page.'));
