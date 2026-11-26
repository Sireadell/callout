import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, syncReply, until } from './harness.js';

const app = await startApp({ routes: { '/api/sync': () => syncReply({ quickClues: ['Gate locked', 'No answer'] }) } });
after(() => app.done());
await until(() => /Next check-in/.test(app.all()), 4000, 'main screen');

test("the quick clue page shows the run's list and a tap sends that entry", async () => {
  app.menu(3);
  await until(() => app.glasses.list, 4000, 'list');
  assert.deepEqual(app.glasses.list, ['Gate locked', 'No answer']);
  app.glasses.emit({ listEvent: { currentSelectItemIndex: 1 } });
  await until(() => app.sent('/api/clue').length === 1, 4000, 'clue');
  assert.equal(app.sent('/api/clue')[0].body.text, 'No answer');
});
