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
});
