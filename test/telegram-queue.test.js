import test from 'node:test';
import assert from 'node:assert/strict';
import { Telegram } from '../server/telegram.js';

test('a send is answered at once, and only the next send to that chat waits for the gap', async () => {
  const calls = []; let release;
  const tg = new Telegram('t', {
    fetchImpl: async () => { calls.push(1); return { json: async () => ({ ok: true, result: { message_id: calls.length } }) }; },
    sleep: () => new Promise((r) => { release = r; }),
  });
  const first = await tg.send(-5, 'one'); // would hang here if the answer waited for the gap
  assert.equal(first.message_id, 1);
  const second = tg.send(-5, 'two');
  await new Promise((r) => setImmediate(r));
  assert.equal(calls.length, 1);
  release();
  assert.equal((await second).message_id, 2);
});
