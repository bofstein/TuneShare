import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPieces, beamGroups, assignHeads, assignAccidentals, assignAccidentalColumns, assignSides, layout, G } from '../src/layout.js';
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
  assignHeads(pcs, 30);
  assignAccidentals(pcs, 1);
  assert.deepEqual(pcs.filter(p => !p.rest).map(p => p.heads[0].acc ?? null), [null, G.nat, null, G.sharp, G.nat]);
});

test('layout locate maps back to ticks', () => {
  const lay = layout(tune('C4:q D4:q E4:q F4:q'), { width: 1000, perSys: 4, sp: 10 });
  const x = lay.geo.tx(1, 8);
  const loc = lay.geo.locate(x, lay.geo.Y(0, 4));
  assert.equal(loc.m, 1); assert.equal(loc.tick, 8); assert.equal(loc.pos, 4);
});

const chord = (src, ...tones) => {
  const t = tune(src);
  t.events[0].tones = tones.map(x => { const m = x.match(/^([A-G])([#b]?)(\d)$/); return { step: 'CDEFGAB'.indexOf(m[1]), oct: +m[3], alter: m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0 }; });
  return t;
};

test('chord heads are sorted bottom to top with tone indices kept', () => {
  const { pcs } = buildPieces(chord('G4:q', 'C4', 'E4'));
  assignHeads(pcs, 30);
  assert.deepEqual(pcs[0].heads.map(h => [h.pos, h.t]), [[-2, 1], [0, 2], [2, 0]]);
});

test('seconds sit on opposite sides of the stem', () => {
  const heads = [{ pos: 0 }, { pos: 1 }, { pos: 2 }];
  assignSides(heads, true);
  assert.deepEqual(heads.map(h => h.side), [0, 1, 0]);
  assignSides(heads, false);
  assert.deepEqual(heads.map(h => h.side), [0, -1, 0]);
});

test('accidentals closer than a sixth go in separate columns', () => {
  const heads = [{ pos: 0, acc: 'x' }, { pos: 2, acc: 'x' }, { pos: 8, acc: 'x' }];
  assert.equal(assignAccidentalColumns(heads), 2);
  assert.deepEqual(heads.map(h => h.col), [1, 0, 0]);   // placed top-down: 8 and 2 share a column
});

test('a tied chord ties every tone', () => {
  const t = tune('C4:q C4:q C4:q E4:h');
  t.events[3].tones = [{ step: 4, oct: 4, alter: 0 }];
  const lay = layout(t, { width: 1000 });
  const ties = [...lay.events[0].get(3)].filter(i => i.t === 'path');
  assert.equal(ties.length, 2);
});

test('two staves share bar lines and line up notes that sound together', () => {
  const t = { ...tune('C5:q F#5:q G5:h'), staff2: { clef: 'bass', events: tune('C3:q D3:q E3:h').events } };
  const lay = layout(t, { width: 1000 });
  assert.equal(lay.geo.nStaves, 2);
  const headX = (s, i) => lay.events[s].get(i).find(it => it.t === 'glyph' && [G.nhB, G.nhH].includes(it.g)).x;
  // F#5 gets an accidental allowance; the bass note at the same beat moves with it.
  assert.equal(headX(0, 1), headX(1, 1));
  assert.equal(headX(0, 2), headX(1, 2));
  const loc = lay.geo.locate(lay.geo.tx(0, 4), lay.geo.Y(0, 4, 1));
  assert.equal(loc.s, 1); assert.equal(loc.pos, 4);
  assert.equal(lay.geo.locate(lay.geo.tx(0, 4), lay.geo.Y(0, 4, 0)).s, 0);
  const hit = lay.geo.hitEvent(headX(1, 0) + 5, lay.geo.Y(0, 3, 1));
  assert.deepEqual(hit && [hit.s, hit.ev], [1, 0]);
});
