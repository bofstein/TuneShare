// Pure state querying, note construction, pitch math, and editing action builders.
import {
  CLEFS,
  canDot,
  clampDiatonic,
  diatonic,
  fromDiatonic,
  halfStep,
  keyAlter,
  toggleDot,
} from './theory.js';
import * as M from './model.js';

export const staffIdx = cursor => cursor?.staff || 0;

export const staffView = (tune, staffOrCursor) => {
  const s = typeof staffOrCursor === 'number' ? staffOrCursor : staffIdx(staffOrCursor);
  return M.staffView(tune, s);
};

export const twoStaves = tune => M.staffCount(tune) > 1;

export const staffName = s => (s ? 'lower staff' : 'upper staff');

export const selectedIndex = cursor => (cursor?.type === 'note' ? cursor.index : -1);

export const selectedEvent = (tune, cursor) => {
  const i = selectedIndex(cursor);
  return i >= 0 ? staffView(tune, cursor).events[i] || null : null;
};

export const selectedTone = (tune, cursor) => {
  const e = selectedEvent(tune, cursor);
  return e && !e.rest ? Math.min(cursor?.tone || 0, M.pitchesOf(e).length - 1) : 0;
};

export const selectedPitch = (tune, cursor) => {
  const e = selectedEvent(tune, cursor);
  return e && !e.rest ? M.pitchesOf(e)[selectedTone(tune, cursor)] : null;
};

export const insertIndex = cursor => (cursor?.type === 'note' ? cursor.index + 1 : (cursor?.index || 0));

export const activeDur = (tune, cursor, fallbackDur) => {
  const e = selectedEvent(tune, cursor);
  return e ? e.dur : fallbackDur;
};

/**
 * Find the diatonic position of the preceding sounding note to anchor the next note's octave.
 */
export function refDiatonic(events, index, clef) {
  for (let i = Math.min(index, events.length - 1); i >= 0; i--) {
    const e = events[i];
    if (!e.rest) return diatonic(e);
  }
  return CLEFS[clef].middle;
}

/**
 * Choose the octave of diatonic `step` (0-6) nearest to `ref`, clamped to `clef` range with `key` alteration.
 */
export function noteFor(step, ref, clef, key) {
  const base = step + 7 * Math.round((ref - step) / 7);
  let d = base;
  const c = CLEFS[clef];
  while (d < c.min) d += 7;
  while (d > c.max) d -= 7;
  return { ...fromDiatonic(d), alter: keyAlter(key, step) };
}

/**
 * Cycle tone selection in pitch order (bottom to top), not entry order.
 */
export function cycleTone(pitches, currentTone, dir) {
  if (pitches.length < 2) return currentTone;
  const order = pitches
    .map((p, t) => [diatonic(p), t])
    .sort((a, b) => a[0] - b[0])
    .map(([, t]) => t);
  const k = order.indexOf(currentTone);
  return order[(k + dir + order.length) % order.length];
}

/**
 * Move cursor left or right, transitioning between note selection and caret at edges.
 */
export function moveCursor(cursor, eventCount, dir) {
  if (!eventCount) return cursor;
  const s = staffIdx(cursor);
  let i = cursor.type === 'note' ? cursor.index + dir : (dir > 0 ? cursor.index : cursor.index - 1);
  if (i < 0) return { type: 'caret', index: 0, staff: s };
  if (i >= eventCount) return { type: 'caret', index: eventCount, staff: s };
  return { type: 'note', index: i, tone: 0, staff: s };
}

/**
 * Move cursor to the other staff, keeping the caret at the same point in time.
 */
export function switchStaff(cursor, stavesGeo, staffCount, dir) {
  const from = staffIdx(cursor);
  const to = from + dir;
  if (!stavesGeo || to < 0 || to >= staffCount) return cursor;
  const cur = stavesGeo[from];
  const tick = cursor.index < cur.starts.length ? cur.starts[cursor.index] : cur.used;
  const next = stavesGeo[to].starts;
  let index = next.findIndex(t => t >= tick);
  if (index < 0) index = next.length;
  return { type: 'caret', index, staff: to };
}

