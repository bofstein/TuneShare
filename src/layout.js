// Tune → positioned drawing primitives + geometry for hit-testing. Pure, no DOM.
// Rules: DESIGN.md, "Rendering and audio".
import { BEAT_TICKS, CLEFS, TICKS_PER_MEASURE, keyAlter, spell, spellAligned, ticksOf } from './theory.js';
import { pitchesOf, staffList } from './model.js';

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

/** Noteheads of a note piece: one per pitch, sorted bottom to top. Sets p.heads, p.minPos, p.maxPos. */
export function assignHeads(pcs, bottom) {
  for (const p of pcs) {
    if (p.rest) continue;
    p.heads = pitchesOf(p.e)
      .map((pp, t) => ({ ...pp, t, pos: pp.oct * 7 + pp.step - bottom }))
      .sort((a, b) => a.pos - b.pos);
    p.minPos = p.heads[0].pos;
    p.maxPos = p.heads[p.heads.length - 1].pos;
  }
}

/** Written accidentals per measure, tracked by staff position. Sets h.acc on heads. */
export function assignAccidentals(pcs, key) {
  let curM = -1, state = new Map();
  for (const p of pcs) {
    if (p.m !== curM) { curM = p.m; state = new Map(); }
    if (p.rest || !p.first) continue;
    for (const h of p.heads) {
      const cur = state.has(h.pos) ? state.get(h.pos) : keyAlter(key, h.step);
      if (h.alter !== cur) { h.acc = h.alter === 1 ? G.sharp : h.alter === -1 ? G.flat : G.nat; state.set(h.pos, h.alter); }
    }
  }
}

/** Accidental columns, top to bottom: an accidental joins the first column with no
 *  accidental within a sixth of it. Sets h.col; returns the number of columns. */
export function assignAccidentalColumns(heads) {
  const cols = [];
  for (const h of [...heads].reverse()) {
    if (!h.acc) continue;
    let c = cols.findIndex(col => col.every(pos => Math.abs(pos - h.pos) >= 6));
    if (c < 0) { c = cols.length; cols.push([]); }
    cols[c].push(h.pos);
    h.col = c;
  }
  return cols.length;
}

/** Notes a second apart go on opposite sides of the stem. Sets h.side (−1 left, 0, 1 right). */
export function assignSides(heads, up) {
  heads.forEach(h => { h.side = 0; });
  if (up) {
    for (let i = 1; i < heads.length; i++) {
      if (heads[i].pos - heads[i - 1].pos === 1 && heads[i - 1].side === 0) heads[i].side = 1;
    }
  } else {
    for (let i = heads.length - 2; i >= 0; i--) {
      if (heads[i + 1].pos - heads[i].pos === 1 && heads[i + 1].side === 0) heads[i].side = -1;
    }
  }
}

/** A curly brace joining the staves of a system, its tip pointing left at x. */
function brace(x, y1, y2, sp) {
  const w = 1.1 * sp, t = 0.4 * sp, my = (y1 + y2) / 2, f = n => n.toFixed(1);
  const P = (dx, y) => `${f(x + dx)},${f(y)}`;
  // One arm from an end (curled right) to the tip; th thickens the middle of the arm.
  const arm = (yEnd, th) => { const v = q => yEnd + (my - yEnd) * q; return [P(w, yEnd), P(0.4 * w + th * 0.4, v(0.08)), P(0.5 * w + th, v(0.3)), P(0.5 * w + th, v(0.5)), P(0.5 * w + th, v(0.75)), P(0.35 * w + th * 0.5, v(0.97)), P(0, my)]; };
  const out = (a) => `C${a[1]} ${a[2]} ${a[3]} C${a[4]} ${a[5]} ${a[6]}`;
  const back = (a) => `C${a[5]} ${a[4]} ${a[3]} C${a[2]} ${a[1]} ${a[0]}`;
  const top0 = arm(y1, 0), top1 = arm(y1, t), bot0 = arm(y2, 0), bot1 = arm(y2, t);
  // Outer edge: top end → tip → bottom end; inner edge back: bottom end → tip → top end.
  const d = `M${top0[0]} ${out(top0)} ${back(bot0)} ${out(bot1)} ${back(top1)}Z`;
  return { t: 'path', cls: 'ink', d };
}

