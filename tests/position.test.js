import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultTune } from '../src/model.js';
import { layout } from '../src/layout.js';
import {
  findVisualIndex,
  shadowX,
  slotFor,
  ghostPos,
  chordTargetAt,
} from '../src/position.js';

test('ghostPos clamps within staff clef range', () => {
  const tune = defaultTune();
  // Treble clef: bottom is E4 (diatonic 30), min 24 (pos -6), max 44 (pos 14)
  assert.equal(ghostPos({ s: 0, pos: 0 }, tune), 0);
  assert.equal(ghostPos({ s: 0, pos: -20 }, tune), -6);
  assert.equal(ghostPos({ s: 0, pos: 30 }, tune), 14);
});

test('slotFor returns free tick for clicks in empty measures', () => {
  const tune = defaultTune(); // 4 bars empty by default, 0 used
  const lay = layout(tune, { width: 600, perSys: 2, sp: 10 });
  const loc = { s: 0, k: 0, abs: 8, pos: 4 }; // tick 8 (bar 1, beat 3)
  const slot = slotFor(loc, null, tune, lay.geo, lay.sp);
  assert.equal(slot.st, 0);
  assert.equal(slot.free, true);
  assert.equal(slot.tick, 8);
});

test('slotFor identifies note index when events exist', () => {
  const tune = {
    ...defaultTune(),
    events: [
      { step: 0, oct: 4, alter: 0, dur: 2 }, // quarter C4 (4 ticks)
      { step: 2, oct: 4, alter: 0, dur: 2 }, // quarter E4 (4 ticks)
    ],
  };
  const lay = layout(tune, { width: 600, perSys: 2, sp: 10 });
  // loc at tick 2 (middle of first note)
  const loc = { s: 0, k: 0, abs: 2, pos: 2 };
  const slot = slotFor(loc, null, tune, lay.geo, lay.sp);
  assert.equal(slot.st, 0);
  assert.equal(slot.free, undefined);
  assert.equal(slot.index, 1);
});

test('chordTargetAt ignores touch events and rests', () => {
  const tune = {
    ...defaultTune(),
    events: [{ rest: true, dur: 2 }],
  };
  const lay = layout(tune, { width: 600, perSys: 2, sp: 10 });
  const span = lay.geo.eventSpan(0, 0);
  // Touch
  assert.equal(chordTargetAt(span.x, 50, tune, lay.geo, 'touch'), null);
  // Mouse on rest
  assert.equal(chordTargetAt(span.x, 50, tune, lay.geo, 'mouse'), null);
});

test('chordTargetAt detects valid chord tone above/below note', () => {
  const tune = {
    ...defaultTune(),
    events: [{ step: 0, oct: 4, alter: 0, dur: 2 }], // C4 (pos -2 in treble)
  };
  const lay = layout(tune, { width: 600, perSys: 2, sp: 10 });
  const span = lay.geo.eventSpan(0, 0);
  // Target pos 2 (G4)
  const y = lay.geo.yB(span.k, 0) - 2 * (lay.sp / 2);
  const target = chordTargetAt(span.x, y, tune, lay.geo, 'mouse');
  assert.ok(target, 'Should find target');
  assert.equal(target.st, 0);
  assert.equal(target.ev, 0);
  assert.equal(target.pitch.step, 4); // G
  assert.equal(target.pitch.oct, 4);

  // Null geo returns null
  assert.equal(chordTargetAt(span.x, y, tune, null, 'mouse'), null);

  // Out of bounds y returns null
  assert.equal(chordTargetAt(span.x, -999, tune, lay.geo, 'mouse'), null);

  // Pointer horizontally outside note span returns null
  assert.equal(chordTargetAt(span.x + 200, y, tune, lay.geo, 'mouse'), null);

  // Duplicate pitch in chord returns null
  const yC4 = lay.geo.yB(span.k, 0) - (-2) * (lay.sp / 2);
  assert.equal(chordTargetAt(span.x, yC4, tune, lay.geo, 'mouse'), null);

  // Max chord notes full returns null
  const fullChordTune = {
    ...defaultTune(),
    events: [{
      step: 0, oct: 4, alter: 0, dur: 2,
      tones: [
        { step: 2, oct: 4, alter: 0 },
        { step: 4, oct: 4, alter: 0 },
        { step: 6, oct: 4, alter: 0 },
      ],
    }],
  };
  const fullLay = layout(fullChordTune, { width: 600, perSys: 2, sp: 10 });
  assert.equal(chordTargetAt(span.x, y, fullChordTune, fullLay.geo, 'mouse'), null);
});

