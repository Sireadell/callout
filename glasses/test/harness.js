// Runs the whole lens app in Node against fake glasses and a fake server, so gestures,
// screens and requests can be checked. One app per test file.
import { registerHooks } from 'node:module';
import { OsEventTypeList } from '@evenrealities/even_hub_sdk';

const fake = new URL('./fake-sdk.js', import.meta.url).href;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@evenrealities/even_hub_sdk' && context.parentURL !== fake) return { url: fake, shortCircuit: true };
    return next(specifier, context);
  },
});

export const E = OsEventTypeList;
export const wait = (ms) => new Promise((resolve) => realTimeout(resolve, ms));
const realTimeout = globalThis.setTimeout;

export async function until(check, ms = 4000, label = 'condition') {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (check()) return; await wait(20); }
  throw new Error(`timed out waiting for ${label}`);
}

export const syncReply = (patch = {}) => ({
  runName: 'Elm Street', area: 'Area A1', dueInMs: 600000, step: 0, replies: [], team: [], question: null, ...patch,
});

export async function startApp({ routes = {}, storage = { 'callout.token': 'tok' }, search = '' } = {}) {
  const requests = [];
  const server = {
    '/api/sync': () => syncReply(),
    '/api/heartbeat': () => ({ ok: true }),
    '/api/checkin': () => ({ ok: true }),
    '/api/clue': () => ({ id: 'clue_1' }),
    '/api/backup': () => ({ ok: true }),
    '/api/voice': () => ({ text: '' }),
    ...routes,
  };
  const glasses = {
    boxes: {}, list: null, listText: '', page: null, mic: false, exits: [], storage: new Map(Object.entries(storage)), imu: 0,
    emit: null, launch: null,
    async createStartUpPageContainer(page) { this.show(page); return 0; },
    async rebuildPageContainer(page) { this.show(page); return true; },
    show(page) {
      this.page = page; this.boxes = {};
      this.list = page.listObject?.[0]?.itemContainer.itemName || null;
      for (const t of page.textObject || []) this.boxes[t.containerName] = t.content;
    },
    async textContainerUpgrade({ containerName, content }) { if (!(containerName in this.boxes)) return false; this.boxes[containerName] = content; return true; },
    async audioControl(on) { this.mic = on; return true; },
    async imuControl() { this.imu += 1; return true; },
    async getLocalStorage(k) { return this.storage.get(k) || ''; },
    async setLocalStorage(k, v) { this.storage.set(k, v); return true; },
    async getAppLocation() { return null; },
    async shutDownPageContainer(mode) { this.exits.push(mode); return true; },
    onEvenHubEvent(cb) { this.emit = cb; return () => {}; },
    onDeviceStatusChanged() { return () => {}; },
    onLaunchSource(cb) { this.launch = cb; return () => {}; },
  };
  // App timers must not keep the test process alive.
  const realInterval = globalThis.setInterval;
  globalThis.setInterval = (...a) => realInterval(...a).unref();
  globalThis.setTimeout = (...a) => realTimeout(...a).unref();
  const keep = realInterval(() => {}, 1000);
  globalThis.__bridge = glasses;
  globalThis.window = {};
  globalThis.location = { search };
  globalThis.localStorage = { getItem: () => null };
  globalThis.document = { getElementById: () => null };
  globalThis.fetch = async (url, options = {}) => {
    const path = new URL(url).pathname;
    const body = JSON.parse(options.body || '{}');
    requests.push({ path, body, keepalive: options.keepalive, at: Date.now() });
    if (!server[path]) return { ok: false, status: 404, json: async () => ({ error: 'not found' }) };
    const out = await server[path](body, options);
    if (out?.status) return { ok: false, status: out.status, json: async () => ({ error: out.error }) };
    return { ok: true, status: 200, json: async () => out };
  };
  await import('../src/main.js');
  await until(() => glasses.emit && glasses.page, 4000, 'app start');
  const app = {
    glasses, requests, server,
    sent: (path) => requests.filter((r) => r.path === path),
    all: () => Object.values(glasses.boxes).join('\n'),
    tap: (source) => glasses.emit({ sysEvent: source === undefined ? {} : { eventSource: source } }),
    press: (eventType, source) => glasses.emit({ sysEvent: { eventType, eventSource: source } }),
    pick: (index) => glasses.emit({ listEvent: { currentSelectItemIndex: index, currentSelectItemName: glasses.list?.[index] } }),
    menu: (itemID) => glasses.emit({ menuItemClickEvent: { itemID } }),
    // Hold, speak, let go.
    async say() {
      app.press(E.LONG_PRESS_EVENT);
      await wait(30);
      glasses.emit({ audioEvent: { audioPcm: new Uint8Array(3200) } });
      await wait(600);
      app.press(E.LONG_PRESS_RELEASE_EVENT);
    },
    done() { clearInterval(keep); },
  };
  return app;
}
