import test from 'node:test';
import assert from 'node:assert/strict';
import { encode, decode } from '../src/codec.js';
import { planVoice, writeVoice, parseVoice, resolveVoice, MAX_VOICE_EVENTS } from '../src/voice.js';
import { tune, ODE } from './helpers.js';

const syntax = ({ bit, end, ...op }) => op;        // an op without its position in the stream

/** plan → write → parse → resolve: every stage must hand the next one exactly what it expects. */
function seams(events, key = 0, clef = 'treble', history = []) {
  const plan = planVoice(events, key, clef, history);
  const bytes = writeVoice(plan);
  const parsed = parseVoice(bytes);
  assert.equal(parsed.repaired, false);
  assert.deepEqual({ ...parsed, ops: parsed.ops.map(syntax) }, { ...plan, bits: parsed.bits, repaired: false });
  const resolved = resolveVoice(parsed, key, clef, history);
  assert.equal(resolved.repaired, false);
  assert.deepEqual(resolved.events, events);
  return { plan, bytes, parsed, resolved };
}

function rng(seed) {
  let s = seed;
  return n => { s = (s * 1103515245 + 12345) % 2147483648; return Math.floor((s / 2147483648) * n); };
}

/** A random voice of ticks ≤ cap, built from phrases that sometimes repeat, shifted, with chords, rests and accidentals. */
function randomEvents(rnd, cap) {
  const phrase = () => Array.from({ length: 2 + rnd(5) }, () => {
    const dur = rnd(8);
    if (rnd(8) === 0) return { rest: true, dur };
    const e = { dur, step: rnd(7), oct: 2 + rnd(5), alter: rnd(5) === 0 ? rnd(3) - 1 : 0 };
    if (rnd(5) === 0) {
      const base = e.oct * 7 + e.step, tones = [], seen = new Set([base]);
      for (let k = 1 + rnd(3); k > 0; k--) {
        const d = base + rnd(15) - 7;
        if (seen.has(d)) continue;
        seen.add(d); tones.push({ step: d % 7, oct: Math.floor(d / 7), alter: rnd(8) === 0 ? 1 : 0 });
      }
      if (tones.length) e.tones = tones;
    }
    return e;
  });
  const shifted = (p, by) => p.map(e => e.rest ? e : {
    ...e, step: ((e.oct * 7 + e.step + by) % 7 + 7) % 7, oct: Math.floor((e.oct * 7 + e.step + by) / 7),
    ...(e.tones && { tones: e.tones.map(t => ({ ...t, step: (t.oct * 7 + t.step + by) % 7, oct: Math.floor((t.oct * 7 + t.step + by) / 7) })) }),
  });
  const out = [];
  let used = 0;
  const ticks = [1, 2, 4, 8, 16, 3, 6, 12];
  const phrases = [phrase(), phrase()];
  while (out.length < 300) {
    const p = rnd(3) === 0 ? phrase() : shifted(phrases[rnd(2)], rnd(3) === 0 ? rnd(5) - 2 : 0);
    for (const e of p) {
      if (used + ticks[e.dur] > cap) return out;
      out.push(e); used += ticks[e.dur];
    }
  }
  return out;
}

test('stages hand over exactly what the next one expects', () => {
  seams([]);
  seams(tune(ODE).events, 1);
  const rnd = rng(7);
  for (let k = 0; k < 200; k++) {
    const key = rnd(15) - 7, clef = rnd(2) ? 'bass' : 'treble';
    seams(randomEvents(rnd, 20 * 16), key, clef);
  }
});

