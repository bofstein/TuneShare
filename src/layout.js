// Tune → positioned drawing primitives + geometry for hit-testing. Pure, no DOM.
// Rules: DESIGN.md, "Rendering and audio".
import { BEAT_TICKS, CLEFS, TICKS_PER_MEASURE, keyAlter, spell, spellAligned, ticksOf } from './theory.js';

export const G = {
  gClef: '', fClef: '', nhW: '', nhH: '', nhB: '', dot: '',
  f8u: '', f8d: '', f16u: '', f16d: '', flat: '', nat: '', sharp: '',
  rW: '', rH: '', rQ: '', r8: '', r16: '',
  mW: '', mH: '', mQ: '', m8: '', m16: '', mDot: '',
};
const tsGlyph = n => String(n).split('').map(c => String.fromCharCode(0xE080 + +c)).join('');
const KS_SHARP_POS = [8, 5, 9, 6, 3, 7, 4], KS_FLAT_POS = [4, 7, 3, 6, 2, 5, 1];   // treble; bass = −2
const REST_GLYPH = { 16: G.rW, 12: G.rH, 8: G.rH, 6: G.rQ, 4: G.rQ, 3: G.r8, 2: G.r8, 1: G.r16 };

/** Split events at bar lines and spell each piece; append implicit rests. */
export function buildPieces(tune) {
  const tpm = TICKS_PER_MEASURE[tune.time];
  const pcs = [];
  let t = 0;
  tune.events.forEach((e, i) => {
    let rem = ticksOf(e), first = true;
    const chain = [];
    while (rem > 0) {
      const m = Math.floor(t / tpm), len = Math.min(rem, (m + 1) * tpm - t);
      for (const v of spell(len)) {
        const p = { ev: i, e, m, tick: t - m * tpm, abs: t, ticks: v, first, rest: !!e.rest };
        chain.push(p); pcs.push(p); first = false; t += v;
      }
      rem -= len;
    }
    if (!e.rest) for (let k = 0; k < chain.length - 1; k++) chain[k].tieTo = chain[k + 1];
  });
  const usedTicks = t, empties = [];
  for (let m = Math.floor(usedTicks / tpm); m < tune.measures; m++) {
    const ms = m * tpm;
    if (ms >= usedTicks) { empties.push(m); continue; }
    for (const [tk, v] of spellAligned(usedTicks - ms, ms + tpm - usedTicks)) {
      pcs.push({ ev: -1, m, tick: tk, abs: ms + tk, ticks: v, rest: true, implicit: true, first: true });
    }
  }
  return { pcs, used: usedTicks, empties, tpm };
}

/** Beam groups: runs of 8ths/16ths within one beat group, broken by rests. */
export function beamGroups(pcs, beat) {
  const groups = [];
  let run = [];
  const flush = () => { if (run.length >= 2) groups.push(run); run = []; };
  for (const p of pcs) {
    if (p.rest || ![1, 2, 3].includes(p.ticks)) { flush(); continue; }
    const last = run[run.length - 1];
    if (last && (last.m !== p.m || Math.floor(last.tick / beat) !== Math.floor(p.tick / beat) || last.abs + last.ticks !== p.abs)) flush();
    run.push(p);
  }
  flush();
  return groups;
}

/** Written accidentals per measure, tracked by staff position. Sets p.acc on pieces. */
export function assignAccidentals(pcs, key, bottom) {
  let curM = -1, state = new Map();
  for (const p of pcs) {
    if (p.m !== curM) { curM = p.m; state = new Map(); }
    if (p.rest || !p.first) continue;
    const pos = p.e.oct * 7 + p.e.step - bottom;
    const cur = state.has(pos) ? state.get(pos) : keyAlter(key, p.e.step);
    if (p.e.alter !== cur) { p.acc = p.e.alter === 1 ? G.sharp : p.e.alter === -1 ? G.flat : G.nat; state.set(pos, p.e.alter); }
  }
}

/**
 * @returns {{width,height,sp,staff:Item[],events:Map<number,Item[]>,implicit:Item[],beams:Item[],geo}}
 * Item: {t:'glyph'|'line'|'rect'|'poly'|'path', cls, ...}
 */
