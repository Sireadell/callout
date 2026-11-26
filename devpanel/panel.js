// DEV PANEL ONLY. A local web page that drives the real glasses app with fake device input.
// Run it with: node devpanel/panel.js   then open http://127.0.0.1:8790
import http from 'node:http';
import fs from 'node:fs';
import { startRig, GROUP } from './rig.js';

const PORT = Number(process.env.DEVPANEL_PORT || 8790);
const rig = await startRig({ silentSeconds: 60, onServerLine: (s) => console.log(`[server] ${s}`) });
const { lens } = rig;
const POSITIONS = { posA: { lat: 51.50722, lng: -0.1275 }, posB: { lat: 51.50901, lng: -0.1246 } };
let ben = false;

const actions = {
  tap: () => lens.tap(),
  swipe: () => lens.swipe(),
  hold: () => lens.hold(),
  release: () => lens.release(),
  menu: ({ index }) => { const m = lens.menu.find((x) => x.itemID === index); if (m) lens.chooseMenu(new RegExp(`^${m.itemName.replace(/[^\w ]/g, '.')}$`)); },
  list: ({ index }) => lens.chooseList(index),
  press: ({ index, data }) => rig.press(index, String(data)),
  battery10: () => lens.setDevice({ batteryLevel: 10, isCharging: false }),
  batteryCharge: () => lens.setDevice({ batteryLevel: 80, isCharging: true }),
  off: () => lens.setDevice({ isWearing: false, isCharging: false, isInCase: false }),
  on: () => lens.setDevice({ isWearing: true }),
  still: () => lens.noMovementFor(5),
  move: () => lens.resetClock(),
  signalOff: () => { lens.signal = false; },
  signalOn: () => { lens.signal = true; },
  posA: () => { lens.position = POSITIONS.posA; },
  posB: () => { lens.position = POSITIONS.posB; },
  posNone: () => { lens.position = null; },
  async ben() {
    if (ben) throw new Error('already added');
    ben = true;
    const { token } = await rig.api('/api/pair', { code: await rig.addVolunteer('Ben', 'Area A2') });
    await rig.api('/api/checkin', { token, pos: POSITIONS.posB });
  },
  end: () => rig.say('/end clear'),
};

function chat() {
  return rig.sent.filter((m) => rig.textOf(m) || m.method.startsWith('send') || m.method === 'deleteMessage').slice(-30).reverse().map((m) => ({
    time: m.at.toLocaleTimeString(), method: m.method, messageId: m.messageId,
    chat: m.body.chat_id === GROUP ? 'group' : `chat ${m.body.chat_id}`,
    loud: m.body.disable_notification === false,
    text: rig.textOf(m) || (m.body.latitude !== undefined ? `${m.body.latitude}, ${m.body.longitude}` : `message ${m.body.message_id}`),
    buttons: (m.body.reply_markup?.inline_keyboard || []).flat().filter((b) => b.callback_data).map((b) => ({ text: b.text, data: b.callback_data })),
  }));
}

const send = (res, code, type, body) => { res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' }); res.end(body); };
http.createServer((req, res) => {
  // Only this computer, and only this page: another website cannot send a JSON post here.
  if (!/^(127\.0\.0\.1|localhost):\d+$/.test(req.headers.host || '')) return send(res, 403, 'text/plain', 'local only');
  if (req.method === 'GET' && req.url === '/') return send(res, 200, 'text/html; charset=utf-8', fs.readFileSync(new URL('./panel.html', import.meta.url)));
  if (req.method === 'GET' && req.url === '/state') {
    return send(res, 200, 'application/json', JSON.stringify({ text: lens.text, list: lens.list, menu: lens.menu, mic: lens.mic, signal: lens.signal, position: lens.position, clockOffsetMs: lens.clockOffsetMs, exited: lens.exited, miniApp: rig.miniAppUrl(), chat: chat() }));
  }
  if (req.method === 'POST' && req.url === '/act' && req.headers['content-type'] === 'application/json') {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 4096) req.destroy(); });
    req.on('end', async () => {
      try {
        const body = JSON.parse(raw);
        if (!Object.hasOwn(actions, body.name)) throw new Error('unknown action');
        await actions[body.name](body);
        send(res, 200, 'application/json', '{"ok":true}');
      } catch (e) { send(res, 400, 'application/json', JSON.stringify({ error: e.message })); }
    });
    return;
  }
  send(res, 404, 'text/plain', 'not found');
}).listen(PORT, '127.0.0.1', () => console.log(`\nDev panel: http://127.0.0.1:${PORT}  (fake glasses input, fake Telegram. Ctrl+C stops it.)`));