const hasSeconds = heads => heads.some((h, i) => i && h.pos - heads[i - 1].pos === 1);
const stemUp = (minPos, maxPos) => maxPos - 4 <= 4 - minPos;

/**
 * Each system holds one staff per tune staff (s = 0 top, 1 bottom), sharing bar lines and spacing.
 * @returns {{width,height,sp,staff:Item[],events:Map<number,Item[]>[],implicit:Item[],beams:Item[],geo}}
 *   events[s] maps an event index of staff s to its items.
 * Item: {t:'glyph'|'line'|'rect'|'poly'|'path'|'halo'|'text', cls, ...}
 */
export function layout(tune, { width, perSys = 4, sp = 10 }) {
  const staves = staffList(tune).map((st, s) => {
    const b = buildPieces({ ...tune, events: st.events });
    assignHeads(b.pcs, CLEFS[st.clef].bottom);
    assignAccidentals(b.pcs, tune.key);
    return { ...b, s, bass: st.clef === 'bass', events: st.events };
  });
  const nSt = staves.length, tpm = staves[0].tpm;
  const beat = BEAT_TICKS[tune.time];
  const nAcc = Math.abs(tune.key);
  const ksPos = bass => (tune.key > 0 ? KS_SHARP_POS : KS_FLAT_POS).map(p => (bass ? p - 2 : p));
  const sysN = Math.ceil(tune.measures / perSys);
  const gap = 11 * sp;                                // bottom line to bottom line between staves
  const top = 4.6 * sp, sysH = 12.5 * sp + (nSt - 1) * gap;
  const yB = (k, s = 0) => k * sysH + top + 4 * sp + s * gap;
  const Yg = (k, pos, s = 0) => yB(k, s) - (pos * sp) / 2;
  const x0 = nSt > 1 ? 1.6 * sp : 0;                  // room for the brace
  const hdrW = k => x0 + 0.5 * sp + 3.2 * sp + (nAcc ? nAcc * 1.05 * sp + 0.6 * sp : 0.3 * sp) + (k === 0 ? 3.0 * sp : 0.4 * sp);
  const mw = k => (width - hdrW(k) - 2) / perSys;
  const sysOf = m => Math.floor(m / perSys);
  const mX = m => { const k = sysOf(m); return hdrW(k) + (m - k * perSys) * mw(k); };

  // Time-proportional spacing plus a fixed allowance before notes showing accidentals
  // (one per accidental column, plus a head width when a second pushes a head left).
  // Staves share one allowance per tick (the widest), so notes sounding together line up.
  const padAt = new Map();
  for (const { pcs } of staves) for (const p of pcs) {
    if (p.rest) continue;
    p.accCols = assignAccidentalColumns(p.heads);
    const w = p.accCols * 1.1 * sp + (p.accCols && hasSeconds(p.heads) ? 1.18 * sp : 0);
    if (w) { if (!padAt.has(p.m)) padAt.set(p.m, new Map()); const mm = padAt.get(p.m); mm.set(p.tick, Math.max(w, mm.get(p.tick) || 0)); }
  }
  const pads = new Map([...padAt].map(([m, mm]) => [m, [...mm]]));
  const tx = (m, tick, inclusive = true) => {
    const list = pads.get(m) || [];
    const total = list.reduce((a, [, w]) => a + w, 0);
    const before = list.reduce((a, [t, w]) => a + ((inclusive ? t <= tick : t < tick) ? w : 0), 0);
    return mX(m) + 1.5 * sp + before + (tick / tpm) * (mw(sysOf(m)) - 2.7 * sp - total);
  };

  const staff = [], implicit = [], beams = [], events = staves.map(() => new Map());
  const glyph = (x, y, g, cls = 'g') => ({ t: 'glyph', x, y, g, cls });
  const line = (x1, y1, x2, y2, cls) => ({ t: 'line', x1, y1, x2, y2, cls });

  // Systems
  const systems = [];
  for (let k = 0; k < sysN; k++) {
    const mFirst = k * perSys, mLast = Math.min(tune.measures, mFirst + perSys) - 1;
    const xEnd = mX(mLast) + mw(k);
    const yTop = yB(k) - 4 * sp, yBot = yB(k, nSt - 1);
    systems.push({ k, mFirst, mLast, xStart: mX(mFirst), xEnd, top: yTop, bottom: yBot });
    for (const { s, bass } of staves) {
      const Y = (kk, pos) => Yg(kk, pos, s);
      for (let i = 0; i < 5; i++) staff.push(line(x0, yB(k, s) - i * sp, xEnd, yB(k, s) - i * sp, 'ln'));
      let x = x0 + 0.5 * sp;
      staff.push(bass ? glyph(x, Y(k, 6), G.fClef) : glyph(x, Y(k, 2), G.gClef));
      x += 3.4 * sp;
      const ks = ksPos(bass);
      for (let i = 0; i < nAcc; i++) staff.push(glyph(x + i * 1.05 * sp, Y(k, ks[i]), tune.key > 0 ? G.sharp : G.flat));
      x += nAcc ? nAcc * 1.05 * sp + 0.5 * sp : 0.2 * sp;
      if (k === 0) { const [a, b] = tune.time.split('/'); staff.push(glyph(x, Y(k, 6), tsGlyph(a)), glyph(x, Y(k, 2), tsGlyph(b))); }
    }
    if (nSt > 1) {
      staff.push(line(x0, yTop, x0, yBot, 'bar'));
      staff.push(brace(0.1 * sp, yTop, yBot, sp));
    }
    // Bar lines run through every staff of the system.
    for (let m = mFirst; m <= mLast; m++) {
      const bx = mX(m) + mw(k);
      if (m === tune.measures - 1) {
        staff.push(line(bx - 0.75 * sp, yTop, bx - 0.75 * sp, yBot, 'bar'));
        staff.push({ t: 'rect', x: bx - 0.5 * sp, y: yTop, w: 0.5 * sp, h: yBot - yTop, cls: 'ink' });
      } else staff.push(line(bx, yTop, bx, yBot, 'bar'));
    }
    if (k > 0) staff.push({ t: 'text', x: 0.4 * sp, y: yB(k) - 5.3 * sp, text: String(mFirst + 1), cls: 'mnum' });
  }

  const hits = [];   // [{s, ev, tone, x1, y1, x2, y2}] note/rest hit boxes
  for (const { s, pcs, empties } of staves) {
    const Y = (k, pos) => Yg(k, pos, s);
    const add = (i, item) => { if (!events[s].has(i)) events[s].set(i, []); events[s].get(i).push(item); };
    // Note geometry. p.x is the normal notehead column; the stem sits on its right (up) or left (down).
    for (const p of pcs) {
      p.k = sysOf(p.m); p.x = tx(p.m, p.tick);
      if (p.rest) continue;
      p.hw = (p.ticks === 16 ? 1.688 : 1.18) * sp;
      p.up = stemUp(p.minPos, p.maxPos);
      p.hasStem = p.ticks !== 16;
    }
    const sx = p => (p.up ? p.x + p.hw - 0.06 * sp : p.x + 0.06 * sp);
    const tipAnchor = p => Y(p.k, p.up ? p.maxPos : p.minPos);     // head the stem extends from
    const stemBase = p => Y(p.k, p.up ? p.minPos : p.maxPos);      // head at the other end
    for (const p of pcs) {
      if (!p.rest && p.hasStem) p.tip = p.up ? Math.min(tipAnchor(p) - 3.5 * sp, Y(p.k, 4)) : Math.max(tipAnchor(p) + 3.5 * sp, Y(p.k, 4));
    }

    // Beams
    for (const g of beamGroups(pcs, beat)) {
      const up = stemUp(Math.min(...g.map(p => p.minPos)), Math.max(...g.map(p => p.maxPos)));
      g.forEach(p => { p.up = up; p.beamed = true; });
      const f = g[0], l = g[g.length - 1], x1 = sx(f), x2 = sx(l);
      let t1 = tipAnchor(f) + (up ? -3.5 : 3.5) * sp;
      const t2 = tipAnchor(l) + (up ? -3.5 : 3.5) * sp;
      const dy = Math.max(-sp, Math.min(sp, t2 - t1));
      const minLen = (g.some(p => p.ticks === 1) ? 3.25 : 3.0) * sp;
      let by = x => t1 + (dy * (x - x1)) / (x2 - x1 || 1);
      let shift = 0;
      for (const p of g) { const b = by(sx(p)), a = tipAnchor(p); shift = up ? Math.max(shift, b - (a - minLen)) : Math.max(shift, a + minLen - b); }
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
    for (const p of pcs) if (!p.rest) assignSides(p.heads, p.up || !p.hasStem);

    const ledgers = (k, x1, x2, minPos, maxPos) => {
      const out = [];
      for (let q = -2; q >= minPos; q -= 2) out.push(line(x1 - 0.4 * sp, Y(k, q), x2 + 0.4 * sp, Y(k, q), 'ledger'));
      for (let q = 10; q <= maxPos; q += 2) out.push(line(x1 - 0.4 * sp, Y(k, q), x2 + 0.4 * sp, Y(k, q), 'ledger'));
      return out;
    };
    const tieArc = (x1, x2, y, side) => {
      const h = side * Math.min(1.1 * sp, 0.25 * sp + (x2 - x1) * 0.12), mx = (x1 + x2) / 2, f = n => n.toFixed(1);
      return { t: 'path', cls: 'ink', d: `M${f(x1)},${f(y)} Q${f(mx)},${f(y + h)} ${f(x2)},${f(y)} Q${f(mx)},${f(y + h - side * 0.28 * sp)} ${f(x1)},${f(y)}Z` };
    };

    for (const p of pcs) {
      if (p.rest) {
        const pos = p.ticks === 16 ? 6 : 4;
        const items = [glyph(p.x, Y(p.k, pos), REST_GLYPH[p.ticks], p.implicit ? 'g faint' : 'g')];
        if ([3, 6, 12].includes(p.ticks)) items.push(glyph(p.x + 1.5 * sp, Y(p.k, 5), G.dot, p.implicit ? 'g faint' : 'g'));
        if (p.implicit) implicit.push(...items);
        else { items.forEach(it => add(p.ev, it)); hits.push({ s, ev: p.ev, tone: 0, x1: p.x - 0.3 * sp, x2: p.x + 1.6 * sp, y1: Y(p.k, 8), y2: Y(p.k, 0) }); }
        continue;
      }
      const hx = h => p.x + h.side * p.hw;
      const xs = p.heads.map(hx), left = Math.min(...xs), right = Math.max(...xs) + p.hw;
      for (const h of p.heads) {
        const y = Y(p.k, h.pos);
        add(p.ev, { t: 'halo', tone: h.t, x: hx(h) - 0.45 * sp, y: y - 0.95 * sp, w: p.hw + 0.9 * sp, h: 1.9 * sp });
      }
      ledgers(p.k, left, right, p.minPos, p.maxPos).forEach(it => add(p.ev, it));
      for (const h of p.heads) {
        const y = Y(p.k, h.pos);
        if (h.acc) add(p.ev, glyph(left - (h.acc === G.nat ? 0.95 : 1.25) * sp - h.col * 1.1 * sp, y, h.acc));
        add(p.ev, glyph(hx(h), y, p.ticks === 16 ? G.nhW : p.ticks >= 8 ? G.nhH : G.nhB));
        if ([3, 6, 12].includes(p.ticks)) add(p.ev, glyph(right + 0.35 * sp, h.pos % 2 === 0 ? y - sp / 2 : y, G.dot));
        hits.push({ s, ev: p.ev, tone: h.t, x1: hx(h) - 0.4 * sp, x2: hx(h) + p.hw + 0.4 * sp, y1: y - sp / 2, y2: y + sp / 2 });
      }
      if (p.hasStem) {
        add(p.ev, line(sx(p), stemBase(p) + (p.up ? -0.15 : 0.15) * sp, sx(p), p.tip, 'stem'));
        if (!p.beamed && [1, 2, 3].includes(p.ticks)) {
          const fl = p.ticks === 1 ? (p.up ? G.f16u : G.f16d) : p.up ? G.f8u : G.f8d;
          add(p.ev, glyph(sx(p) - 0.06 * sp, p.tip, fl));
        }
      }
      if (p.tieTo) {
        const q = p.tieTo, n = p.heads.length;
        p.heads.forEach((h, i) => {
          const side = n === 1 ? (p.up ? 1 : -1) : i >= n / 2 ? -1 : 1;     // upper notes tie above, lower below
          const qh = q.heads.find(o => o.t === h.t) || q.heads[i];
          const y = Y(p.k, h.pos) + side * 0.62 * sp;
          if (q.k === p.k) add(p.ev, tieArc(right + 0.12 * sp, q.x + qh.side * q.hw - 0.12 * sp, y, side));
          else {
            add(p.ev, tieArc(right + 0.12 * sp, systems[p.k].xEnd - 0.3 * sp, y, side));
            const qx = q.x + qh.side * q.hw;
            add(q.ev, tieArc(qx - 2.4 * sp, qx - 0.12 * sp, Y(q.k, qh.pos) + side * 0.62 * sp, side));
          }
        });
      }
    }
    for (const m of empties) {
      const k = sysOf(m);
      implicit.push(glyph(mX(m) + mw(k) / 2 - 0.56 * sp, Y(k, 6), G.rW, 'g faint'));
    }
  }

  // Geometry for input handling
  const perStaff = staves.map(({ events: evs, used }) => {
    const starts = [];
    let t = 0;
    for (const e of evs) { starts.push(t); t += ticksOf(e); }
    return { used, starts };
  });
  const geo = {
    sp, tpm, systems, tx, Y: Yg, yB, sysH, nStaves: nSt,
    staves: perStaff, used: perStaff[0].used, starts: perStaff[0].starts,
    /** Pointer (x,y) in SVG coords → {k, s, m, tick, abs, pos} or null when outside the staff area.
     *  s is the nearer staff; pos is relative to that staff's bottom line. */
    locate(x, y) {
      const k = Math.floor(y / sysH);
      const sys = systems[k];
      if (!sys || x < sys.xStart - 0.5 * sp || x > sys.xEnd) return null;
      let s = 0;
      while (s < nSt - 1 && y > yB(k, s) + (gap - 4 * sp) / 2) s++;
      let m = sys.mFirst;
      while (m < sys.mLast && x >= mX(m + 1)) m++;
      let best = 0, bd = Infinity;
      for (let t = 0; t < tpm; t++) { const d = Math.abs(tx(m, t) - x); if (d < bd) { bd = d; best = t; } }
      const pos = Math.round((yB(k, s) - y) / (sp / 2));
      return { k, s, m, tick: best, abs: m * tpm + best, pos };
    },
    /** → {s, ev, tone} for the notehead or rest under the pointer, or null. */
    hitEvent(x, y) {
      for (const h of hits) if (x >= h.x1 && x <= h.x2 && y >= h.y1 && y <= h.y2) return { s: h.s, ev: h.ev, tone: h.tone };
      return null;
    },
    /** Absolute tick → x/k (for drawing the insert marker before the event starting there). */
    slotX(abs) {
      const m = Math.min(Math.floor(abs / tpm), tune.measures - 1), tick = abs - m * tpm;
      return { k: sysOf(m), x: tx(m, tick, false) - (tick ? 0.9 : 0.7) * sp };
    },
    /** Horizontal extent of an event's first piece: {k, x1, x2}. The head plus half a head's width
     *  either side; the rest of the gap between neighbours stays free for inserting a new beat. */
    eventSpan(i, s = 0) {
      const p = staves[s].pcs.find(q => q.ev === i);
      if (!p) return null;
      const hw = p.hw || sp;
      return { k: p.k, x: p.x, x1: p.x - hw / 2, x2: p.x + 1.5 * hw };
    },
  };

  return { width, height: sysN * sysH + 0.6 * sp, sp, staff, events, implicit, beams, geo };
}
