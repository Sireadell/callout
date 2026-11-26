// Speech to text. The glasses send raw audio (16 kHz, 16 bit, one channel); we wrap it as a WAV
// file and ask AssemblyAI to transcribe it. The provider is injectable so tests need no network.
const sleepReal = (ms) => new Promise((r) => setTimeout(r, ms));
const RATE = 16000;

export function pcmToWav(pcm, rate = RATE) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

export function makeStt({ apiKey, fetchImpl = fetch, sleep = sleepReal, maxWaitMs = 20000 } = {}) {
  const headers = { authorization: apiKey };
  // Ask the provider to delete the transcript and its audio as soon as we have the words. Best effort.
  const forget = (id) => { Promise.resolve(fetchImpl(`https://api.assemblyai.com/v2/transcript/${id}`, { method: 'DELETE', headers })).catch(() => {}); };
  async function transcribe(pcm) {
    if (!pcm?.length || pcm.length < RATE * 2 * 0.3) { if (!apiKey) throw new Error('speech to text is not set up'); return ''; } // under 0.3 s: nothing to hear
    return transcribeFile(pcmToWav(pcm));
  }
  // Any audio file the provider can read, such as a Telegram voice message (OGG).
  async function transcribeFile(file) {
    if (!apiKey) throw new Error('speech to text is not set up');
    if (!file?.length) return '';
    const up = await fetchImpl('https://api.assemblyai.com/v2/upload', { method: 'POST', headers, body: file });
    if (!up.ok) throw new Error(`upload ${up.status}`);
    const { upload_url } = await up.json();
    const start = await fetchImpl('https://api.assemblyai.com/v2/transcript', {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ audio_url: upload_url, language_code: 'en', speech_models: ['universal'] }),
    });
    if (!start.ok) throw new Error(`transcript ${start.status}`);
    const { id } = await start.json();
    let waited = 0;
    while (waited <= maxWaitMs) {
      const r = await fetchImpl(`https://api.assemblyai.com/v2/transcript/${id}`, { headers });
      const j = await r.json();
      if (j.status === 'completed') { forget(id); return (j.text || '').trim(); }
      if (j.status === 'error') { forget(id); throw new Error('could not transcribe'); }
      await sleep(700); waited += 700;
    }
    throw new Error('speech to text timed out');
  }
  return { transcribe, transcribeFile };
}
