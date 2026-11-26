import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, syncReply, until, wait, E } from './harness.js';
import { questionRows, questionText, MENU, ANSWER_ITEM } from '../src/view.js';

let question = null;
let heard = { text: '' };
const app = await startApp({
  routes: {
    '/api/sync': () => syncReply({ question }),
    '/api/voice': () => heard,
    '/api/answer': (b) => { if (b.questionId !== question?.id) return { status: 400, error: 'unknown question' }; question = null; return { ok: true }; },
  },
});
after(() => app.done());
await until(() => /Next check-in/.test(app.all()), 4000, 'main screen');
const ask = async (id) => {
  question = { id, text: 'How many people?', by: 'Sam', answers: ['None', '1', '2 or more'] };
  await app.menu(1); // a check-in syncs at once
  await until(() => app.glasses.list, 4000, 'question list');
};

test('the list holds up to three answers and Speak, inside the lens limits', () => {
  assert.deepEqual(questionRows({ answers: ['a', 'b', 'c', 'd'] }), ['a', 'b', 'c', 'Speak']);
  assert.ok(questionRows({ answers: ['x'.repeat(40)] })[0].length <= 16);
  assert.ok(questionText({ text: 'word '.repeat(80), by: 'Sam' }).split('\n').length <= 3);
  assert.ok(MENU.length + 1 <= 10);
  assert.ok(!MENU.some((m) => m.itemID === ANSWER_ITEM.itemID));
});

test('a question opens once; an instant tap does not answer it, a second tap does', async () => {
  await ask('q_1');
  assert.deepEqual(app.glasses.list, ['None', '1', '2 or more', 'Speak']);
  app.pick(2);
  await wait(100);
  assert.equal(app.sent('/api/answer').length, 0);
  await wait(800);
  app.pick(2);
  await until(() => app.sent('/api/answer').length === 1, 4000, 'answer');
  assert.deepEqual(app.sent('/api/answer')[0].body, { token: 'tok', questionId: 'q_1', answer: '2 or more' });
  await until(() => /Answer sent/.test(app.all()));
});

test('double press skips it without exiting, and the menu opens it again', async () => {
  await ask('q_2');
  app.press(E.DOUBLE_CLICK_EVENT);
  await until(() => /Question waiting/.test(app.all()), 4000, 'waiting line');
  assert.deepEqual(app.glasses.exits, []);
  assert.ok(app.glasses.page.menuObject.menuItems.some((m) => m.itemID === ANSWER_ITEM.itemID));
  await wait(1200);
  assert.equal(app.glasses.list, null); // not reopened on its own
  app.menu(ANSWER_ITEM.itemID);
  await until(() => app.glasses.list, 4000, 'question list');
});

test('holding on the question speaks the answer, whatever the words sound like', async () => {
  heard = { text: 'all good, two people', intent: { type: 'checkin' } };
  const checkins = app.sent('/api/checkin').length;
  await app.say();
  await until(() => /Your answer:/.test(app.all()), 4000, 'confirm answer');
  app.tap();
  await until(() => app.sent('/api/answer').length === 2, 4000, 'spoken answer');
  assert.equal(app.sent('/api/answer')[1].body.answer, 'all good, two people');
  assert.equal(app.sent('/api/checkin').length, checkins);
  assert.equal(app.sent('/api/clue').length, 0);
});

test('a question replaced on the server closes on the lens and the new one opens', async () => {
  await ask('q_3');
  question = { id: 'q_4', text: 'Is the road open?', by: 'Sam', answers: ['Yes', 'No'] };
  await until(() => app.glasses.list?.includes('Yes'), 8000, 'new question');
});
