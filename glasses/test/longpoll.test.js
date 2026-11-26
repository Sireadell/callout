import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, syncReply, until, wait } from './harness.js';

// A server that holds a long poll until something changes, as INTERFACE describes.
let rev = 1; let pending = []; let broken = false;
const waiting = [];
const answer = () => { const replies = pending; pending = []; return syncReply({ rev, replies }); };
const app = await startApp({
  routes: {
    '/api/sync': (b, options) => {
      if (broken) throw new TypeError('network down');
      if (!b.wait || b.rev !== rev) return answer();
      return new Promise((resolve) => {
        waiting.push(() => resolve(answer()));
        options.signal.addEventListener('abort', () => resolve(syncReply({ rev })));
      });
    },
  },
});
after(() => app.done());
const longs = () => app.sent('/api/sync').filter((r) => r.body.wait);

test('one long poll stays open and the plain poll steps back', async () => {
  await until(() => longs().length >= 2, 5000, 'held long poll');
  assert.equal(longs()[0].body.rev, -1);
  assert.equal(longs()[1].body.rev, 1);
  const plain = () => app.sent('/api/sync').length - longs().length;
  const before = plain();
  await wait(5500);
  assert.equal(longs().length, 2);
  assert.equal(plain(), before);
});

test('a reply reaches the lens as soon as the server has it', async () => {
  pending = [{ id: 'rep_1', text: 'Come back to the van', by: 'Sam' }]; rev += 1;
  const sentAt = Date.now();
  waiting.splice(0).forEach((go) => go());
  await until(() => /Come back to the van/.test(app.all()), 1000, 'reply');
  assert.ok(Date.now() - sentAt < 1000);
  assert.match(app.all(), /got it/);
});

test('when the long poll fails, the 5 second poll takes over', async () => {
  await wait(1200);
  broken = true;
  waiting.splice(0).forEach((go) => go());
  await wait(300);
  const before = app.sent('/api/sync').filter((r) => !r.body.wait).length;
  await until(() => app.sent('/api/sync').filter((r) => !r.body.wait).length > before, 12000, 'plain poll');
});
