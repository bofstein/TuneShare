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

export function fromB64(str) {
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

export function unpack12(bytes) {
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

function writeVarint(o, n) { while (n > 127) { o.push((n & 127) | 128); n >>>= 7; } o.push(n); }

/** Packed events in field `evField`, then one Chord sub-message per chord in field `chordField`. */
function writeVoice(o, events, evField, chordField) {
  if (events.length) {
    const p = pack12(events.map(eventCode));
    writeVarint(o, (evField << 3) | 2); writeVarint(o, p.length); o.push(...p);
  }
  // Chord { uint32 index = 1; bytes tones = 2; } — extra pitches per event.
  events.forEach((e, index) => {
    if (e.rest || !e.tones?.length) return;
    const sub = [];
    if (index) { writeVarint(sub, 1 << 3); writeVarint(sub, index); }
    const tones = pack12(e.tones.map(pitchCode));
    writeVarint(sub, (2 << 3) | 2); writeVarint(sub, tones.length); sub.push(...tones);
    writeVarint(o, (chordField << 3) | 2); writeVarint(o, sub.length); o.push(...sub);
  });
}

export function encode(t) {
  const o = [];
  const varint = n => writeVarint(o, n);
  const tag = (field, wire) => varint((field << 3) | wire);
  if (t.title) { const b = new TextEncoder().encode(t.title); tag(1, 2); varint(b.length); o.push(...b); }
  if (t.bpm !== 100) { tag(2, 0); varint(t.bpm); }
  if (t.key) { tag(3, 0); varint((t.key << 1) ^ (t.key >> 31)); }
  if (t.clef === 'bass') { tag(4, 0); varint(1); }
  const ti = TIMES.indexOf(t.time);
  if (ti > 0) { tag(5, 0); varint(ti); }
  if (t.measures !== 4) { tag(6, 0); varint(t.measures); }
  writeVoice(o, t.events, 7, 8);
  // Field 9: Staff staff2 = 9 { Clef clef = 1; bytes events = 2; repeated Chord chords = 3; }.
  // Its presence (even empty) means the tune has a second staff.
  if (t.staff2) {
    const sub = [];
    if (t.staff2.clef === 'bass') { writeVarint(sub, 1 << 3); writeVarint(sub, 1); }
    writeVoice(sub, t.staff2.events, 2, 3);
    tag(9, 2); varint(sub.length); o.push(...sub);
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
  const chordChunks = [];
  let staff2Chunk = null;
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
        else if (field === 9) staff2Chunk = chunk;
      } else if (wire === 1) i += 8;
      else if (wire === 5) i += 4;
      else { repaired = true; break; }
    }
  } catch { repaired = true; }

  const cap = capacity(tune);
  const voice = readVoice(eventBytes, chordChunks, cap);
  tune.events = voice.events;
  if (voice.repaired) repaired = true;
  if (staff2Chunk) {
    const st = decodeStaff(staff2Chunk);
    if (!st) { repaired = true; tune.staff2 = { clef: 'treble', events: [] }; }
    else {
      const v2 = readVoice(st.eventBytes, st.chordChunks, cap);
      tune.staff2 = { clef: st.clef, events: v2.events };
      if (v2.repaired) repaired = true;
    }
  }
  return { tune, repaired, newer };
}

/** Events (field 7 style) plus their chord tones; trimmed to `cap`. */
function readVoice(eventBytes, chordChunks, cap) {
  const events = [];
  let repaired = false;
  const indexMap = [];          // raw event position → index in events (skipped codes shift it)
  unpack12(eventBytes).forEach(c => {
    const e = codeEvent(c);
    if (e) { indexMap.push(events.length); events.push(e); } else { indexMap.push(-1); repaired = true; }
  });
  for (const chunk of chordChunks) {
    const ch = decodeChord(chunk);
    const e = events[indexMap[ch?.index] ?? -1];
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
  const trimmed = trimToCapacity(events, cap);
  if (trimmed.length !== events.length) repaired = true;
  return { events: trimmed, repaired };
}

/** Decode the Staff sub-message (field 9); returns null if malformed. */
function decodeStaff(bytes) {
  let i = 0, clef = 'treble', eventBytes = [];
  const chordChunks = [];
  const varint = () => {
    let v = 0, shift = 0;
    while (i < bytes.length) { const b = bytes[i++]; v += (b & 127) * 2 ** shift; shift += 7; if (!(b & 128)) return v; }
    throw new Error('truncated');
  };
  try {
    while (i < bytes.length) {
      const key = varint(), field = Math.floor(key / 8), wire = key & 7;
      if (wire === 0) { const v = varint(); if (field === 1) clef = v === 1 ? 'bass' : 'treble'; }
      else if (wire === 2) {
        const len = varint(), c = bytes.slice(i, i + len); i += len;
        if (field === 2) eventBytes = c; else if (field === 3) chordChunks.push(c);
      } else return null;
    }
  } catch { return null; }
  return { clef, eventBytes, chordChunks };
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
