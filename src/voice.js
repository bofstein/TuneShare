// Voice codec for URL format v2: one staff's events as a bit stream. Pure, no DOM.
// Spec: DESIGN.md, "URL format". Three stages, so the debug view and the decoder share code:
//   planVoice    events → ops        (picks copies, chord shapes and header flags)
//   writeVoice   ops → bytes
//   parseVoice   bytes → ops         (syntax only; lenient, never throws)
//   resolveVoice ops → events        (pitches, durations, copies and shifts worked out)
import { keyAlter } from './theory.js';

export const MAX_VOICE_EVENTS = 320;     // 20 measures of 4/4 in 16ths
const MAX_DIA = 69;                      // highest pitch the 12-bit v1 codes could hold, B9
const SHAPE_CACHE = 8;
const COPY_BITS_PER_EVENT = 8;           // a copy is only used if it is cheaper than this per event

const dia = p => p.oct * 7 + p.step;
const split = d => ({ step: ((d % 7) + 7) % 7, oct: Math.floor(d / 7) });
const startPitch = clef => (clef === 'bass' ? 22 : 34);   // D3 / B4: where the first interval is measured from
const othersOf = (key, step) => [-1, 0, 1].filter(a => a !== keyAlter(key, step));
/** 0 = the alteration the key signature gives this letter, 1 and 2 = the other two. */
const altCode = (key, step, alter) => (alter === keyAlter(key, step) ? 0 : 1 + othersOf(key, step).indexOf(alter));
const altFrom = (key, step, code) => (code === 0 ? keyAlter(key, step) : othersOf(key, step)[code - 1]);

const egBits = n => 2 * (31 - Math.clz32(n + 1)) + 1;
const zigzag = d => (d >= 0 ? 2 * d : -2 * d - 1);
const zzBits = d => egBits(zigzag(d));
const shapeKey = tones => tones.map(t => `${t.delta}:${t.alt}`).join(',');

class BitWriter {
  constructor() { this.bits = []; }
  put(v, n) { for (let i = n - 1; i >= 0; i--) this.bits.push((v >>> i) & 1); }
  /** Exp-Golomb, order 0, n ≥ 0: 0 → "1", 1–2 → "0xx"-style growth. */
  eg(n) { const v = n + 1, len = 31 - Math.clz32(v); this.put(0, len); this.put(v, len + 1); }
  zz(d) { this.eg(zigzag(d)); }
  bytes() {
    const out = [];
    for (let i = 0; i < this.bits.length; i += 8) {
      let b = 0;
      for (let k = 0; k < 8; k++) b = (b << 1) | (this.bits[i + k] ?? 0);
      out.push(b);
    }
    return out;
  }
}

class BitReader {
  constructor(bytes) { this.bytes = bytes; this.pos = 0; this.end = bytes.length * 8; }
  get(n) {
    let v = 0;
    for (let i = 0; i < n; i++) {
      if (this.pos >= this.end) throw new Error('end of data');
      v = (v << 1) | ((this.bytes[this.pos >> 3] >> (7 - (this.pos & 7))) & 1);
      this.pos++;
    }
    return v;
  }
  eg() {
    let len = 0;
    while (this.get(1) === 0) if (++len > 30) throw new Error('number too long');
    return (len ? 2 ** len + this.get(len) : 1) - 1;
  }
  zz() { const n = this.eg(); return n % 2 ? -(n + 1) / 2 : n / 2; }
}

/** Ops → bytes. `voice` is {count, flags: {rest, alt, chords}, ops}. */
export function writeVoice({ count, flags, ops }) {
  const w = new BitWriter();
  w.eg(count);
  w.put(flags.rest ? 1 : 0, 1); w.put(flags.alt ? 1 : 0, 1); w.put(flags.chords ? 1 : 0, 1);
  const alt = a => { if (!flags.alt) return; if (a === 0) w.put(0, 1); else { w.put(1, 1); w.put(a - 1, 1); } };
  for (const op of ops) {
    if (op.op === 'copy') { w.put(0, 1); w.eg(op.dist - 1); w.eg(op.len - 2); w.zz(op.shift); continue; }
    w.put(1, 1);
    if (flags.rest) w.put(op.rest ? 1 : 0, 1);
    if (op.dur === undefined) w.put(0, 1); else { w.put(1, 1); w.put(op.dur, 3); }
    if (op.rest) continue;
    w.zz(op.delta); alt(op.alt);
    if (!flags.chords) continue;
    if (!op.chord) { w.put(0, 1); continue; }
    w.put(1, 1);
    if (op.chord.hit !== undefined) { w.eg(op.chord.hit + 1); continue; }
    w.eg(0); w.eg(op.chord.tones.length - 1);
    for (const t of op.chord.tones) { w.zz(t.delta); alt(t.alt); }
  }
  return w.bytes();
}

