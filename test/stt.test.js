import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeStt, pcmToWav } from '../server/stt.js';

const json = (o, ok = true) => ({ ok, status: ok ? 200 : 500, json: async () => o });

test('wav wrapper has a valid header and the audio after it', () => {
  const pcm = Buffer.alloc(32000, 1);
  const w = pcmToWav(pcm);
  assert.equal(w.length, 44 + 32000);
  assert.equal(w.toString('ascii', 0, 4), 'RIFF');
  assert.equal(w.readUInt32LE(24), 16000);
  assert.equal(w.readUInt32LE(40), 32000);
});

test('uploads, starts, polls until done and returns the text', async () => {
  const calls = [];
  let polls = 0;
  const fetchImpl = async (url, opts = {}) => {
    calls.push(url);
    if (url.endsWith('/upload')) return json({ upload_url: 'https://cdn/x' });
    if (url.endsWith('/transcript')) return json({ id: 't1' });
    if (opts.method === 'DELETE') return json({});
    polls += 1;
    return json(polls < 3 ? { status: 'processing' } : { status: 'completed', text: ' Road blocked ' });
  };
  const stt = makeStt({ apiKey: 'k', fetchImpl, sleep: async () => {} });
  assert.equal(await stt.transcribe(Buffer.alloc(64000)), 'Road blocked');
  assert.equal(polls, 3);
});

test('very short audio is ignored without calling the provider', async () => {
  const stt = makeStt({ apiKey: 'k', fetchImpl: async () => { throw new Error('should not call'); } });
  assert.equal(await stt.transcribe(Buffer.alloc(100)), '');
});

test('missing key and provider errors give plain messages', async () => {
  await assert.rejects(makeStt({}).transcribe(Buffer.alloc(64000)), /not set up/);
  const bad = makeStt({ apiKey: 'k', fetchImpl: async () => json({ status: 'error' }, false), sleep: async () => {} });
  await assert.rejects(bad.transcribe(Buffer.alloc(64000)), /upload/);
});

test('gives up after the wait limit', async () => {
  const fetchImpl = async (url) => (url.endsWith('/upload') ? json({ upload_url: 'u' }) : url.endsWith('/transcript') ? json({ id: 't' }) : json({ status: 'processing' }));
  const stt = makeStt({ apiKey: 'k', fetchImpl, sleep: async () => {}, maxWaitMs: 2000 });
  await assert.rejects(stt.transcribe(Buffer.alloc(64000)), /timed out/);
});

test('the transcript is deleted at the provider once we have the words', async () => {
  const methods = [];
  const fetchImpl = async (url, opts = {}) => {
    methods.push(`${opts.method || 'GET'} ${url.split('/v2/')[1]}`);
    if (url.endsWith('/upload')) return json({ upload_url: 'https://cdn/x' });
    if (url.endsWith('/transcript')) return json({ id: 't9' });
    return json({ status: 'completed', text: 'ok' });
  };
  await makeStt({ apiKey: 'k', fetchImpl, sleep: async () => {} }).transcribe(Buffer.alloc(64000));
  assert.ok(methods.includes('DELETE transcript/t9'));
});

test('a Telegram voice file is uploaded as it is, with no WAV header added', async () => {
  const bodies = [];
  const fetchImpl = async (url, opts = {}) => {
    if (url.endsWith('/upload')) { bodies.push(opts.body); return json({ upload_url: 'https://cdn/x' }); }
    if (url.endsWith('/transcript')) return json({ id: 't2' });
    if (opts.method === 'DELETE') return json({});
    return json({ status: 'completed', text: ' Go to the hall ' });
  };
  const stt = makeStt({ apiKey: 'k', fetchImpl, sleep: async () => {} });
  const ogg = Buffer.from('OggS fake voice');
  assert.equal(await stt.transcribeFile(ogg), 'Go to the hall');
  assert.equal(bodies[0], ogg);
  await assert.rejects(() => makeStt({}).transcribeFile(ogg), /not set up/);
});
