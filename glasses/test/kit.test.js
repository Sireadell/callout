import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { DeviceInfo, DeviceModel, UserInfo } from '@evenrealities/even_hub_sdk';
import { startApp, until } from './harness.js';

const app = await startApp({
  device: new DeviceInfo({ model: DeviceModel.Ring1, sn: 'SN-SECRET-123' }),
  user: new UserInfo({ uid: 7, name: 'Ana Maria Lopez', avatar: 'https://x/a.png', country: 'NG' }),
});
after(() => app.done());

test('the heartbeat carries the model and ring flag, never the serial, name or avatar', async () => {
  await until(() => app.sent('/api/heartbeat').length > 0, 4000, 'heartbeat');
  const raw = JSON.stringify(app.requests.map((r) => r.body));
  assert.deepEqual(app.sent('/api/heartbeat')[0].body.device, { model: 'ring1', ring: true });
  assert.doesNotMatch(raw, /SN-SECRET|Ana|a\.png/);
});
