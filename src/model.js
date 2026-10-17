// Tune model and pure edit operations. Every op returns {tune} or {error}.
// Rules: DESIGN.md, "Editing rules" (ripple editing, overflow trimming).
import { TICKS_PER_MEASURE, TICKS_TO_DUR, spell, spellAligned, ticksOf } from './theory.js';

export const MAX_MEASURES = 20;

// staff2 is absent for a one-staff tune.
export const defaultTune = () => ({ title: '', bpm: 100, key: 0, clef: 'treble', time: '4/4', measures: 4, events: [] });

export const measureTicks = t => TICKS_PER_MEASURE[t.time];
export const capacity = t => t.measures * measureTicks(t);
export const used = events => events.reduce((a, e) => a + ticksOf(e), 0);
export const startTick = (events, i) => used(events.slice(0, i));

const rests = len => spell(len).map(v => ({ rest: true, dur: TICKS_TO_DUR[v] }));

export const ERR_FULL = 'full';

/** Drop events from the end until they fit (used by the lenient URL decoder only). */
export function trimToCapacity(events, cap) {
  const out = [];
  let t = 0;
  for (const e of events) { if (t + ticksOf(e) > cap) break; out.push(e); t += ticksOf(e); }
  return out;
}

/**
 * Make `events` fit in `cap` by removing or shortening trailing rests.
 * Returns null if a note would have to be pushed off the end.
 */
export function fit(events, cap) {
  let overflow = used(events) - cap;
  if (overflow <= 0) return events;
  const out = events.slice();
  while (overflow > 0) {
    const last = out[out.length - 1];
    if (!last || !last.rest) return null;
    const len = ticksOf(last);
    out.pop();
    if (len > overflow) { out.push(...rests(len - overflow)); overflow = 0; }
    else overflow -= len;
  }
  return out;
}

const withEvents = (tune, events) => {
  const fitted = fit(events, capacity(tune));
  return fitted ? { tune: { ...tune, events: fitted } } : { error: ERR_FULL };
};

export const insert = (tune, index, event) =>
  withEvents(tune, [...tune.events.slice(0, index), event, ...tune.events.slice(index)]);

/** Insert at an absolute tick past the end of the content, padding with rests. */
export function insertAtTick(tune, tick, event) {
  const u = used(tune.events);
  if (tick <= u) return insert(tune, tune.events.length, event);
  const mt = measureTicks(tune), pad = [];
  let t = u;
  while (t < tick) {
    const m = Math.floor(t / mt), end = Math.min(tick, (m + 1) * mt);
    for (const [, v] of spellAligned(t - m * mt, end - t)) pad.push({ rest: true, dur: TICKS_TO_DUR[v] });
    t = end;
  }
  return withEvents(tune, [...tune.events, ...pad, event]);
}

export const remove = (tune, i) => ({ tune: { ...tune, events: tune.events.filter((_, k) => k !== i) } });

export function replace(tune, i, event) {
  const events = tune.events.slice();
  events[i] = event;
  return withEvents(tune, events);
}

export const setDuration = (tune, i, dur) => replace(tune, i, { ...tune.events[i], dur });

export function swap(tune, i, dir) {
  const j = i + dir;
  if (j < 0 || j >= tune.events.length) return { tune };
  const events = tune.events.slice();
  [events[i], events[j]] = [events[j], events[i]];
  return { tune: { ...tune, events } };
}

export function setMeasures(tune, n) {
  if (n < 1 || n > MAX_MEASURES) return { tune };
  const next = { ...tune, measures: n };
  const fitted = fit(tune.events, capacity(next));
  const fitted2 = tune.staff2 && fit(tune.staff2.events, capacity(next));
  if (!fitted || (tune.staff2 && !fitted2)) return { error: 'measure-not-empty' };
  return { tune: { ...next, events: fitted, ...(tune.staff2 && { staff2: { ...tune.staff2, events: fitted2 } }) } };
}

