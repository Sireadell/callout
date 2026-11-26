// DEV PANEL ONLY. The real Even Hub SDK, except that the bridge to the glasses is the panel's fake one.
export * from '../glasses/node_modules/@evenrealities/even_hub_sdk/dist/index.js';
export const waitForEvenAppBridge = async () => globalThis.__devpanelBridge;
