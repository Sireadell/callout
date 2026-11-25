import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { makeAi, trimLine, debriefFacts } from '../server/ai.js';
import { makeSheet, parseSheetId } from '../server/sheet.js';

test('trimLine keeps a short first sentence and cuts a long one at a word', () => {
  assert.equal(trimLine('Move to the gate. Then wait.'), 'Move to the gate.');
  const t = trimLine('Please walk north along the river path until you reach the old stone bridge and wait there');
  assert.ok(t.length <= 60 && t.endsWith('...'));
});

test('oneLine passes short text through and never calls the network', async () => {
  let calls = 0;
  const ai = makeAi({ anthropicKey: 'k', fetchImpl: async () => { calls++; return { ok: true, json: async () => ({}) }; } });
  assert.equal(await ai.oneLine('Return to base'), 'Return to base');
  assert.equal(calls, 0);
});

test('oneLine uses the model answer, and falls back to trimming on failure', async () => {
  const long = 'Please walk north along the river path until you reach the old stone bridge and wait there for the boat crew';
  const good = makeAi({ anthropicKey: 'k', fetchImpl: async (url, init) => {
    assert.match(url, /anthropic\.com/);
    assert.equal(JSON.parse(init.body).messages[0].content, long);
    return { ok: true, json: async () => ({ content: [{ text: '"Wait at old stone bridge"' }] }) };
  } });
  assert.equal(await good.oneLine(long), 'Wait at old stone bridge');
  const bad = makeAi({ anthropicKey: 'k', fetchImpl: async () => ({ ok: false, status: 500 }) });
  assert.ok((await bad.oneLine(long)).endsWith('...'));
});

test('openrouter is used when only that key is set', async () => {
  const ai = makeAi({ openrouterKey: 'o', fetchImpl: async (url) => {
    assert.match(url, /openrouter\.ai/);
    return { ok: true, json: async () => ({ choices: [{ message: { content: 'Two clues, no missed check-ins.' } }] }) };
  } });
  const d = { run: 'R', startedAt: 0, endedAt: 600000, volunteers: [{ name: 'Ana', area: 'A1', checkins: 3, missedNotices: 0 }], clues: [{ by: 'Ana', text: 'House empty', pos: null, at: 1 }] };
  assert.equal(await ai.debrief(d), 'Two clues, no missed check-ins.');
});

test('the debrief facts hold no names and no positions', () => {
  const d = { run: 'Elm', startedAt: 0, endedAt: 1_200_000, volunteers: [{ name: 'Ana Smith', area: 'A1', checkins: 4, missedNotices: 1 }], clues: [{ by: 'Ana Smith', text: 'Road blocked', pos: { lat: 51.5, lng: -0.1 }, at: 1 }] };
  const f = debriefFacts(d);
  assert.doesNotMatch(f, /Ana|Smith|51\.5|Elm/);
  assert.match(f, /Road blocked/);
  assert.match(f, /20 minutes/);
});

test('with no clues the debrief summary is skipped', async () => {
  const ai = makeAi({ anthropicKey: 'k', fetchImpl: async () => { throw new Error('should not be called'); } });
  assert.equal(await ai.debrief({ clues: [], volunteers: [] }), '');
});

test('sheet link or bare id is parsed', () => {
  const id = 'abcDEF1234567890abcDEF1234567890';
  assert.equal(parseSheetId(`https://docs.google.com/spreadsheets/d/${id}/edit#gid=0`), id);
  assert.equal(parseSheetId(id), id);
  assert.equal(parseSheetId('hello'), null);
});