test('random tunes round-trip through links, with two staves and copies between them', () => {
  const rnd = rng(99);
  for (let k = 0; k < 150; k++) {
    const time = ['4/4', '3/4', '2/4', '6/8'][rnd(4)];
    const cap = 20 * { '4/4': 16, '3/4': 12, '2/4': 8, '6/8': 12 }[time];
    const t = { title: rnd(2) ? 'Tüne ♪ ' + k : '', bpm: 40 + rnd(201), key: rnd(15) - 7, clef: rnd(2) ? 'bass' : 'treble', time, measures: 20, events: randomEvents(rnd, cap) };
    if (rnd(2)) {
      const two = rnd(3) === 0 ? t.events.map(e => e.rest ? e : { ...e, oct: e.oct - 1, ...(e.tones && { tones: e.tones.map(x => ({ ...x, oct: x.oct - 1 })) }) }) : randomEvents(rnd, cap);
      t.staff2 = { clef: rnd(2) ? 'bass' : 'treble', events: two.filter(e => e.rest || (e.oct >= 0 && (e.tones || []).every(x => x.oct >= 0))) };
    }
    const r = decode('#' + encode(t));
    assert.equal(r.repaired, false, `tune ${k}`);
    assert.deepEqual(r.tune, t, `tune ${k}`);
  }
});

test('a repeated bar over changing chords is a shifted copy', () => {
  const bar = (a, b, c) => `${a}:e ${c}:e ${b}:e ${c}:e ${a}:e ${c}:e ${b}:e ${c}:e`;
  const events = tune([bar('C3', 'E3', 'G3'), bar('D3', 'F3', 'A3'), bar('E3', 'G3', 'B3')].join(' | ')).events;
  const { plan } = seams(events, 0, 'bass');
  const copy = plan.ops.find(op => op.op === 'copy' && op.len >= 8);
  assert.ok(copy, 'second and third bar are copies of the first');
  assert.equal(copy.shift, 1);
  assert.ok(plan.ops.length < 8);
});

test('long runs of one note are a single copy', () => {
  const { plan } = seams(tune(Array(32).fill('C4:s').join(' '), { measures: 2 }).events);
  assert.equal(plan.ops.length, 2);
  assert.deepEqual(plan.ops[1], { op: 'copy', dist: 1, len: 31, shift: 0 });
});

test('a chord shape seen before costs no tones', () => {
  const events = tune('C4:q F4:e A4:h D5:q').events;      // different lengths and intervals, so no copies
  events.forEach(e => { e.tones = [{ step: (e.step + 2) % 7, oct: e.oct + (e.step + 2 > 6 ? 1 : 0), alter: 0 }]; });
  const { plan } = seams(events);
  const chords = plan.ops.filter(op => op.chord);
  assert.equal(chords.length, 4);
  assert.equal(chords[0].chord.hit, undefined);
  assert.deepEqual(chords.slice(1).map(op => op.chord.hit), [0, 0, 0]);
});

test('header flags leave out what a voice never uses', () => {
  const plain = planVoice(tune('C4:q D4:q E4:q F4:q').events, 0, 'treble');
  assert.deepEqual(plain.flags, { rest: false, alt: false, chords: false });
  const rest = planVoice(tune('C4:q r:q').events, 0, 'treble');
  assert.deepEqual(rest.flags, { rest: true, alt: false, chords: false });
  const alt = planVoice(tune('C#4:q D4:q').events, 0, 'treble');
  assert.deepEqual(alt.flags, { rest: false, alt: true, chords: false });
  // The key signature's own accidentals are not "accidentals": F♯ in G major is free.
  assert.equal(planVoice(tune('F#4:q').events, 1, 'treble').flags.alt, false);
  assert.equal(planVoice(tune('F4:q').events, 1, 'treble').flags.alt, true);
  const withChord = tune('C4:q'); withChord.events[0].tones = [{ step: 2, oct: 4, alter: 0 }];
  assert.equal(planVoice(withChord.events, 0, 'treble').flags.chords, true);
});

test('the second staff can copy from the first', () => {
  const mel = tune('G4:q A4:q B4:q G4:q | B4:q C5:q D5:h').events;
  const low = mel.map(e => ({ ...e, oct: e.oct - 1 }));
  const { plan } = seams(low, 0, 'bass', mel);
  assert.equal(plan.ops.length, 1);
  assert.deepEqual(plan.ops[0], { op: 'copy', dist: 7, len: 7, shift: -7 });
  assert.ok(plan.ops.length < planVoice(low, 0, 'bass').ops.length);
});