/**
 * Insert a note with diatonic letter `step` (0-6) or replace a selected rest.
 */
export function typeLetter(tune, cursor, step, dur) {
  const s = staffIdx(cursor);
  const view = M.staffView(tune, s);
  const sel = selectedEvent(tune, cursor);
  const selIdx = selectedIndex(cursor);

  if (sel && sel.rest) {
    const ref = refDiatonic(view.events, selIdx - 1, view.clef);
    const n = { ...noteFor(step, ref, view.clef, view.key), dur: sel.dur };
    return { result: M.replace(view, selIdx, n), cursor: null, sound: n, staff: s };
  }
  const idx = insertIndex(cursor);
  const ref = refDiatonic(view.events, idx - 1, view.clef);
  const n = { ...noteFor(step, ref, view.clef, view.key), dur: sel ? sel.dur : dur };
  return {
    result: M.insert(view, idx, n),
    cursor: { type: 'note', index: idx, staff: s },
    sound: n,
    staff: s,
  };
}

/**
 * Insert a rest or replace selected note with a rest.
 */
export function typeRest(tune, cursor, dur) {
  const s = staffIdx(cursor);
  const view = M.staffView(tune, s);
  const sel = selectedEvent(tune, cursor);
  const selIdx = selectedIndex(cursor);

  if (sel && !sel.rest) {
    return {
      result: M.replace(view, selIdx, { rest: true, dur: sel.dur }),
      cursor: null,
      staff: s,
    };
  }
  const idx = insertIndex(cursor);
  return {
    result: M.insert(view, idx, { rest: true, dur: sel ? sel.dur : dur }),
    cursor: { type: 'note', index: idx, staff: s },
    staff: s,
  };
}

/**
 * Add a chord tone with letter `step` to the selected note, in nearest octave above selected pitch.
 */
export function addToneLetter(tune, cursor, step, dur) {
  const sel = selectedEvent(tune, cursor);
  const sp = selectedPitch(tune, cursor);
  if (!sel || sel.rest) return typeLetter(tune, cursor, step, dur);

  const s = staffIdx(cursor);
  const view = M.staffView(tune, s);
  const c = CLEFS[view.clef], ref = diatonic(sp);
  let d = step + 7 * Math.ceil((ref + 1 - step) / 7);
  if (d > c.max) d -= 7;
  const p = { ...fromDiatonic(d), alter: keyAlter(view.key, step) };
  const i = selectedIndex(cursor);
  return {
    result: M.addTone(view, i, p),
    cursor: { type: 'note', index: i, tone: M.pitchesOf(sel).length, staff: s },
    sound: p,
    staff: s,
  };
}

/**
 * Add a specified pitch to the selected chord.
 */
export function addTone(tune, cursor, pitch) {
  const s = staffIdx(cursor);
  const view = M.staffView(tune, s);
  const sel = selectedEvent(tune, cursor);
  const i = selectedIndex(cursor);
  return {
    result: M.addTone(view, i, pitch),
    cursor: { type: 'note', index: i, tone: sel ? M.pitchesOf(sel).length : 0, staff: s },
    sound: pitch,
    staff: s,
  };
}

/**
 * Change duration of the selected note or update default input duration.
 */
export function setDuration(tune, cursor, base) {
  const s = staffIdx(cursor);
  const view = M.staffView(tune, s);
  const sel = selectedEvent(tune, cursor);
  if (!sel) return { inputDur: base };
  const dur = sel.dur >= 5 && canDot(base) ? base + 4 : base;
  return { result: M.setDuration(view, selectedIndex(cursor), dur), staff: s };
}

/**
 * Toggle dotted state of selected note or default input duration.
 */
