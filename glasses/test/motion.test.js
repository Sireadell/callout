import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeStillness } from '../src/motion.js';
import { stillScreen } from '../src/view.js';

test('still only after samples, and only after the set time with no movement', () => {
  let t = 0;
  const m = makeStillness({ stillMs: 60_000, delta: 0.15, now: () => t });
  assert.equal(m.isStill(), false); // no samples yet
  m.feed({ x: 0, y: 0, z: 1 });
  t = 59_000; m.feed({ x: 0.01, y: 0, z: 1 });
  assert.equal(m.isStill(), false);
  t = 61_000; m.feed({ x: 0.02, y: 0, z: 1 });
  assert.equal(m.isStill(), true);
});

test('real movement resets the clock; bad samples are ignored', () => {
  let t = 0;
  const m = makeStillness({ stillMs: 60_000, now: () => t });
  m.feed({ x: 0, y: 0, z: 1 });
  t = 50_000; m.feed({ x: 0.5, y: 0.3, z: 1 });
  t = 100_000; m.feed({ x: 0.5, y: 0.3, z: 1 });
  assert.equal(m.isStill(), false);
  m.feed(null); m.feed({ x: 'a' });
  t = 111_000; m.feed({ x: 0.5, y: 0.3, z: 1 });
  assert.equal(m.isStill(), true);
  m.reset();
  assert.equal(m.isStill(), false);
});

test('the still prompt is a question and carries no health words', () => {
  const sc = stillScreen(1);
  const t = [...sc.main, sc.hint].join(' ');
  assert.match(t, /Still there\?/);
  assert.doesNotMatch(t, /SOS|emergency|danger|injur|unconscious|\p{Extended_Pictographic}/u);
});