test('fixture: Ode to Joy (v2)', () => {
  const link = '#2.CgpPZGUgdG8gSm95EHgYAjAIUg0Pi1urQQie5W4eLh6Q';
  const r = decode(link);
  assert.equal(r.repaired, false);
  assert.equal(r.version, 2);
  assert.deepEqual(r.tune, tune(ODE, { title: 'Ode to Joy', bpm: 120, key: 1, measures: 8 }));
});

test('fixture: two staves with chords, accidentals, rests and copies (v2)', () => {
  const link = '#2.CgVQaWFub1ITCXh3IpKRapGjKSkQKZ1kaKOhAEoSCAEiDgQjKhMSKI4QcQEHYMHg';
  const r = decode(link);
  assert.equal(r.repaired, false);
  const rh = tune('E5:q G5:e F#5:e E5:q r:q | F5:q A5:e G5:e F5:q r:q | G5:q B5:e A5:e G5:q r:q | E5:h C5:h');
  rh.events[0].tones = [{ step: 0, oct: 5, alter: 0 }];
  rh.events[15].tones = [{ step: 4, oct: 5, alter: 0 }, { step: 0, oct: 6, alter: 0 }];
  const bar = (a, b, c) => `${a}:e ${c}:e ${b}:e ${c}:e ${a}:e ${c}:e ${b}:e ${c}:e`;
  const lh = tune([bar('C3', 'E3', 'G3'), bar('F2', 'A2', 'C3'), bar('G2', 'B2', 'D3'), bar('C3', 'E3', 'G3')].join(' | '));
  assert.deepEqual(r.tune, { ...rh, title: 'Piano', measures: 4, staff2: { clef: 'bass', events: lh.events } });
});

test('fixture: a v1 link and its v2 upgrade decode to the same tune', () => {
  // v1 link from the project thread whose last 3 characters were lost; the v2 link is its repaired re-encoding.
  const v1 = '#1.ChBHdWVzcyB3aGF0IGl0IGlzGAEwCDonQARlRuRlxrJnZnRnRixrJi5lIAJWRZRlRfRlxrJnZnRnRixrJihfQgYIARICBfBCBggCEgIF8EIGCAMSAgXwQgcIBBIDBiBZQgcIBhIDBiBZQgcIBxIDBiBcQgYICRICBcBCBwgLEgMF8FlCBggNEgIE0EIGCA4SAgUAQgYIDxICBfBCBggQEgIG4EIHCBISAwYgWUIHCBQSAwYgWUIHCBUSAwYgXEIGCBcSAgXAQgkIGRIFBlBZBQBKZAgBEmAi8i8i8i8i8i8i8i8jgjgjgjgjgjgjgjgiwiwiwiwiwiwiwiwi8i8i8i8i8i8i8i8i8i8i8i8i8i8i8jgjgjgjgjgjgjgjgkEkEkEkEkEkEkEkEi8i8i8i8i8i8i8i8';
  const old = decode(v1);
  assert.equal(old.version, 1);
  assert.equal(old.repaired, true);          // cut short
  const upgraded = '#' + encode(old.tune);
  const now = decode(upgraded);
  assert.equal(now.repaired, false);
  assert.deepEqual(now.tune, old.tune);
  assert.ok(upgraded.length < v1.length / 3, `${upgraded.length} vs ${v1.length}`);
  assert.deepEqual(decode('#2.ChBHdWVzcyB3aGF0IGl0IGlzGAEwCFIoDd0XJD8VDXcXRjUpX0Q1XRCQi481Jl7vmCuap1BM8JxcKDjbFsogwEoWCAEiEgfjI5NCDnBA6CDsHx0IOcFzQA').tune, old.tune);
});

test('link sizes stay small', () => {
  assert.ok(encode(tune(ODE, { measures: 8 })).length <= 30);
  assert.ok(encode({ ...tune(ODE, { measures: 8 }), staff2: { clef: 'bass', events: tune('C3:w').events } }).length <= 40);
});