/**
 * Bytes → ops. Syntax only: pitches, durations and copies are not worked out here.
 * Lenient: stops at the first problem and says so in `repaired`.
 * @returns {{count: number, flags: object, ops: object[], repaired: boolean, bits: number}} `bits` is how far it read
 */
export function parseVoice(bytes) {
  const out = { count: 0, flags: { rest: false, alt: false, chords: false }, ops: [], repaired: false, bits: 0 };
  if (!bytes.length) return out;          // no voice field: an empty staff
  const r = new BitReader(bytes);
  const cache = [];
  let covered = 0;
  try {
    out.count = r.eg();
    if (out.count > MAX_VOICE_EVENTS) { out.count = MAX_VOICE_EVENTS; out.repaired = true; }
    const flags = out.flags = { rest: r.get(1) === 1, alt: r.get(1) === 1, chords: r.get(1) === 1 };
    const alt = () => (flags.alt ? (r.get(1) ? 1 + r.get(1) : 0) : 0);
    while (covered < out.count) {
      const bit = r.pos;
      if (r.get(1) === 0) {
        const dist = r.eg() + 1, len = r.eg() + 2, shift = r.zz();
        out.ops.push({ op: 'copy', dist, len, shift, bit, end: r.pos });
        covered += len;
        continue;
      }
      const rest = flags.rest ? r.get(1) === 1 : false;
      const op = { op: 'lit', rest, dur: r.get(1) ? r.get(3) : undefined, bit };
      if (!rest) {
        op.delta = r.zz(); op.alt = alt();
        if (flags.chords && r.get(1)) {
          const code = r.eg();
          if (code > 0) {
            if (code > cache.length) throw new Error('unknown chord shape');
            const [shape] = cache.splice(code - 1, 1);
            cache.unshift(shape);
            op.chord = { hit: code - 1, tones: shape };
          } else {
            const tones = [];
            for (let k = r.eg() + 1; k > 0; k--) tones.push({ delta: r.zz(), alt: alt() });
            cache.unshift(tones);
            cache.length = Math.min(cache.length, SHAPE_CACHE);
            op.chord = { tones };
          }
        }
      }
      op.end = r.pos;
      out.ops.push(op);
      covered++;
    }
  } catch { out.repaired = true; }
  out.bits = r.pos;
  return out;
}

/**
 * Ops → events. `history` is what copies may reach back into before this voice starts
 * (the first staff's events, when resolving the second staff).
 * @returns {{events: object[], spans: {op: object, from: number, to: number}[], repaired: boolean}}
 */
export function resolveVoice(voice, key, clef, history = []) {
  const events = [], spans = [];
  let repaired = voice.repaired, prevDur = 2, prevPitch = startPitch(clef);
  const inRange = d => d >= 0 && d <= MAX_DIA;
  const tonesAt = (main, tones) => {
    const seen = new Set([main]);
    const out = [];
    let pp = main;
    for (const t of tones) {
      pp += t.delta;
      if (!inRange(pp) || seen.has(pp)) { repaired = true; continue; }
      seen.add(pp);
      const s = split(pp);
      out.push({ step: s.step, oct: s.oct, alter: altFrom(key, s.step, t.alt) });
    }
    return out;
  };
  for (const op of voice.ops) {
    const from = events.length;
    if (op.op === 'copy') {
      let bad = false;
      for (let k = 0; k < op.len && events.length < voice.count; k++) {
        const src = events.length - op.dist >= 0 ? events[events.length - op.dist] : history[history.length + events.length - op.dist];
        if (!src) { bad = true; break; }
        if (src.rest) { events.push({ rest: true, dur: src.dur }); continue; }
        const main = dia(src) + op.shift;
        if (!inRange(main) || (src.tones || []).some(t => !inRange(dia(t) + op.shift))) { bad = true; break; }
        const e = { dur: src.dur, step: split(main).step, oct: split(main).oct, alter: src.alter };
        if (src.tones) e.tones = src.tones.map(t => ({ ...split(dia(t) + op.shift), alter: t.alter }));
        events.push(e);
      }
      if (bad) { repaired = true; spans.push({ op, from, to: events.length }); break; }
      const last = events[events.length - 1];
      if (last && events.length > from) { if (!last.rest) prevPitch = dia(last); prevDur = last.dur; }
    } else {
      const dur = op.dur ?? prevDur;
      if (op.rest) events.push({ rest: true, dur });
      else {
        const main = prevPitch + op.delta;
        if (!inRange(main)) { repaired = true; break; }
        const s = split(main);
        const e = { dur, step: s.step, oct: s.oct, alter: altFrom(key, s.step, op.alt) };
        const tones = op.chord ? tonesAt(main, op.chord.tones) : [];
        if (tones.length) e.tones = tones;
        events.push(e);
        prevPitch = main;
      }
      prevDur = dur;
    }
    spans.push({ op, from, to: events.length });
  }
  if (events.length < voice.count) repaired = true;
  return { events, spans, repaired };
}

