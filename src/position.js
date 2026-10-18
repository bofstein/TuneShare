// Geometric and hit-test calculations for notation layout and pointer positioning.
import {
  CLEFS,
  DUR_TICKS,
  clampDiatonic,
  diatonic,
  fromDiatonic,
  keyAlter,
} from './theory.js';
import * as M from './model.js';

/**
 * Determine insertion index visually from pointer x relative to events on a system.
 * When x is null (e.g. keyboard or tick-based locate), search by tick offset.
 */
export function findVisualIndex(x, loc, ev, geo, starts, sp) {
  if (x == null) {
    let j = 0;
    while (j < ev.length - 1 && starts[j + 1] <= loc.abs) j++;
    const len = DUR_TICKS[ev[j].dur];
    return loc.abs - starts[j] < len / 2 ? j : j + 1;
  }
  const sysEvents = [];
  for (let i = 0; i < ev.length; i++) {
    const span = geo.eventSpan(i, loc.s);
    if (span && span.k === loc.k) sysEvents.push({ i, span });
  }
  if (!sysEvents.length) return 0;
  if (x < sysEvents[0].span.x) return sysEvents[0].i;
  const hw = 1.18 * sp;
  if (x >= sysEvents[sysEvents.length - 1].span.x + hw) {
    return sysEvents[sysEvents.length - 1].i + 1;
  }
  for (let r = 0; r < sysEvents.length - 1; r++) {
    if (x >= sysEvents[r].span.x && x < sysEvents[r + 1].span.x) {
      return sysEvents[r + 1].i;
    }
  }
  return sysEvents[sysEvents.length - 1].i + 1;
}

/**
 * Compute dynamically clamped x position for the insertion shadow note between existing events.
 */
export function shadowX(index, loc, x, ev, geo, sp, starts, defaultX) {
  if (x == null || !ev.length) return defaultX;
  const hw = 1.18 * sp, st = loc.s;
  if (index > 0 && index < ev.length) {
    const spanLeft = geo.eventSpan(index - 1, st);
    const spanRight = geo.eventSpan(index, st);
    if (spanLeft && spanRight && spanLeft.k === loc.k && spanRight.k === loc.k) {
      const mLeft = Math.floor(starts[index - 1] / geo.tpm);
      const mRight = Math.floor(starts[index] / geo.tpm);
      const isDotted = [3, 6, 12].includes(DUR_TICKS[ev[index - 1].dur]);
      const leftEdge = mLeft === mRight
        ? spanLeft.x + hw + (isDotted ? 0.65 : 0.15) * sp
        : geo.tx(mRight, 0, false) - 1.2 * sp;
      const minX = leftEdge + hw / 2;
      return defaultX > minX ? Math.max(minX, Math.min(defaultX, x)) : (leftEdge + defaultX) / 2;
    }
    if (spanRight && spanRight.k === loc.k) {
      const minX = Math.max(geo.systems[loc.k].xStart, defaultX - 3.0 * sp) + hw / 2;
      return defaultX > minX ? Math.max(minX, Math.min(defaultX, x)) : defaultX;
    }
  } else if (index === 0) {
    const spanRight = geo.eventSpan(0, st);
    if (spanRight && spanRight.k === loc.k) {
      const leftEdge = Math.max(geo.systems[loc.k].xStart - 1.0 * sp, defaultX - 3.5 * sp);
      const minX = leftEdge + hw / 2;
      return defaultX > minX ? Math.max(minX, Math.min(defaultX, x)) : defaultX;
    }
  } else if (index >= ev.length) {
    const spanLeft = geo.eventSpan(ev.length - 1, st);
    if (spanLeft && spanLeft.k === loc.k) {
      const isDotted = [3, 6, 12].includes(DUR_TICKS[ev[ev.length - 1].dur]);
      const minX = spanLeft.x + hw + (isDotted ? 0.65 : 0.15) * sp + hw / 2;
      return Math.max(minX, x);
    }
  }
  return defaultX;
}

/**
 * Compute where an insert at (loc) would go: {st, index|tick, k, x, abs, free?}.
 * st = the staff under the pointer.
 */
export function slotFor(loc, x, tune, geo, sp) {
  const st = loc.s, ev = M.staffEvents(tune, st), { used, starts } = geo.staves[st];
  if (loc.abs >= used) {
    const tick = Math.min(Math.round(loc.abs / 2) * 2, M.capacity(tune) - 1);
    if (tick <= used) {
      const s = geo.slotX(used);
      const targetX = shadowX(ev.length, loc, x, ev, geo, sp, starts, s.x);
      return { st, index: ev.length, k: s.k, x: targetX, abs: used };
    }
    const m = Math.floor(tick / geo.tpm);
    const k = geo.systems.findIndex(sys => m >= sys.mFirst && m <= sys.mLast);
    return { st, tick, k, x: geo.tx(m, tick - m * geo.tpm), abs: tick, free: true };
  }
  const index = findVisualIndex(x, loc, ev, geo, starts, sp);
  const abs = index < ev.length ? starts[index] : used;
  const s = geo.slotX(abs);
  const targetX = shadowX(index, loc, x, ev, geo, sp, starts, s.x);
  return { st, index, k: s.k, x: targetX, abs };
}

/**
 * Return diatonic staff-step position clamped to the staff's clef range.
 */
export function ghostPos(loc, tune) {
  const clef = M.staffView(tune, loc.s).clef;
  const c = CLEFS[clef];
  return clampDiatonic(clef, loc.pos + c.bottom) - c.bottom;
}

/**
 * Pointer in the column of a note but not on a head (above/below it) -> the chord tone a click would add.
 */
export function chordTargetAt(x, y, tune, geo, pointerType) {
  if (!geo || pointerType === 'touch') return null;
  const loc = geo.locate(x, y);
  if (!loc) return null;
  const evs = M.staffEvents(tune, loc.s);
  for (let i = 0; i < evs.length; i++) {
    const e = evs[i], span = geo.eventSpan(i, loc.s);
    if (!span || span.k !== loc.k || x < span.x1 || x > span.x2) continue;
    if (e.rest) return null;
    const view = M.staffView(tune, loc.s), c = CLEFS[view.clef];
    const d = clampDiatonic(view.clef, loc.pos + c.bottom), p = fromDiatonic(d);
    if (M.pitchesOf(e).some(q => diatonic(q) === d) || M.pitchesOf(e).length >= M.MAX_CHORD_NOTES) return null;
    return {
      st: loc.s,
      ev: i,
      pitch: { ...p, alter: keyAlter(view.key, p.step) },
      k: span.k,
      x: span.x,
      pos: d - c.bottom,
      dur: e.dur,
    };
  }
  return null;
}
