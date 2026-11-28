import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { DeviceInfo, DeviceModel, UserInfo } from '@evenrealities/even_hub_sdk';
import { startApp, until } from './harness.js';

const app = await startApp({ storage: {}, device: new DeviceInfo({ model: DeviceModel.G2, sn: 'x' }), user: new UserInfo({ uid: 1, name: 'Ana Maria', avatar: '', country: '' }) });
after(() => app.done());

test('the join screen greets the wearer by first name', async () => {
  await until(() => /Hi Ana, enter your code/.test(app.all()), 4000, 'greeting');
  assert.doesNotMatch(app.all(), /Maria/);
});