/**
 * Events → ops. Every event is either a literal or part of a copy of earlier events,
 * possibly shifted by whole scale steps (a repeated bar of accompaniment, a sequence).
 * @param {object[]} history events a copy may reach back into first (the first staff)
 */
export function planVoice(events, key, clef, history = []) {
  const all = [...history, ...events], base = history.length;
  const noteAlt = e => altCode(key, e.step, e.alter) !== 0 || (e.tones || []).some(t => altCode(key, t.step, t.alter) !== 0);
  const flags = {
    rest: events.some(e => e.rest),
    alt: events.some(e => !e.rest && noteAlt(e)),
    chords: events.some(e => e.tones?.length),
  };
  const ops = [], cache = [];
  let prevDur = 2, prevPitch = startPitch(clef);

  const literal = e => {
    const op = { op: 'lit', rest: !!e.rest, dur: e.dur === prevDur ? undefined : e.dur };
    prevDur = e.dur;
    if (!e.rest) {
      op.delta = dia(e) - prevPitch; op.alt = altCode(key, e.step, e.alter);
      prevPitch = dia(e);
      if (e.tones?.length) {
        let pp = dia(e);
        const tones = e.tones.map(t => { const delta = dia(t) - pp; pp = dia(t); return { delta, alt: altCode(key, t.step, t.alter) }; });
        const ix = cache.findIndex(s => shapeKey(s) === shapeKey(tones));
        if (ix >= 0) { cache.splice(ix, 1); op.chord = { hit: ix, tones }; } else op.chord = { tones };
        cache.unshift(tones);
        cache.length = Math.min(cache.length, SHAPE_CACHE);
      }
    }
    ops.push(op);
  };

  for (let i = 0; i < events.length;) {
    const at = base + i;
    let best = null;
    for (let dist = 1; dist <= at; dist++) {
      let len = 0, shift = null;
      for (; i + len < events.length; len++) {
        const a = all[at + len], b = all[at - dist + len];
        if (a.rest !== b.rest || a.dur !== b.dur) break;
        if (a.rest) continue;
        const s = dia(a) - dia(b);
        if (shift !== null && s !== shift) break;
        if (a.alter !== b.alter || (a.tones?.length ?? 0) !== (b.tones?.length ?? 0)) break;
        if ((a.tones || []).some((t, k) => dia(t) - dia(b.tones[k]) !== s || t.alter !== b.tones[k].alter)) break;
        shift = s;
      }
      if (len < 2) continue;
      const bits = 1 + egBits(dist - 1) + egBits(len - 2) + zzBits(shift ?? 0);
      if (bits >= COPY_BITS_PER_EVENT * len) continue;
      if (!best || len > best.len || (len === best.len && bits < best.bits)) best = { dist, len, shift: shift ?? 0, bits };
    }
    if (!best) { literal(events[i]); i++; continue; }
    ops.push({ op: 'copy', dist: best.dist, len: best.len, shift: best.shift });
    const last = events[i + best.len - 1];
    if (!last.rest) prevPitch = dia(last);
    prevDur = last.dur;
    i += best.len;
  }
  return { count: events.length, flags, ops };
}