/** Change time signature; grows the measure count if needed. */
export function setTime(tune, time) {
  const mt = TICKS_PER_MEASURE[time], u = Math.max(used(tune.events), tune.staff2 ? used(tune.staff2.events) : 0);
  const needed = Math.max(tune.measures, Math.ceil(u / mt));
  if (needed > MAX_MEASURES) return { error: ERR_FULL };
  return { tune: { ...tune, time, measures: needed }, expanded: needed !== tune.measures ? needed : 0 };
}

// ---------- chords ----------
// A note event may carry extra simultaneous pitches in `tones` (same length).
// The URL format has no limit; this is the editor's limit and can be raised freely.
export const MAX_CHORD_NOTES = 5;

const pitchOnly = p => ({ step: p.step, oct: p.oct, alter: p.alter });
export const pitchesOf = e => (e.rest ? [] : [pitchOnly(e), ...(e.tones || [])]);
const sameLine = (a, b) => a.oct * 7 + a.step === b.oct * 7 + b.step;

/** Build a note event from a list of pitches (first = main), dropping empty `tones`. */
export function withPitches(e, pitches) {
  const [main, ...rest] = pitches;
  const out = { dur: e.dur, ...pitchOnly(main) };
  if (rest.length) out.tones = rest.map(pitchOnly);
  return out;
}

export function addTone(tune, i, pitch) {
  const e = tune.events[i];
  if (!e || e.rest) return { error: 'not-a-note' };
  const ps = pitchesOf(e);
  if (ps.length >= MAX_CHORD_NOTES) return { error: 'chord-full' };
  if (ps.some(p => sameLine(p, pitch))) return { error: 'duplicate' };
  return replace(tune, i, withPitches(e, [...ps, pitch]));
}

/** Remove tone t (0 = main pitch). The next tone becomes the main pitch. */
export function removeTone(tune, i, t) {
  const e = tune.events[i], ps = pitchesOf(e);
  if (ps.length <= 1) return remove(tune, i);
  return replace(tune, i, withPitches(e, ps.filter((_, k) => k !== t)));
}

export function setTonePitch(tune, i, t, pitch) {
  const e = tune.events[i], ps = pitchesOf(e);
  if (ps.some((p, k) => k !== t && sameLine(p, pitch))) return { error: 'duplicate' };
  ps[t] = pitch;
  return replace(tune, i, withPitches(e, ps));
}

// ---------- second staff ----------
// Staff 0 is tune.clef + tune.events (as before); an optional second staff is tune.staff2 = {clef, events}.
// Both staves share every other header field, including measures and time, so they have the same capacity.
// Edit ops above work on one staff at a time through a view: a tune whose clef/events are that staff's.
export const MAX_STAVES = 2;
export const staffCount = t => (t.staff2 ? 2 : 1);
export const staffEvents = (t, s) => (s ? t.staff2.events : t.events);
export const staffList = t => [{ clef: t.clef, events: t.events }, ...(t.staff2 ? [t.staff2] : [])];

/** The tune as seen from staff s: header fields plus that staff's clef and events. */
export const staffView = (t, s) => (s && t.staff2 ? { ...t, clef: t.staff2.clef, events: t.staff2.events } : t);

/** Write a view (possibly with header changes) back into the tune as staff s. */
export function withStaffView(t, s, view) {
  if (!s) return { ...view, staff2: t.staff2 };
  const { clef, events, staff2, ...header } = view;
  return { ...header, clef: t.clef, events: t.events, staff2: { clef, events } };
}

const restsOnly = events => events.every(e => e.rest);

export function addStaff(t) {
  if (t.staff2) return { tune: t };
  return { tune: { ...t, staff2: { clef: t.clef === 'bass' ? 'treble' : 'bass', events: [] } } };
}

/** Remove staff s. Only a staff holding nothing but rests can be removed. */
export function removeStaff(t, s) {
  if (!t.staff2) return { tune: t };
  if (!restsOnly(staffEvents(t, s))) return { error: 'staff-not-empty' };
  const { staff2, ...rest } = t;
  return { tune: s ? rest : { ...rest, clef: staff2.clef, events: staff2.events } };
}
