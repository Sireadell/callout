import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, until } from './harness.js';

const boom = () => { throw new Error('not supported'); };
const app = await startApp({ device: boom, user: boom });
after(() => app.done());

test('the app still starts and sends heartbeats when both calls throw', async () => {
  await until(() => app.sent('/api/heartbeat').length > 0, 4000, 'heartbeat');
  assert.equal(app.sent('/api/heartbeat')[0].body.device, undefined);
});