test('a link cut anywhere keeps a prefix of the notes', () => {
  const rnd = rng(3);
  for (let k = 0; k < 40; k++) {
    const t = { ...tune('', { measures: 20 }), events: randomEvents(rnd, 20 * 16) };
    t.staff2 = { clef: 'bass', events: randomEvents(rnd, 20 * 16) };
    const link = encode(t);
    for (let n = 2; n < link.length; n += 1 + (n % 3)) {
      const r = decode('#' + link.slice(0, n));
      assert.deepEqual(r.tune.events, t.events.slice(0, r.tune.events.length));
      assert.ok(r.tune.staff2 === undefined || r.tune.staff2.events.length <= t.staff2.events.length);
    }
  }
});

// ---------- damaged and hostile voices ----------

const lit = (over = {}) => ({ op: 'lit', rest: false, dur: undefined, delta: 0, alt: 0, ...over });
const flagsOff = { rest: false, alt: false, chords: false };
const make = (count, ops, flags = flagsOff) => parseVoice(writeVoice({ count, flags, ops }));

test('a copy that points before the start stops decoding there', () => {
  const v = make(4, [lit({ delta: 0 }), { op: 'copy', dist: 9, len: 3, shift: 0 }]);
  const r = resolveVoice(v, 0, 'treble');
  assert.equal(r.repaired, true);
  assert.equal(r.events.length, 1);
});

test('a copy into the first staff is refused for the first staff', () => {
  const v = make(2, [{ op: 'copy', dist: 1, len: 2, shift: 0 }]);
  assert.equal(resolveVoice(v, 0, 'treble').repaired, true);
});

test('pitches outside the 12-bit range of v1 are refused', () => {
  const high = make(2, [lit({ delta: 36 }), lit({ delta: 5 })]);       // from B4 (34): 70, then 75
  assert.equal(resolveVoice(high, 0, 'treble').repaired, true);
  assert.equal(resolveVoice(high, 0, 'treble').events.length, 0);
  const low = make(1, [lit({ delta: -40 })]);
  assert.equal(resolveVoice(low, 0, 'treble').repaired, true);
  const shifted = make(4, [lit({ delta: 0 }), { op: 'copy', dist: 1, len: 3, shift: 30 }]);
  const r = resolveVoice(shifted, 0, 'treble');
  assert.equal(r.repaired, true);
  assert.ok(r.events.length < 4);
});

test('an enormous copy length cannot allocate more than the declared count', () => {
  const v = make(5, [lit(), { op: 'copy', dist: 1, len: 1e9, shift: 0 }]);
  const r = resolveVoice(v, 0, 'treble');
  assert.equal(r.events.length, 5);
  assert.equal(r.repaired, false);
});

test('a huge declared count is clamped', () => {
  const v = parseVoice(writeVoice({ count: 5e6, flags: flagsOff, ops: [lit()] }));
  assert.equal(v.repaired, true);
  assert.equal(v.count, MAX_VOICE_EVENTS);
});

test('an unknown chord shape is a damaged voice, not an exception', () => {
  // flags: chords on; one note whose chord says "reuse shape 3" with an empty cache
  const bytes = writeVoice({ count: 1, flags: { rest: false, alt: false, chords: true }, ops: [lit({ chord: { hit: 3, tones: [] } })] });
  const v = parseVoice(bytes);
  assert.equal(v.repaired, true);
  assert.equal(v.ops.length, 0);
});

test('chord tones that duplicate a pitch are dropped as repairs', () => {
  const v = make(1, [lit({ chord: { tones: [{ delta: 0, alt: 0 }, { delta: 2, alt: 0 }, { delta: -2, alt: 0 }] } })], { rest: false, alt: false, chords: true });
  const r = resolveVoice(v, 0, 'treble');
  assert.equal(r.events[0].tones.length, 1);
  assert.equal(r.repaired, true);
});

test('empty and random bytes never throw', () => {
  assert.deepEqual(parseVoice([]).ops, []);
  const rnd = rng(5);
  for (let k = 0; k < 500; k++) {
    const bytes = Array.from({ length: rnd(30) }, () => rnd(256));
    const v = parseVoice(bytes);
    const r = resolveVoice(v, rnd(15) - 7, 'treble');
    assert.ok(r.events.length <= MAX_VOICE_EVENTS);
  }
});
