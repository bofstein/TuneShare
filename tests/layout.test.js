import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPieces, beamGroups, assignAccidentals, layout, G } from '../src/layout.js';
import { tune } from './helpers.js';

test('half note on beat 4 splits into tied quarters', () => {
  const { pcs } = buildPieces(tune('C4:q C4:q C4:q D4:h'));
  const d = pcs.filter(p => p.ev === 3);
  assert.deepEqual(d.map(p => [p.m, p.tick, p.ticks]), [[0, 12, 4], [1, 0, 4]]);
  assert.equal(d[0].tieTo, d[1]);
});

test('5-tick remainder spells as quarter + 16th', () => {
  const { pcs } = buildPieces(tune('C4:h. r:s D4:w'));
  const d = pcs.filter(p => p.ev === 2).map(p => p.ticks);
  // 16 ticks starting at tick 13: 3 in bar 1, then 13 = 12 + 1 in bar 2
  assert.deepEqual(d, [3, 12, 1]);
});

test('empty measures are reported and partial ones get rests', () => {
  const { pcs, empties } = buildPieces(tune('C4:q'));
  assert.deepEqual(empties, [1, 2, 3]);
  assert.deepEqual(pcs.filter(p => p.implicit).map(p => [p.tick, p.ticks]), [[4, 4], [8, 8]]);
});

test('beams group by beat, 4/4 vs 6/8', () => {
  const ev = 'C4:e C4:e C4:e C4:e C4:e C4:e';
  assert.deepEqual(beamGroups(buildPieces(tune(ev)).pcs, 4).map(g => g.length), [2, 2, 2]);
  assert.deepEqual(beamGroups(buildPieces(tune(ev, { time: '6/8' })).pcs, 6).map(g => g.length), [3, 3]);
});

test('rests break beams', () => {
  assert.deepEqual(beamGroups(buildPieces(tune('C4:e r:e C4:s C4:s C4:e')).pcs, 4).map(g => g.length), [3]);
});

test('accidentals follow key and measure state', () => {
  // G major: F# needs no sign, F natural does; repeat in same bar needs none; next bar resets.
  const { pcs } = buildPieces(tune('F#4:q F4:q F4:q C#5:q | F4:q', { key: 1 }));
  assignAccidentals(pcs, 1, 30);
  assert.deepEqual(pcs.filter(p => !p.rest).map(p => p.acc ?? null), [null, G.nat, null, G.sharp, G.nat]);
});

test('layout locate maps back to ticks', () => {
  const lay = layout(tune('C4:q D4:q E4:q F4:q'), { width: 1000, perSys: 4, sp: 10 });
  const x = lay.geo.tx(1, 8);
  const loc = lay.geo.locate(x, lay.geo.Y(0, 4));
  assert.equal(loc.m, 1); assert.equal(loc.tick, 8); assert.equal(loc.pos, 4);
});
