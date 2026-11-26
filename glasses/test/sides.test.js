import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventSourceType } from '@evenrealities/even_hub_sdk';
import { startApp, syncReply, until, wait } from './harness.js';

let replies = [];
const app = await startApp({ routes: { '/api/sync': () => { const r = replies; replies = []; return syncReply({ replies: r }); } } });
after(() => app.done());
await until(() => /Next check-in/.test(app.all()), 4000, 'main screen');
const { TOUCH_EVENT_FROM_RING: RING, TOUCH_EVENT_FROM_GLASSES_L: LEFT, TOUCH_EVENT_FROM_GLASSES_R: RIGHT } = EventSourceType;
const checkins = () => app.sent('/api/checkin').length;

test('with no reply yet, every side checks in', async () => {
  app.tap(LEFT);
  await until(() => checkins() === 1);
});

test('after a reply, the left temple repeats it and ring and right temple check in', async () => {
  replies = [{ id: 'rep_1', text: 'Head to the school', by: 'Sam' }];
  await app.menu(1);
  await until(() => /Head to the school/.test(app.all()), 4000, 'reply');
  app.tap(RING); // got it
  await until(() => /Left: reply/.test(app.all()), 4000, 'hint');
  const before = checkins();
  app.tap(LEFT);
  await until(() => /Sam: Head to the school/.test(app.all()), 2000, 'repeat');
  await wait(100);
  assert.equal(checkins(), before);
  app.tap(RIGHT);
  await until(() => checkins() === before + 1);
});