function fakeGoogle() {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const calls = [];
  const tabs = new Set(['Volunteers']);
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    if (url.includes('oauth2.googleapis.com')) {
      const jwt = new URLSearchParams(init.body).get('assertion');
      const [h, c, s] = jwt.split('.');
      assert.ok(createVerify('RSA-SHA256').update(`${h}.${c}`).verify(publicKey, s, 'base64url'), 'jwt signature');
      assert.equal(JSON.parse(Buffer.from(c, 'base64url')).iss, 'bot@x.iam');
      return { ok: true, json: async () => ({ access_token: 'T', expires_in: 3600 }) };
    }
    assert.equal(init.headers.authorization, 'Bearer T');
    if (url.includes('/values/Volunteers')) return { ok: true, json: async () => ({ values: [['Name', 'Area'], ['Ana', 'A1'], ['', 'x'], ['Ben', 'B2']] }) };
    if (url.includes('fields=sheets.properties.title')) return { ok: true, json: async () => ({ sheets: [...tabs].map((title) => ({ properties: { title } })) }) };
    if (url.includes(':batchUpdate')) { tabs.add(JSON.parse(init.body).requests[0].addSheet.properties.title); return { ok: true, json: async () => ({}) }; }
    if (url.includes(':append')) return { ok: true, json: async () => ({}) };
    return { ok: false, status: 404 };
  };
  return { privateKey, calls, tabs, fetchImpl };
}

test('sheet in: reads volunteers, skips header and blank rows', async () => {
  const g = fakeGoogle();
  const sheet = makeSheet({ serviceAccount: { client_email: 'bot@x.iam', private_key: g.privateKey.export({ type: 'pkcs8', format: 'pem' }) }, fetchImpl: g.fetchImpl });
  assert.deepEqual(await sheet.readVolunteers('SHEET'), [{ name: 'Ana', area: 'A1' }, { name: 'Ben', area: 'B2' }]);
});

test('sheet out: makes the tabs, writes plain values, no positions, reuses the token', async () => {
  const g = fakeGoogle();
  const sheet = makeSheet({ serviceAccount: { client_email: 'bot@x.iam', private_key: g.privateKey.export({ type: 'pkcs8', format: 'pem' }) }, fetchImpl: g.fetchImpl });
  const d = { run: 'Elm', startedAt: 0, endedAt: 60000, volunteers: [{ name: 'Ana', area: 'A1', checkins: 2, missedNotices: 0, trail: [{ lat: 1, lng: 2 }] }], clues: [{ by: 'Ana', text: '=HYPERLINK("x")', pos: { lat: 1, lng: 2 }, at: 5 }] };
  const r = await sheet.writeDebrief('SHEET', d, 'All good.');
  assert.deepEqual(r, { people: 1, clues: 1 });
  assert.ok(g.tabs.has('Debrief') && g.tabs.has('Clues'));
  const appends = g.calls.filter((c) => c.url.includes(':append'));
  assert.equal(appends.length, 2);
  assert.ok(appends.every((a) => a.url.includes('valueInputOption=RAW')));
  const sent = appends.map((a) => a.init.body).join('');
  assert.doesNotMatch(sent, /"lat"|trail/);
  assert.equal(g.calls.filter((c) => c.url.includes('oauth2')).length, 1);
});

test('an unshared sheet gives a plain error', async () => {
  const g = fakeGoogle();
  const sheet = makeSheet({ serviceAccount: { client_email: 'bot@x.iam', private_key: g.privateKey.export({ type: 'pkcs8', format: 'pem' }) }, fetchImpl: async (u, i) => (u.includes('oauth2') ? g.fetchImpl(u, i) : { ok: false, status: 403 }) });
  await assert.rejects(sheet.readVolunteers('S'), /not shared/);
});

test('a switched-off Sheets API is named plainly, not called "not shared"', async () => {
  const { makeSheet } = await import('../server/sheet.js');
  const { generateKeyPairSync } = await import('node:crypto');
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const sa = { client_email: 'x@y.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
  const fetchImpl = async (url) => url.includes('oauth2')
    ? { ok: true, json: async () => ({ access_token: 'T', expires_in: 3600 }) }
    : { ok: false, status: 403, text: async () => '{"error":{"message":"Google Sheets API has not been used in project 1 before or it is disabled."}}' };
  await assert.rejects(() => makeSheet({ serviceAccount: sa, fetchImpl }).readVolunteers('abc'), /switched off/);
});
