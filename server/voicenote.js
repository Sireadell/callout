// A spoken clue as a Telegram voice message. The glasses send raw audio (16 kHz, 16 bit, one
// channel); Telegram plays MP3, so it is packed here. The result is passed on and never kept.
import { Mp3Encoder } from '@breezystack/lamejs';

const RATE = 16000;
const BLOCK = 1152;
const MAX_BYTES = RATE * 2 * 12; // a little over the longest hold

// Returns null for a recording that is too short to hear or longer than the app can make.
export function pcmToMp3(pcm) {
  if (!pcm || pcm.length < RATE * 2 * 0.3 || pcm.length > MAX_BYTES) return null;
  const samples = new Int16Array(Math.floor(pcm.length / 2));
  for (let i = 0; i < samples.length; i++) samples[i] = pcm.readInt16LE(i * 2);
  const encoder = new Mp3Encoder(1, RATE, 32);
  const out = [];
  for (let i = 0; i < samples.length; i += BLOCK) out.push(Buffer.from(encoder.encodeBuffer(samples.subarray(i, i + BLOCK))));
  out.push(Buffer.from(encoder.flush()));
  return Buffer.concat(out);
}
