import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encode, decode, VERSION } from '../src/codec.js';
import { tune, ODE } from './helpers.js';

test('empty tune encodes to "2."', () => {
  assert.equal(encode(tune('')), '2.');
  assert.deepEqual(decode('#2.').tune, tune(''));
  assert.deepEqual(decode('#1.').tune, tune(''));
});

test('spec worked example', () => {
  assert.equal(encode(tune('B4:q B4:q C5:q D5:q')), '2.UgMotbA');
  // The v1 form of the same tune still decodes.
  assert.deepEqual(decode('#1.OgZGhGhGtG4').tune, tune('B4:q B4:q C5:q D5:q'));
});

test('decode reports the link version, so old links can be upgraded', () => {
  assert.equal(decode('#1.OgZGhGhGtG4').version, 1);
  assert.equal(decode('#2.UgMotbA').version, 2);
  assert.equal(decode(encode(tune('C4:q'))).version, VERSION);
});

// Fixture links must decode identically forever.
test('fixture: Ode to Joy link from the spec', () => {
  const link = '#1.CgpPZGUgdG8gSm95EHgYAjAIOi1GhGhGtG5G5GtGhGVGJGJGVGjGgmVmVGhGhGtG5G5GtGhGVGJGJGVGjGUmJmI';
  const r = decode(link);
  assert.equal(r.repaired, false);
  assert.deepEqual(r.tune, tune(ODE, { title: 'Ode to Joy', bpm: 120, key: 1, measures: 8 }));
});

test('random round trips', () => {
  let seed = 42;
  const rnd = n => { seed = (seed * 1103515245 + 12345) % 2147483648; return Math.floor((seed / 2147483648) * n); };
  for (let k = 0; k < 300; k++) {
    const time = ['4/4', '3/4', '2/4', '6/8'][rnd(4)];
    const cap = 20 * { '4/4': 16, '3/4': 12, '2/4': 8, '6/8': 12 }[time];
    const events = [];
    for (let i = 0, n = rnd(60), used = 0; i < n; i++) {
      const e = rnd(6) === 0 ? { rest: true, dur: rnd(8) } : { dur: rnd(8), step: rnd(7), oct: 1 + rnd(6), alter: rnd(3) - 1 };
      used += [1, 2, 4, 8, 16, 3, 6, 12][e.dur];
      if (used > cap) break;
      events.push(e);
    }
    const t = {
      title: rnd(2) ? 'Tüne ♪ ' + k : '', bpm: 40 + rnd(201), key: rnd(15) - 7, clef: rnd(2) ? 'bass' : 'treble',
      time, measures: 20, events,
    };
    const r = decode('#' + encode(t));
    assert.equal(r.repaired, false);
    assert.deepEqual(r.tune, t);
  }
});

test('truncated link keeps complete notes before the cut', () => {
  const full = encode(tune(ODE, { measures: 8 }));
  const r = decode('#' + full.slice(0, full.length - 4));
  assert.equal(r.repaired, true);
  assert.ok(r.tune.events.length > 10 && r.tune.events.length < 32);
  assert.deepEqual(r.tune.events, tune(ODE).events.slice(0, r.tune.events.length));
});

test('every prefix of a link decodes to a prefix of the notes', () => {
  const t = { ...tune(ODE, { measures: 8 }), staff2: { clef: 'bass', events: tune('C3:h G2:h C3:h G2:h').events } };
  t.events[2].tones = [{ step: 4, oct: 4, alter: 0 }];
  const full = encode(t);
  for (let n = 2; n < full.length; n++) {
    const r = decode('#' + full.slice(0, n));
    assert.deepEqual(r.tune.events, t.events.slice(0, r.tune.events.length), `prefix ${n}`);
  }
});

test('unknown fields are skipped', () => {
  // field 9 varint 5, then the spec example payload
  const bytes = [0x48, 0x05, 0x3a, 0x06, 0x46, 0x84, 0x68, 0x46, 0xb4, 0x6e];
  const b64 = Buffer.from(bytes).toString('base64url');
  const r = decode('#1.' + b64);
  assert.equal(r.repaired, false);
  assert.equal(r.tune.events.length, 4);
});

test('garbage and newer versions never throw', () => {
  for (const h of ['', '#', '#hello', '#1.!!!!', '#1.____', '#9.OgZGhGhGtG4', '#1.CgpPZGUgdG8']) {
    const r = decode(h);
    assert.ok(Array.isArray(r.tune.events));
  }
  assert.equal(decode('#9.OgZGhGhGtG4').newer, true);
});

test('out-of-range header values are clamped', () => {
  const bytes = [0x10, 0xe8, 0x07, 0x30, 0x63]; // bpm 1000, measures 99
  const r = decode('#1.' + Buffer.from(bytes).toString('base64url'));
  assert.equal(r.tune.bpm, 240);
  assert.equal(r.tune.measures, 20);
  assert.equal(r.repaired, true);
});

test('chords round-trip', () => {
  const t = tune('C4:q D4:h E4:q');
  t.events[0].tones = [{ step: 2, oct: 4, alter: 0 }, { step: 4, oct: 4, alter: 1 }];
  t.events[2].tones = [{ step: 0, oct: 5, alter: -1 }];
  const r = decode('#' + encode(t));
  assert.equal(r.repaired, false);
  assert.deepEqual(r.tune, t);
});

test('chords are not capped by the format', () => {
  const t = tune('C4:w');
  t.events[0].tones = ['D', 'E', 'F', 'G', 'A', 'B'].map((_, i) => ({ step: (i + 1) % 7, oct: 4, alter: 0 }))
    .concat([{ step: 0, oct: 5, alter: 0 }, { step: 1, oct: 5, alter: 0 }]);
  assert.equal(decode('#' + encode(t)).tune.events[0].tones.length, 8);
});

test('a chord after a rest keeps its tones', () => {
  const t = tune('r:q C4:q');
  t.events[1].tones = [{ step: 2, oct: 4, alter: 0 }];
  const r = decode('#' + encode(t));
  assert.equal(r.repaired, false);
  assert.equal(r.tune.events[1].tones.length, 1);
});

test('second staff round-trips with its own clef and chords', () => {
  const t = tune('C5:q D5:q E5:h');
  const low = tune('C3:h G2:h');
  low.events[0].tones = [{ step: 4, oct: 3, alter: 0 }];
  t.staff2 = { clef: 'bass', events: low.events };
  const r = decode('#' + encode(t));
  assert.equal(r.repaired, false);
  assert.deepEqual(r.tune, t);
  // An empty second staff is kept, and its clef can be treble.
  const e = { ...tune('C4:q'), staff2: { clef: 'treble', events: [] } };
  assert.deepEqual(decode('#' + encode(e)).tune, e);
});

test('second staff is trimmed to the shared capacity', () => {
  const t = { ...tune('C4:w', { measures: 1 }), staff2: { clef: 'bass', events: tune('C3:w C3:w').events } };
  const r = decode('#' + encode(t));
  assert.equal(r.repaired, true);
  assert.equal(r.tune.staff2.events.length, 1);
});

// Fixture links must decode identically forever.
test('fixture: two-staff link', () => {
  const r = decode('#1.OgNGhGhKBwgBEgNEFEE');
  assert.equal(r.repaired, false);
  assert.deepEqual(r.tune, { ...tune('B4:q B4:q'), staff2: { clef: 'bass', events: tune('C3:q C3:q').events } });
});