export function toggleDotted(tune, cursor, inputDur) {
  const s = staffIdx(cursor);
  const view = M.staffView(tune, s);
  const sel = selectedEvent(tune, cursor);
  if (!sel) return { inputDur: toggleDot(inputDur) };
  if (canDot(sel.dur) || sel.dur >= 5) {
    return { result: M.setDuration(view, selectedIndex(cursor), toggleDot(sel.dur)), staff: s };
  }
  return {};
}

/**
 * Move selected pitch diatonically by `steps` (+1 = step up, -1 = step down, +7 = octave up).
 */
export function movePitch(tune, cursor, steps) {
  const cur = selectedPitch(tune, cursor);
  if (!cur) return null;
  const s = staffIdx(cursor);
  const view = M.staffView(tune, s);
  const d = clampDiatonic(view.clef, diatonic(cur) + steps);
  const p = {
    ...fromDiatonic(d),
    alter: Math.abs(steps) === 7 ? cur.alter : keyAlter(view.key, fromDiatonic(d).step),
  };
  return {
    result: M.setTonePitch(view, selectedIndex(cursor), selectedTone(tune, cursor), p),
    cursor: null,
    sound: p,
    staff: s,
  };
}

/**
 * Move the selected pitch a half step up or down; stays put at the edge of the staff's range.
 */
export function moveHalfStep(tune, cursor, dir) {
  const cur = selectedPitch(tune, cursor);
  if (!cur) return null;
  const s = staffIdx(cursor);
  const view = M.staffView(tune, s);
  const p = halfStep(cur, dir, view.key);
  if (diatonic(p) !== clampDiatonic(view.clef, diatonic(p))) return null;
  return {
    result: M.setTonePitch(view, selectedIndex(cursor), selectedTone(tune, cursor), p),
    cursor: null,
    sound: p,
    staff: s,
  };
}

/**
 * Set or toggle accidental of selected pitch.
 */
export function setAlter(tune, cursor, alter) {
  const cur = selectedPitch(tune, cursor);
  if (!cur) return null;
  const s = staffIdx(cursor);
  const view = M.staffView(tune, s);
  const keyDefault = keyAlter(view.key, cur.step);
  const p = { ...cur, alter: cur.alter === alter && alter !== keyDefault ? keyDefault : alter };
  return {
    result: M.setTonePitch(view, selectedIndex(cursor), selectedTone(tune, cursor), p),
    cursor: null,
    sound: p,
    staff: s,
  };
}

/**
 * Delete selected tone, note, or event before caret.
 */
export function deleteSel(tune, cursor) {
  const s = staffIdx(cursor);
  const view = M.staffView(tune, s);
  const i = selectedIndex(cursor);

  if (i < 0) {
    // Backspace at caret deletes event before it
    const c = cursor?.index || 0;
    if (c > 0) {
      return { result: M.remove(view, c - 1), cursor: { type: 'caret', index: c - 1, staff: s }, staff: s };
    }
    return null;
  }
  const e = view.events[i];
  if (!e.rest && M.pitchesOf(e).length > 1) {
    // In a chord, delete just the selected tone; keep chord selected
    return {
      result: M.removeTone(view, i, selectedTone(tune, cursor)),
      cursor: { type: 'note', index: i, tone: 0, staff: s },
      staff: s,
    };
  }
  return {
    result: M.remove(view, i),
    cursor: i > 0 ? { type: 'note', index: i - 1, staff: s } : { type: 'caret', index: 0, staff: s },
    staff: s,
  };
}

/**
 * Swap selected note with neighbor (dir = -1 left, +1 right).
 */
export function swapSel(tune, cursor, dir) {
  const i = selectedIndex(cursor);
  if (i < 0) return null;
  const s = staffIdx(cursor);
  const view = M.staffView(tune, s);
  const j = i + dir;
  if (j < 0 || j >= view.events.length) return null;
  return {
    result: M.swap(view, i, dir),
    cursor: { type: 'note', index: j, staff: s },
    staff: s,
  };
}
