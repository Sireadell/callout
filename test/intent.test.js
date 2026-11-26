import { test } from 'node:test';
import assert from 'node:assert/strict';
import { intentOf, isOk } from '../server/intent.js';

const clues = ['All done', 'No answer', 'Spoke to them', 'Access blocked'];
const type = (text) => intentOf(text, clues).type;

test('short check-in words check in', () => {
  for (const t of ['OK', 'Okay.', "I'm OK", 'All good', 'Checking in', 'Yes, here', 'I’m fine, thanks']) assert.equal(type(t), 'checkin', t);
});

test('"not OK", "no", "help" and the like never check anyone in', () => {
  for (const t of ['not OK', "I'm not OK", 'I am not fine', 'No', 'help', 'OK help', "it isn't ok", 'never mind', 'I hurt my leg, ok']) {
    assert.equal(isOk(t), false, t);
    assert.notEqual(type(t), 'checkin', t);
  }
});

test('a clue that happens to contain "here" or "ok" stays a clue', () => {
  for (const t of ['Person here', 'Door is ok', 'Two people here', 'Water is here now']) assert.equal(type(t), 'clue', t);
});

test('quick clue words, backup, cancel and silence', () => {
  assert.deepEqual(intentOf('no answer.', clues), { type: 'quick_clue', clue: 'No answer' });
  for (const t of ['Backup', 'I need backup', 'Can we get back up please']) assert.equal(type(t), 'backup', t);
  assert.equal(type('No backup needed'), 'clue');
  assert.equal(type('Cancel.'), 'cancel');
  assert.equal(type(''), 'none');
});
