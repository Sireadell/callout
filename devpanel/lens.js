// DEV PANEL ONLY. Runs the real glasses app (glasses/src/main.js) in Node against a local server.
// Only the bridge to the glasses is fake: this file plays the part of the glasses and the phone.
// One lens per process, because the app keeps its state in the module.
import fs from 'node:fs';
import { registerHooks } from 'node:module';

const SDK = '@evenrealities/even_hub_sdk';
const realNow = Date.now.bind(Date);

export async function startLens({ server }) {
  if (!fs.existsSync(new URL(`../glasses/node_modules/${SDK}`, import.meta.url))) {
    throw new Error('The glasses SDK is not installed. Run "npm ci" inside the glasses folder first.');
  }
  const lens = { text: '', list: null, menu: [], mic: false, exited: false, signal: true, position: null, clockOffsetMs: 0, device: { connectType: 'connected', batteryLevel: 90, isCharging: false, isInCase: false, isWearing: true } };
  const store = new Map();
  let onEvent = () => {};
  let onStatus = () => {};

  // A page is some text boxes, a list, or both. Boxes are shown top to bottom in the order given.
  let parts = new Map();
  const redraw = () => { lens.text = [...parts.values()].filter((t) => String(t).trim()).join('\n'); };
  const show = (page) => {
    if (page.menuObject) lens.menu = page.menuObject.menuItems;
    lens.list = page.listObject?.[0]?.itemContainer.itemName || null;
    parts = new Map((page.textObject || []).map((t) => [t.containerID, t.content]));
    redraw();
  };
  const bridge = {
    createStartUpPageContainer: async (page) => { show(page); return 0; },
    rebuildPageContainer: async (page) => { show(page); return true; },
    textContainerUpgrade: async ({ containerID, content }) => { if (!parts.has(containerID)) return false; parts.set(containerID, content); redraw(); return true; },
    onEvenHubEvent: (cb) => { onEvent = cb; return () => {}; },
    onDeviceStatusChanged: (cb) => { onStatus = cb; return () => {}; },
    onLaunchSource: (cb) => { cb('appMenu'); return () => {}; },
    audioControl: async (on) => { lens.mic = on; return true; },
    imuControl: async () => true,
    getLocalStorage: async (k) => store.get(k) || '',
    setLocalStorage: async (k, v) => { store.set(k, v); return true; },
    getAppLocation: async () => (lens.position ? { latitude: lens.position.lat, longitude: lens.position.lng } : null),
    captureImageFromCamera: async () => null,
    pickImageFromAlbum: async () => null,
    shutDownPageContainer: async () => { lens.exited = true; return true; },
  };
  // A bridge call this file does not know yet does nothing, and says so, instead of stopping the app.
  globalThis.__devpanelBridge = new Proxy(bridge, {
    get(target, name) {
      if (name in target || typeof name !== 'string' || name === 'then') return target[name];
      console.warn(`dev panel: the fake glasses do not know "${name}" yet`);
      return name.startsWith('on') ? () => () => {} : async () => undefined;
    },
  });

  // "No signal": the app's calls to the server fail the way a dead connection fails.
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, init) => (!lens.signal && String(url).startsWith(server) ? Promise.reject(new TypeError('fetch failed')) : realFetch(url, init));
  // The lens clock can be moved, so five quiet minutes do not take five minutes. The server clock is not touched.
  Date.now = () => realNow() + lens.clockOffsetMs;

  // Load the SDK before there is a "window". With one, it swaps Node's timers for browser ones,
  // which breaks the network calls of this process.
  const fakeSdk = new URL('./fake-sdk.js', import.meta.url).href;
  await import(fakeSdk);
  globalThis.window = globalThis;
  globalThis.document = { readyState: 'complete', addEventListener() {}, getElementById: () => null };
  globalThis.location = { search: '' };
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (k) => (k === 'callout.server' ? server : null), setItem() {} } });

  registerHooks({
    resolve(specifier, context, next) {
      if (specifier === SDK && /\/glasses\/src\//.test(context.parentURL || '')) return { url: fakeSdk, shortCircuit: true };
      return next(specifier, context);
    },
  });
  await import(new URL('../glasses/src/main.js', import.meta.url).href);
  for (let i = 0; i < 100 && !globalThis.callout; i++) await new Promise((r) => setTimeout(r, 50));
  if (!globalThis.callout) throw new Error('the glasses app did not start');

  const sample = (x) => onEvent({ sysEvent: { imuData: { x, y: 0, z: 1 } } });
  return Object.assign(lens, {
    pair: (code) => globalThis.callout.pair(code),
    tap: () => onEvent({ sysEvent: {} }),
    swipe: () => onEvent({ sysEvent: { eventType: 1 } }),
    // Long press and let go. An app that does not use them ignores both.
    hold: () => onEvent({ sysEvent: { eventType: 9 } }),
    release: () => onEvent({ sysEvent: { eventType: 10 } }),
    // Picks a menu line by its words, so a renumbered menu still works.
    chooseMenu(words) {
      const item = lens.menu.find((m) => words.test(m.itemName));
      if (!item) throw new Error(`no menu line matching ${words}`);
      return onEvent({ menuItemClickEvent: { itemID: item.itemID } });
    },
    chooseList(index = 0) {
      if (!lens.list) throw new Error('no list on the lens');
      return onEvent({ listEvent: { currentSelectItemIndex: index, currentSelectItemName: lens.list[index] } });
    },
    setDevice(patch) { Object.assign(lens.device, patch); onStatus({ ...lens.device }); },
    // Head movement samples as the glasses would send them.
    move() { sample(0); sample(1); },
    noMovementFor(minutes) { sample(1); lens.clockOffsetMs += minutes * 60_000 + 1000; sample(1); globalThis.callout.sync(); }, // sync at once, or the moved clock looks like lost signal
    // Puts the lens clock back to now and counts as movement.
    resetClock() { lens.clockOffsetMs = 0; sample(0); sample(1); },
  });
}