export function layout(tune, { width, perSys = 4, sp = 10 }) {
  const { pcs, empties, tpm, used } = buildPieces(tune);
  const beat = BEAT_TICKS[tune.time];
  const clef = CLEFS[tune.clef], bass = tune.clef === 'bass';
  const nAcc = Math.abs(tune.key);
  const ksPos = (tune.key > 0 ? KS_SHARP_POS : KS_FLAT_POS).map(p => (bass ? p - 2 : p));
  const sysN = Math.ceil(tune.measures / perSys);
  const top = 4.6 * sp, sysH = 12.5 * sp;
  const yB = k => k * sysH + top + 4 * sp;
  const Y = (k, pos) => yB(k) - (pos * sp) / 2;
  const hdrW = k => 0.5 * sp + 3.2 * sp + (nAcc ? nAcc * 1.05 * sp + 0.6 * sp : 0.3 * sp) + (k === 0 ? 3.0 * sp : 0.4 * sp);
  const mw = k => (width - hdrW(k) - 2) / perSys;
  const sysOf = m => Math.floor(m / perSys);
  const mX = m => { const k = sysOf(m); return hdrW(k) + (m - k * perSys) * mw(k); };

  pcs.forEach(p => { if (!p.rest) p.pos = p.e.oct * 7 + p.e.step - clef.bottom; });
  assignAccidentals(pcs, tune.key, clef.bottom);

  // Time-proportional spacing plus a fixed allowance before notes showing an accidental.
  const pads = new Map();
  for (const p of pcs) if (p.acc) { if (!pads.has(p.m)) pads.set(p.m, []); pads.get(p.m).push([p.tick, 1.1 * sp]); }
  const tx = (m, tick, inclusive = true) => {
    const list = pads.get(m) || [];
    const total = list.reduce((a, [, w]) => a + w, 0);
    const before = list.reduce((a, [t, w]) => a + ((inclusive ? t <= tick : t < tick) ? w : 0), 0);
    return mX(m) + 1.5 * sp + before + (tick / tpm) * (mw(sysOf(m)) - 2.7 * sp - total);
  };

  const staff = [], implicit = [], beams = [], events = new Map();
  const glyph = (x, y, g, cls = 'g') => ({ t: 'glyph', x, y, g, cls });
  const line = (x1, y1, x2, y2, cls) => ({ t: 'line', x1, y1, x2, y2, cls });
  const add = (i, item) => { if (!events.has(i)) events.set(i, []); events.get(i).push(item); };

  // Systems
  const systems = [];
  for (let k = 0; k < sysN; k++) {
    const mFirst = k * perSys, mLast = Math.min(tune.measures, mFirst + perSys) - 1;
    const xEnd = mX(mLast) + mw(k);
    systems.push({ k, mFirst, mLast, xStart: mX(mFirst), xEnd, top: yB(k) - 4 * sp, bottom: yB(k) });
    for (let i = 0; i < 5; i++) staff.push(line(0, yB(k) - i * sp, xEnd, yB(k) - i * sp, 'ln'));
    let x = 0.5 * sp;
    staff.push(bass ? glyph(x, Y(k, 6), G.fClef) : glyph(x, Y(k, 2), G.gClef));
    x += 3.4 * sp;
    for (let i = 0; i < nAcc; i++) staff.push(glyph(x + i * 1.05 * sp, Y(k, ksPos[i]), tune.key > 0 ? G.sharp : G.flat));
    x += nAcc ? nAcc * 1.05 * sp + 0.5 * sp : 0.2 * sp;
    if (k === 0) { const [a, b] = tune.time.split('/'); staff.push(glyph(x, Y(k, 6), tsGlyph(a)), glyph(x, Y(k, 2), tsGlyph(b))); }
    for (let m = mFirst; m <= mLast; m++) {
      const bx = mX(m) + mw(k);
      if (m === tune.measures - 1) {
        staff.push(line(bx - 0.75 * sp, yB(k) - 4 * sp, bx - 0.75 * sp, yB(k), 'bar'));
        staff.push({ t: 'rect', x: bx - 0.5 * sp, y: yB(k) - 4 * sp, w: 0.5 * sp, h: 4 * sp, cls: 'ink' });
      } else staff.push(line(bx, yB(k) - 4 * sp, bx, yB(k), 'bar'));
    }
    if (k > 0) staff.push({ t: 'text', x: 0.4 * sp, y: yB(k) - 5.3 * sp, text: String(mFirst + 1), cls: 'mnum' });
  }

  // Note geometry
  for (const p of pcs) {
    p.k = sysOf(p.m); p.x = tx(p.m, p.tick);
    if (p.rest) continue;
    p.y = Y(p.k, p.pos);
    p.hw = (p.ticks === 16 ? 1.688 : 1.18) * sp;
    p.up = p.pos < 4;
    p.hasStem = p.ticks !== 16;
  }
  const sx = p => (p.up ? p.x + p.hw - 0.06 * sp : p.x + 0.06 * sp);
  for (const p of pcs) {
    if (!p.rest && p.hasStem) p.tip = p.up ? Math.min(p.y - 3.5 * sp, Y(p.k, 4)) : Math.max(p.y + 3.5 * sp, Y(p.k, 4));
  }

  // Beams
  for (const g of beamGroups(pcs, beat)) {
    const maxP = Math.max(...g.map(p => p.pos)), minP = Math.min(...g.map(p => p.pos));
    const up = maxP - 4 <= 4 - minP;
    g.forEach(p => { p.up = up; p.beamed = true; });
    const f = g[0], l = g[g.length - 1], x1 = sx(f), x2 = sx(l);
    let t1 = f.y + (up ? -3.5 : 3.5) * sp;
    const t2 = l.y + (up ? -3.5 : 3.5) * sp;
    const dy = Math.max(-sp, Math.min(sp, t2 - t1));
    const minLen = (g.some(p => p.ticks === 1) ? 3.25 : 3.0) * sp;
    let by = x => t1 + (dy * (x - x1)) / (x2 - x1 || 1);
    let shift = 0;
    for (const p of g) { const b = by(sx(p)); shift = up ? Math.max(shift, b - (p.y - minLen)) : Math.max(shift, p.y + minLen - b); }
    t1 += up ? -shift : shift;
    by = x => t1 + (dy * (x - x1)) / (x2 - x1 || 1);
    g.forEach(p => { p.tip = by(sx(p)); });
    const th = (up ? 1 : -1) * 0.5 * sp, off = (up ? 1 : -1) * 0.78 * sp;
    const poly = (a, b, o) => ({ t: 'poly', cls: 'ink', pts: [[a, by(a) + o], [b, by(b) + o], [b, by(b) + o + th], [a, by(a) + o + th]] });
    beams.push(poly(x1, x2, 0));
    g.forEach((p, i) => {
      if (p.ticks !== 1) return;
      const nx = g[i + 1], pv = g[i - 1];
      if (nx && nx.ticks === 1) beams.push(poly(sx(p), sx(nx), off));
      else if (!(pv && pv.ticks === 1)) {
        const last = i === g.length - 1;
        beams.push(poly(last ? sx(p) - 1.1 * sp : sx(p), last ? sx(p) : sx(p) + 1.1 * sp, off));
      }
    });
  }

  const ledgers = (k, x, w, pos) => {
    const out = [];
    for (let q = -2; q >= pos; q -= 2) out.push(line(x - 0.4 * sp, Y(k, q), x + w + 0.4 * sp, Y(k, q), 'ledger'));
    for (let q = 10; q <= pos; q += 2) out.push(line(x - 0.4 * sp, Y(k, q), x + w + 0.4 * sp, Y(k, q), 'ledger'));
    return out;
  };
  const tieArc = (x1, x2, y, side) => {
    const h = side * Math.min(1.1 * sp, 0.25 * sp + (x2 - x1) * 0.12), mx = (x1 + x2) / 2, f = n => n.toFixed(1);
    return { t: 'path', cls: 'ink', d: `M${f(x1)},${f(y)} Q${f(mx)},${f(y + h)} ${f(x2)},${f(y)} Q${f(mx)},${f(y + h - side * 0.28 * sp)} ${f(x1)},${f(y)}Z` };
  };

  const hits = [];   // [{ev, x1, y1, x2, y2}] note/rest hit boxes
  for (const p of pcs) {
    if (p.rest) {
      const pos = p.ticks === 16 ? 6 : 4;
      const items = [glyph(p.x, Y(p.k, pos), REST_GLYPH[p.ticks], p.implicit ? 'g faint' : 'g')];
      if ([3, 6, 12].includes(p.ticks)) items.push(glyph(p.x + 1.5 * sp, Y(p.k, 5), G.dot, p.implicit ? 'g faint' : 'g'));
      if (p.implicit) implicit.push(...items);
      else { items.forEach(it => add(p.ev, it)); hits.push({ ev: p.ev, x1: p.x - 0.3 * sp, x2: p.x + 1.6 * sp, y1: Y(p.k, 8), y2: Y(p.k, 0) }); }
      continue;
    }
    add(p.ev, { t: 'halo', x: p.x - 0.45 * sp, y: p.y - 0.95 * sp, w: p.hw + 0.9 * sp, h: 1.9 * sp });
    ledgers(p.k, p.x, p.hw, p.pos).forEach(it => add(p.ev, it));
    if (p.acc) add(p.ev, glyph(p.x - (p.acc === G.nat ? 0.95 : 1.25) * sp, p.y, p.acc));
    add(p.ev, glyph(p.x, p.y, p.ticks === 16 ? G.nhW : p.ticks >= 8 ? G.nhH : G.nhB));
    if ([3, 6, 12].includes(p.ticks)) add(p.ev, glyph(p.x + p.hw + 0.35 * sp, p.pos % 2 === 0 ? p.y - sp / 2 : p.y, G.dot));
    if (p.hasStem) {
      add(p.ev, line(sx(p), p.y + (p.up ? -0.15 : 0.15) * sp, sx(p), p.tip, 'stem'));
      if (!p.beamed && [1, 2, 3].includes(p.ticks)) {
        const fl = p.ticks === 1 ? (p.up ? G.f16u : G.f16d) : p.up ? G.f8u : G.f8d;
        add(p.ev, glyph(sx(p) - 0.06 * sp, p.tip, fl));
      }
    }
    if (p.tieTo) {
      const q = p.tieTo, side = p.up ? 1 : -1, y = p.y + side * 0.62 * sp;
      if (q.k === p.k) add(p.ev, tieArc(p.x + p.hw + 0.12 * sp, q.x - 0.12 * sp, y, side));
      else {
        add(p.ev, tieArc(p.x + p.hw + 0.12 * sp, systems[p.k].xEnd - 0.3 * sp, y, side));
        add(q.ev, tieArc(q.x - 2.4 * sp, q.x - 0.12 * sp, q.y + side * 0.62 * sp, side));
      }
    }
    hits.push({ ev: p.ev, x1: p.x - 0.4 * sp, x2: p.x + p.hw + 0.4 * sp, y1: p.y - 0.9 * sp, y2: p.y + 0.9 * sp });
  }
  for (const m of empties) {
    const k = sysOf(m);
    implicit.push(glyph(mX(m) + mw(k) / 2 - 0.56 * sp, Y(k, 6), G.rW, 'g faint'));
  }

  // Geometry for input handling
  const starts = [];
  { let t = 0; for (const e of tune.events) { starts.push(t); t += ticksOf(e); } }
  const geo = {
    sp, tpm, used, starts, systems, tx, Y, yB, sysH,
    /** Pointer (x,y) in SVG coords → {k, m, tick, abs, pos} or null when outside the staff area. */
    locate(x, y) {
      const k = Math.floor(y / sysH);
      const s = systems[k];
      if (!s || x < s.xStart - 0.5 * sp || x > s.xEnd) return null;
      let m = s.mFirst;
      while (m < s.mLast && x >= mX(m + 1)) m++;
      let best = 0, bd = Infinity;
      for (let t = 0; t < tpm; t++) { const d = Math.abs(tx(m, t) - x); if (d < bd) { bd = d; best = t; } }
      const pos = Math.round((yB(k) - y) / (sp / 2));
      return { k, m, tick: best, abs: m * tpm + best, pos };
    },
    hitEvent(x, y) {
      for (const h of hits) if (x >= h.x1 && x <= h.x2 && y >= h.y1 && y <= h.y2) return h.ev;
      return -1;
    },
    /** Absolute tick → x/k (for drawing the insert marker before the event starting there). */
    slotX(abs) {
      const m = Math.min(Math.floor(abs / tpm), tune.measures - 1), tick = abs - m * tpm;
      return { k: sysOf(m), x: tx(m, tick, false) - (tick ? 0.9 : 0.7) * sp };
    },
    eventBox(i) { const h = hits.find(b => b.ev === i); return h ? { ...h, k: Math.floor(h.y1 / sysH) } : null; },
  };

  return { width, height: sysN * sysH + 0.6 * sp, sp, staff, events, implicit, beams, geo };
}
