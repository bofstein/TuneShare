// MP3 export: render the tune offline with the live playback engine, then encode it with LAME (WASM).
// Loaded on demand from the MP3 button, so neither this file nor the encoder costs anything at startup.
import { tuneNotes, prepareRender, renderSpan } from './audio.js';
import { createEncoder } from '../vendor/wasm-media-encoders/index.mjs';

const WASM_URL = new URL('../vendor/wasm-media-encoders/mp3.wasm', import.meta.url).href;

/**
 * Ways to render, tried in order until one succeeds. A single pass is the most faithful; if the browser
 * can't hold the whole tune in memory (long tunes at slow tempos on phones), render it in pieces,
 * then in smaller pieces, then at half the sample rate in mono as a last resort.
 */
export const RENDER_LEVELS = [
  { name: 'single pass', chunk: Infinity, sampleRate: 44100, channels: 2, bitrate: 192 },
  { name: '60s chunks', chunk: 60, sampleRate: 44100, channels: 2, bitrate: 192 },
  { name: '15s chunks', chunk: 15, sampleRate: 44100, channels: 2, bitrate: 192 },
  { name: '15s chunks, mono 22kHz', chunk: 15, sampleRate: 22050, channels: 1, bitrate: 96 },
];

const FRAME_BLOCK = 1152 * 64; // samples handed to the encoder at a time, keeps its WASM heap small

let encoderPromise = null;
function getEncoder() {
  encoderPromise ??= createEncoder('audio/mpeg', WASM_URL).catch(err => { encoderPromise = null; throw err; });
  return encoderPromise;
}

const tick = () => new Promise(r => setTimeout(r, 0));

/** Encode one rendered span, appending MP3 bytes to `parts`. */
function encodeSpan(enc, { buffer, offset, length }, channels, parts) {
  const data = [];
  for (let ch = 0; ch < channels; ch++) data.push(buffer.getChannelData(ch));
  for (let i = 0; i < length; i += FRAME_BLOCK) {
    const n = Math.min(FRAME_BLOCK, length - i);
    const block = data.map(d => {
      const out = d.slice(offset + i, offset + i + n);
      for (let k = 0; k < n; k++) out[k] = out[k] > 1 ? 1 : out[k] < -1 ? -1 : out[k];
      return out;
    });
    const bytes = enc.encode(block);
    if (bytes.length) parts.push(bytes.slice());
  }
}

/** Render and encode at one level; throws if the browser can't (out of memory, unsupported, …). */
async function renderAt(level, notes, duration, enc, onProgress, failLevel) {
  if (failLevel?.(level)) throw new Error(`Forced failure at ${level.name}`);
  enc.configure({ channels: level.channels, sampleRate: level.sampleRate, bitrate: level.bitrate });
  const parts = [];
  for (let from = 0; from < duration; from += level.chunk) {
    const to = Math.min(duration, from + level.chunk);
    const span = await renderSpan(notes, from, to, level);
    encodeSpan(enc, span, level.channels, parts);
    onProgress(to / duration);
    await tick();
  }
  const last = enc.finalize();
  if (last.length) parts.push(last.slice());
  return parts;
}

/**
 * Render `tune` to an MP3 Blob with the currently selected instrument and sound mode (HD samples or synth).
 * @param opts {{onStage?: (stage:'samples'|'render', fraction:number) => void, failLevel?: (level) => boolean}}
 *   failLevel is for tests: return true to make a level fail and exercise the fallbacks.
 * @returns {Promise<{blob: Blob, level: object, missingSamples: number, seconds: number}>}
 */
export async function toMp3(tune, { onStage = () => {}, failLevel } = {}) {
  const { notes, duration } = tuneNotes(tune);
  if (!notes.length) throw new Error('There are no notes to export.');
  const [enc, { missing }] = await Promise.all([
    getEncoder(),
    prepareRender(tune, f => onStage('samples', f)),
  ]);
  let lastErr = null;
  for (const level of RENDER_LEVELS) {
    try {
      const parts = await renderAt(level, notes, duration, enc, f => onStage('render', f), failLevel);
      return { blob: new Blob(parts, { type: 'audio/mpeg' }), level, missingSamples: missing, seconds: duration };
    } catch (err) {
      lastErr = err;
      console.warn(`MP3 export: ${level.name} failed, trying the next way`, err);
      await tick();
    }
  }
  throw lastErr;
}
