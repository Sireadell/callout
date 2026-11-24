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