test('findVisualIndex determines index from tick offset or pointer x', () => {
  const tune = {
    ...defaultTune(),
    events: [
      { step: 0, oct: 4, alter: 0, dur: 2 }, // quarter: 4 ticks (starts 0)
      { step: 2, oct: 4, alter: 0, dur: 2 }, // quarter: 4 ticks (starts 4)
      { step: 4, oct: 4, alter: 0, dur: 2 }, // quarter: 4 ticks (starts 8)
    ],
  };
  const lay = layout(tune, { width: 600, perSys: 2, sp: 10 });
  const starts = lay.geo.staves[0].starts;
  const ev = tune.events;
  const loc = { s: 0, k: 0, abs: 1 }; // tick 1 of note 0

  // Searching by tick offset when x == null
  // tick 1 is < len/2 (4/2 = 2) -> index 0
  assert.equal(findVisualIndex(null, { ...loc, abs: 1 }, ev, lay.geo, starts, lay.sp), 0);
  // tick 3 is >= len/2 -> index 1
  assert.equal(findVisualIndex(null, { ...loc, abs: 3 }, ev, lay.geo, starts, lay.sp), 1);

  // Searching visually by x coordinate
  const s0 = lay.geo.eventSpan(0, 0);
  const s1 = lay.geo.eventSpan(1, 0);
  const s2 = lay.geo.eventSpan(2, 0);

  // x before first event
  assert.equal(findVisualIndex(s0.x - 20, loc, ev, lay.geo, starts, lay.sp), 0);
  // x between event 0 and 1
  const mid01 = (s0.x + s1.x) / 2;
  assert.equal(findVisualIndex(mid01, loc, ev, lay.geo, starts, lay.sp), 1);
  // x between event 1 and 2
  const mid12 = (s1.x + s2.x) / 2;
  assert.equal(findVisualIndex(mid12, loc, ev, lay.geo, starts, lay.sp), 2);
  // x after last event
  assert.equal(findVisualIndex(s2.x + 50, loc, ev, lay.geo, starts, lay.sp), 3);

  // No events in system k=1 returns 0
  const emptyLoc = { s: 0, k: 1, abs: 0 };
  assert.equal(findVisualIndex(100, emptyLoc, ev, lay.geo, starts, lay.sp), 0);
});

test('shadowX computes clamped note placement position', () => {
  const tune = {
    ...defaultTune(),
    events: [
      { step: 0, oct: 4, alter: 0, dur: 6 }, // dotted quarter (6 ticks) in bar 0
      { step: 2, oct: 4, alter: 0, dur: 2 }, // quarter (4 ticks) in bar 0
      { step: 4, oct: 4, alter: 0, dur: 3 }, // half (8 ticks) in bar 0 (tick 10 to 18 -> crosses to bar 1)
    ],
  };
  const lay = layout(tune, { width: 600, perSys: 2, sp: 10 });
  const starts = lay.geo.staves[0].starts;
  const ev = tune.events;
  const loc = { s: 0, k: 0, abs: 0 };

  // Null x or empty events returns defaultX
  assert.equal(shadowX(0, loc, null, ev, lay.geo, lay.sp, starts, 100), 100);
  assert.equal(shadowX(0, loc, 50, [], lay.geo, lay.sp, starts, 100), 100);

  // index === 0 (at start of system)
  const sx0 = shadowX(0, loc, 10, ev, lay.geo, lay.sp, starts, 100);
  assert.ok(typeof sx0 === 'number' && sx0 > 0);

  // index === 1 (between dotted quarter and quarter in same measure)
  const sx1 = shadowX(1, loc, 150, ev, lay.geo, lay.sp, starts, 180);
  assert.ok(typeof sx1 === 'number' && sx1 > 0);

  // index === ev.length (after last note, non-dotted)
  const sxEnd = shadowX(ev.length, loc, 300, ev, lay.geo, lay.sp, starts, 250);
  assert.ok(typeof sxEnd === 'number' && sxEnd >= 300);

  // index === ev.length with dotted last note
  const dottedEndTune = {
    ...defaultTune(),
    events: [{ step: 0, oct: 4, alter: 0, dur: 6 }], // dotted quarter
  };
  const dotLay = layout(dottedEndTune, { width: 600, perSys: 2, sp: 10 });
  const dotStarts = dotLay.geo.staves[0].starts;
  const sxDot = shadowX(1, loc, 200, dottedEndTune.events, dotLay.geo, dotLay.sp, dotStarts, 150);
  assert.ok(typeof sxDot === 'number' && sxDot >= 150);
});

test('slotFor positions insertion pointer correctly across measures and used bounds', () => {
  const tune = {
    ...defaultTune(),
    events: [
      { step: 0, oct: 4, alter: 0, dur: 2 }, // 4 ticks
      { step: 2, oct: 4, alter: 0, dur: 2 }, // 4 ticks -> used = 8
    ],
  };
  const lay = layout(tune, { width: 600, perSys: 2, sp: 10 });

  // Pointer at exact end of used ticks (loc.abs >= used but tick <= used)
  const locEnd = { s: 0, k: 0, abs: 8, pos: 2 };
  const slotEnd = slotFor(locEnd, 120, tune, lay.geo, lay.sp);
  assert.equal(slotEnd.st, 0);
  assert.equal(slotEnd.index, 2);
  assert.equal(slotEnd.abs, 8);

  // Pointer before used ticks with x coordinate provided
  const locBefore = { s: 0, k: 0, abs: 2, pos: 2 };
  const slotBefore = slotFor(locBefore, 50, tune, lay.geo, lay.sp);
  assert.equal(slotBefore.st, 0);
  assert.ok(typeof slotBefore.index === 'number');
  assert.ok(typeof slotBefore.x === 'number');
});
