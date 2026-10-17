// URL fragment codec, format v1: "1." + base64url(protobuf Tune message).
// Schema: src/tune.proto. Spec: context/03-url-format.md. Pure, no DOM.
import { TIMES } from './theory.js';
import { defaultTune, capacity, trimToCapacity } from './model.js';

export const VERSION = 1;
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function toB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    const chars = i + 2 < bytes.length ? 4 : i + 1 < bytes.length ? 3 : 2;
    for (let k = 0; k < chars; k++) s += B64[(n >> (18 - 6 * k)) & 63];
  }
  return s;
}

function fromB64(str) {
  const vals = [];
  let dropped = false;
  for (const c of str.replace(/\+/g, '-').replace(/\//g, '_')) {
    const v = B64.indexOf(c);
    if (v < 0) { if (c !== '=') dropped = true; continue; }
    vals.push(v);
  }
  const bytes = [];
  for (let i = 0; i + 1 < vals.length; i += 4) {
    const n = (vals[i] << 18) | (vals[i + 1] << 12) | ((vals[i + 2] ?? 0) << 6) | (vals[i + 3] ?? 0);
    bytes.push((n >> 16) & 255);
    if (i + 2 < vals.length) bytes.push((n >> 8) & 255);
    if (i + 3 < vals.length) bytes.push(n & 255);
  }
  return { bytes, dropped };
}

export const eventCode = e => (e.dur << 9) | (e.rest ? 0 : 1 + (e.oct * 7 + e.step) * 3 + (e.alter + 1));

export function codeEvent(c) {
  const dur = c >> 9, pc = c & 511;
  if (pc === 0) return { rest: true, dur };
  if (pc > 210) return null;
  const d = Math.floor((pc - 1) / 3);
  return { dur, step: d % 7, oct: Math.floor(d / 7), alter: ((pc - 1) % 3) - 1 };
}

export function encode(t) {
  const o = [];
  const varint = n => { while (n > 127) { o.push((n & 127) | 128); n >>>= 7; } o.push(n); };
  const tag = (field, wire) => varint((field << 3) | wire);
  if (t.title) { const b = new TextEncoder().encode(t.title); tag(1, 2); varint(b.length); o.push(...b); }
  if (t.bpm !== 100) { tag(2, 0); varint(t.bpm); }
  if (t.key) { tag(3, 0); varint((t.key << 1) ^ (t.key >> 31)); }
  if (t.clef === 'bass') { tag(4, 0); varint(1); }
  const ti = TIMES.indexOf(t.time);
  if (ti > 0) { tag(5, 0); varint(ti); }
  if (t.measures !== 4) { tag(6, 0); varint(t.measures); }
  if (t.events.length) {
    const p = [];
    let acc = 0, n = 0;
    for (const e of t.events) {
      acc = ((acc << 12) | eventCode(e)) & 0xffffff; n += 12;
      while (n >= 8) { p.push((acc >> (n - 8)) & 255); n -= 8; }
    }
    if (n) p.push((acc << (8 - n)) & 255);
    tag(7, 2); varint(p.length); o.push(...p);
  }
  return `${VERSION}.${toB64(o)}`;
}

/**
 * Lenient decode. Always returns a valid tune.
 * @returns {{tune, repaired: boolean, newer: boolean}}
 */
export function decode(fragment) {
  const tune = defaultTune();
  let repaired = false, newer = false;
  const s = (fragment || '').replace(/^#/, '');
  const m = s.match(/^(\d+)\.(.*)$/s);
  if (!m) return { tune, repaired: s.length > 0, newer };
  if (+m[1] > VERSION) newer = true;
  const { bytes, dropped } = fromB64(m[2]);
  if (dropped) repaired = true;

  let i = 0;
  const varint = () => {
    let v = 0, shift = 0;
    while (i < bytes.length) {
      const b = bytes[i++];
      v += (b & 127) * 2 ** shift; shift += 7;
      if (!(b & 128)) return v;
      if (shift > 35) break;
    }
    throw new Error('truncated');
  };
  const clamp = (v, lo, hi, dflt) => {
    if (!Number.isFinite(v)) { repaired = true; return dflt; }
    if (v < lo || v > hi) { repaired = true; return Math.max(lo, Math.min(hi, v)); }
    return v;
  };
  let eventBytes = [];
  try {
    while (i < bytes.length) {
      const key = varint(), field = Math.floor(key / 8), wire = key & 7;
      if (wire === 0) {
        const v = varint();
        if (field === 2) tune.bpm = v === 0 ? 100 : clamp(v, 40, 240, 100);
        else if (field === 3) tune.key = clamp((v >>> 1) ^ -(v & 1), -7, 7, 0);
        else if (field === 4) tune.clef = v === 1 ? 'bass' : 'treble';
        else if (field === 5) tune.time = TIMES[v] ?? (repaired = true, '4/4');
        else if (field === 6) tune.measures = v === 0 ? 4 : clamp(v, 1, 12, 4);
      } else if (wire === 2) {
        const len = varint();
        const chunk = bytes.slice(i, i + len);
        if (chunk.length < len) repaired = true;
        i += len;
        if (field === 1) tune.title = new TextDecoder().decode(new Uint8Array(chunk)).slice(0, 60);
        else if (field === 7) eventBytes = chunk;
      } else if (wire === 1) i += 8;
      else if (wire === 5) i += 4;
      else { repaired = true; break; }
    }
  } catch { repaired = true; }

  const count = Math.floor((eventBytes.length * 8) / 12);
  for (let k = 0; k < count; k++) {
    const bit = k * 12, b = bit >> 3;
    const word = (eventBytes[b] << 8) | (eventBytes[b + 1] ?? 0);
    const c = bit % 8 === 0 ? word >> 4 : word & 0xfff;
    const e = codeEvent(c);
    if (e) tune.events.push(e); else repaired = true;
  }
  const before = tune.events.length;
  tune.events = trimToCapacity(tune.events, capacity(tune));
  if (tune.events.length !== before) repaired = true;
  return { tune, repaired, newer };
}
