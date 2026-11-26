// The real toolkit, except that the glasses are the fake ones from harness.js.
export * from '@evenrealities/even_hub_sdk';
export const waitForEvenAppBridge = async () => globalThis.__bridge;
