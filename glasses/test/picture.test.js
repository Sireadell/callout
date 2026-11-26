import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, syncReply, until, wait, E } from './harness.js';
import { pictureSize, toGrey, MENU, ANSWER_ITEM, PHOTO_ITEM } from '../src/view.js';

let replies = [];
const app = await startApp({
  routes: {
    '/api/sync': () => { const out = replies; replies = []; return syncReply({ replies: out }); },
    '/api/picture': () => ({ image: 'abc' }),
    '/api/confirm': () => ({ ok: true }),
  },
});
after(() => app.done());
const images = [];
window.__lensImage = async () => ({ width: 192, height: 144, bytes: [1, 2, 3] });
app.glasses.updateImageRawData = async (data) => { images.push(data); return 'success'; };
await until(() => /Next check-in/.test(app.all()), 4000, 'main screen');

const send = async (id) => {
  replies = [{ id, by: 'Sam', text: 'This door', full: 'This door', picture: true }];
  await app.menu(1); // a check-in syncs at once
};
const showing = () => Boolean(app.glasses.page.imageObject);

test('a picture keeps its shape inside what the lens takes', () => {
  assert.deepEqual(pictureSize(800, 600), { width: 192, height: 144 });
  assert.deepEqual(pictureSize(1000, 200), { width: 288, height: 58 });
  assert.deepEqual(pictureSize(4000, 10), { width: 288, height: 20 });
  assert.deepEqual([...toGrey(new Uint8ClampedArray([255, 0, 0, 0]))], [76, 76, 76, 255]);
});

test('the menu still fits ten lines with a question and a photo', () => {
  const ids = [...MENU, ANSWER_ITEM, PHOTO_ITEM].map((m) => m.itemID);
  assert.ok(ids.length <= 10);
  assert.equal(new Set(ids).size, ids.length);
});

test('a photo shows on the lens with its caption, and a tap says got it', async () => {
  await send('rep_1');
  await until(() => images.length === 1, 4000, 'picture');
  const page = app.glasses.page;
  assert.equal(page.containerTotalNum, 3);
  assert.equal(page.textObject.filter((t) => t.isEventCapture === 1).length, 1);
  assert.deepEqual([page.imageObject[0].width, page.imageObject[0].height], [192, 144]);
  assert.match(app.glasses.boxes.caption, /Sam: This door/);
  assert.deepEqual(images[0].imageData, [1, 2, 3]);
  await app.tap();
  await until(() => !showing(), 4000, 'closed');
  await until(() => app.sent('/api/confirm').length === 1, 4000, 'got it');
  assert.equal(app.sent('/api/checkin').length, 1, 'the closing tap is not a check-in');
});

test('the menu shows it again, and a swipe closes it without another got it', async () => {
  assert.ok(app.glasses.page.menuObject.menuItems.some((m) => m.itemID === PHOTO_ITEM.itemID));
  await app.menu(PHOTO_ITEM.itemID);
  await until(showing, 4000, 'picture again');
  app.press(E.SCROLL_BOTTOM_EVENT);
  await until(() => !showing(), 4000, 'closed');
  await wait(100);
  assert.equal(app.sent('/api/confirm').length, 1);
});

test('a photo the lens refuses is said so, and the main screen stays', async () => {
  app.glasses.updateImageRawData = async () => 'sendFailed';
  await app.menu(PHOTO_ITEM.itemID);
  await until(() => /could not be shown/.test(app.all()), 4000, 'message');
  assert.equal(showing(), false);
});
