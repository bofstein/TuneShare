// Tune model and pure edit operations. Every op returns {tune} or {error}.
// Rules: context/02-data-model.md (ripple editing, overflow trimming).
import { TICKS_PER_MEASURE, TICKS_TO_DUR, spell, spellAligned, ticksOf } from './theory.js';

export const MAX_MEASURES = 12;

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
  return fitted ? { tune: { ...next, events: fitted } } : { error: 'measure-not-empty' };
}

/** Change time signature; grows the measure count if needed. */
export function setTime(tune, time) {
  const mt = TICKS_PER_MEASURE[time], u = used(tune.events);
  const needed = Math.max(tune.measures, Math.ceil(u / mt));
  if (needed > MAX_MEASURES) return { error: ERR_FULL };
  return { tune: { ...tune, time, measures: needed }, expanded: needed !== tune.measures ? needed : 0 };
}
