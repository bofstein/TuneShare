// URL fragment codec, format v1: "1." + base64url(protobuf Tune message).
// Schema: src/tune.proto. Spec: DESIGN.md, "URL format". Pure, no DOM.
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

const pitchCode = p => 1 + (p.oct * 7 + p.step) * 3 + (p.alter + 1);
export const eventCode = e => (e.dur << 9) | (e.rest ? 0 : pitchCode(e));

/** Pack 12-bit words as a big-endian bit stream. */
function pack12(words) {
  const p = [];
  let acc = 0, n = 0;
  for (const w of words) {
    acc = ((acc << 12) | w) & 0xffffff; n += 12;
    while (n >= 8) { p.push((acc >> (n - 8)) & 255); n -= 8; }
  }
  if (n) p.push((acc << (8 - n)) & 255);
  return p;
}

function unpack12(bytes) {
  const out = [];
  for (let k = 0, count = Math.floor((bytes.length * 8) / 12); k < count; k++) {
    const bit = k * 12, b = bit >> 3;
    const word = (bytes[b] << 8) | (bytes[b + 1] ?? 0);
    out.push(bit % 8 === 0 ? word >> 4 : word & 0xfff);
  }
  return out;
}

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
    const p = pack12(t.events.map(eventCode));
    tag(7, 2); varint(p.length); o.push(...p);
  }
  // Field 8: repeated Chord { uint32 index = 1; bytes tones = 2; } — extra pitches per event.
  t.events.forEach((e, index) => {
    if (e.rest || !e.tones?.length) return;
    const sub = [];
    const sv = n => { while (n > 127) { sub.push((n & 127) | 128); n >>>= 7; } sub.push(n); };
    if (index) { sv(1 << 3); sv(index); }
    const tones = pack12(e.tones.map(pitchCode));
    sv((2 << 3) | 2); sv(tones.length); sub.push(...tones);
    tag(8, 2); varint(sub.length); o.push(...sub);
  });
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
  const chordChunks = [];
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
        else if (field === 8) chordChunks.push(chunk);
      } else if (wire === 1) i += 8;
      else if (wire === 5) i += 4;
      else { repaired = true; break; }
    }
  } catch { repaired = true; }

  const indexMap = [];          // raw event position → index in tune.events (skipped codes shift it)
  unpack12(eventBytes).forEach(c => {
    const e = codeEvent(c);
    if (e) { indexMap.push(tune.events.length); tune.events.push(e); } else { indexMap.push(-1); repaired = true; }
  });
  for (const chunk of chordChunks) {
    const ch = decodeChord(chunk);
    const e = tune.events[indexMap[ch?.index] ?? -1];
    if (!ch || !e || e.rest) { repaired = true; continue; }
    const seen = new Set([e.oct * 7 + e.step]);
    const tones = [];
    for (const c of ch.tones) {
      const p = c === 0 ? null : codeEvent(c);
      if (!p || p.rest || seen.has(p.oct * 7 + p.step)) { repaired = true; continue; }
      seen.add(p.oct * 7 + p.step);
      tones.push({ step: p.step, oct: p.oct, alter: p.alter });
    }
    if (tones.length) e.tones = [...(e.tones || []), ...tones];
  }
  const before = tune.events.length;
  tune.events.forEach(e => { if (e.tones && !e.tones.length) delete e.tones; });
  tune.events = trimToCapacity(tune.events, capacity(tune));
  if (tune.events.length !== before) repaired = true;
  return { tune, repaired, newer };
}

/** Decode one Chord sub-message; returns null if malformed. */
function decodeChord(bytes) {
  let i = 0, index = 0, tones = [];
  const varint = () => {
    let v = 0, shift = 0;
    while (i < bytes.length) { const b = bytes[i++]; v += (b & 127) * 2 ** shift; shift += 7; if (!(b & 128)) return v; }
    throw new Error('truncated');
  };
  try {
    while (i < bytes.length) {
      const key = varint(), field = Math.floor(key / 8), wire = key & 7;
      if (wire === 0) { const v = varint(); if (field === 1) index = v; }
      else if (wire === 2) { const len = varint(); const c = bytes.slice(i, i + len); i += len; if (field === 2) tones = unpack12(c); }
      else return null;
    }
  } catch { return null; }
  return { index, tones };
}
