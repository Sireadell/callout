import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, until } from './harness.js';

const app = await startApp({ storage: {} });
after(() => app.done());

test('the app still starts when the methods are missing', async () => {
  await until(() => /Not paired|Join code|Getting/.test(app.all()), 4000, 'join screen');
  assert.doesNotMatch(app.all(), /Hi /);
});
