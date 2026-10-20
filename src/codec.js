// URL fragment codec: "<version>." + base64url(protobuf Tune message).
// Writes v2 (notes in the compact bit-stream voice of src/voice.js) and reads v1 and v2.
// Schema: src/tune.proto. Spec: DESIGN.md, "URL format". Pure, no DOM.
import { TIMES } from './theory.js';
import { defaultTune, capacity, trimToCapacity, MAX_MEASURES } from './model.js';
import { planVoice, writeVoice, parseVoice, resolveVoice } from './voice.js';

import { INSTRUMENTS, instrumentIndex } from './instruments.js';
export const VERSION = 2;
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

/** Unpack a v1 bit stream of 12-bit words, big-endian. */
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

export function encode(t) {
  const o = [];
  const varint = n => writeVarint(o, n);
  const tag = (field, wire) => varint((field << 3) | wire);
  const bytes = (field, b) => { tag(field, 2); varint(b.length); for (const x of b) o.push(x); };
  if (t.title) bytes(1, new TextEncoder().encode(t.title));
  if (t.bpm !== 100) { tag(2, 0); varint(t.bpm); }
  if (t.key) { tag(3, 0); varint((t.key << 1) ^ (t.key >> 31)); }
  if (t.clef === 'bass') { tag(4, 0); varint(1); }
  const ti = TIMES.indexOf(t.time);
  if (ti > 0) { tag(5, 0); varint(ti); }
  if (t.measures !== 4) { tag(6, 0); varint(t.measures); }
  const ins = instrumentIndex(t.instrument);
  if (ins) { tag(11, 0); varint(ins); }
  if (t.arranger) bytes(12, new TextEncoder().encode(t.arranger));
  // Field 10: the first staff's voice. Field 9: Staff { Clef clef = 1; bytes voice = 4; },
  // present (even if empty) when the tune has a second staff; its voice may copy from the first.
  if (t.events.length) bytes(10, writeVoice(planVoice(t.events, t.key, t.clef)));
  if (t.staff2) {
    const sub = [];
    if (t.staff2.clef === 'bass') { writeVarint(sub, 1 << 3); writeVarint(sub, 1); }
    if (t.staff2.events.length) {
      const voice = writeVoice(planVoice(t.staff2.events, t.key, t.staff2.clef, t.events));
      writeVarint(sub, (4 << 3) | 2); writeVarint(sub, voice.length); for (const x of voice) sub.push(x);
    }
    bytes(9, sub);
  }
  return `${VERSION}.${toB64(o)}`;
}

/**
 * Lenient decode of a v1 or v2 fragment. Always returns a valid tune.
 * Links from a newer version are read as v2 and flagged `newer`.
 * @returns {{tune, repaired: boolean, newer: boolean, version: number}}
 */
export function decode(fragment) {
  const tune = defaultTune();
  let repaired = false, newer = false;
  const s = (fragment || '').replace(/^#/, '');
  const m = s.match(/^(\d+)\.(.*)$/s);
  if (!m) return { tune, repaired: s.length > 0, newer, version: VERSION };
  const version = +m[1];
  if (version > VERSION) newer = true;
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
  let eventBytes = [], voiceBytes = null;
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
        else if (field === 11) { if (v > 0 && v < INSTRUMENTS.length) tune.instrument = INSTRUMENTS[v].id; else if (v) repaired = true; }
        else if (field === 6) tune.measures = v === 0 ? 4 : clamp(v, 1, MAX_MEASURES, 4);
      } else if (wire === 2) {
        const len = varint();
        const chunk = bytes.slice(i, i + len);
        if (chunk.length < len) repaired = true;
        i += len;
        if (field === 1) tune.title = new TextDecoder().decode(new Uint8Array(chunk)).slice(0, 60);
        else if (field === 12) tune.arranger = new TextDecoder().decode(new Uint8Array(chunk)).slice(0, 60);
        else if (field === 7) eventBytes = chunk;
        else if (field === 8) chordChunks.push(chunk);
        else if (field === 9) staff2Chunk = chunk;
        else if (field === 10) voiceBytes = chunk;
      } else if (wire === 1) i += 8;
      else if (wire === 5) i += 4;
      else { repaired = true; break; }
    }
  } catch { repaired = true; }

  const cap = capacity(tune);
  let first, second = null;
  if (version === 1) {
    first = readVoice(eventBytes, chordChunks, cap);
    if (staff2Chunk) {
      const st = decodeStaff(staff2Chunk);
      second = st ? { clef: st.clef, ...readVoice(st.eventBytes, st.chordChunks, cap) } : false;
    }
  } else {
    // v2: copies in the second staff may reach back into the first, so resolve it untrimmed.
    const v1 = resolveVoice(parseVoice(voiceBytes || []), tune.key, tune.clef);
    const events1 = trimToCapacity(v1.events, cap);
    first = { events: events1, repaired: v1.repaired || events1.length < v1.events.length };
    if (staff2Chunk) {
      const st = decodeStaff(staff2Chunk);
      if (!st) second = false;
      else {
        const v2 = resolveVoice(parseVoice(st.voiceBytes || []), tune.key, st.clef, v1.events);
        const events = trimToCapacity(v2.events, cap);
        second = { clef: st.clef, events, repaired: v2.repaired || events.length < v2.events.length };
      }
    }
  }
  tune.events = first.events;
  if (first.repaired) repaired = true;
  if (second === false) { repaired = true; tune.staff2 = { clef: 'treble', events: [] }; }
  else if (second) {
    tune.staff2 = { clef: second.clef, events: second.events };
    if (second.repaired) repaired = true;
  }
  return { tune, repaired, newer, version };
}

/** v1: events (field 7 style) plus their chord tones; trimmed to `cap`. */
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

/** Decode the Staff sub-message (field 9, v1 and v2); returns null if malformed. */
function decodeStaff(bytes) {
  let i = 0, clef = 'treble', eventBytes = [], voiceBytes = null;
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
        if (field === 2) eventBytes = c; else if (field === 3) chordChunks.push(c); else if (field === 4) voiceBytes = c;
      } else return null;
    }
  } catch { return null; }
  return { clef, eventBytes, chordChunks, voiceBytes };
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
