import { test } from 'node:test';
import assert from 'node:assert/strict';
import { halfStep, midiOf, pitchName } from '../src/theory.js';
import { parse } from './helpers.js';

const p = s => parse(`${s}:q`)[0];
const up = (s, key = 0) => pitchName(halfStep(p(s), 1, key));
const down = (s, key = 0) => pitchName(halfStep(p(s), -1, key));

test('C up is C♯, then D, in C major', () => {
  assert.equal(up('C4'), 'C♯4');
  assert.equal(up('C#4'), 'D4');
});

test('going down uses flats in C major', () => {
  assert.equal(down('D4'), 'D♭4');
  assert.equal(down('Db4'), 'C4');
  assert.equal(down('B4'), 'B♭4');
});

test('E and B go straight to the natural above, F and C to the natural below', () => {
  assert.equal(up('E4'), 'F4');
  assert.equal(up('B4'), 'C5');
  assert.equal(down('F4'), 'E4');
  assert.equal(down('C5'), 'B4');
});

test('a note of the key signature is preferred', () => {
  assert.equal(up('A4', -1), 'B♭4');                // F major
  assert.equal(up('F4', 1), 'F♯4');                 // G major
  assert.equal(down('G4', 1), 'F♯4');
  assert.equal(up('F#4', 1), 'G4');
  assert.equal(down('B4', -2), 'B♭4');              // B♭ major
});

test('plain naturals beat odd spellings like E♯', () => {
  assert.equal(down('F#4', 1), 'F4');               // G major: F♯ down is F natural, not E♯
  assert.equal(up('E4', 1), 'F4');
  assert.equal(up('Bb4', -1), 'B4');                // F major: B♭ up is B natural
});

test('chromatic notes outside the key go up with sharps, down with flats', () => {
  assert.equal(up('G4', 1), 'G♯4');
  assert.equal(down('A4', 1), 'A♭4');
});

test('moves by exactly one semitone across octave boundaries', () => {
  for (const key of [-7, -3, 0, 2, 7]) {
    for (const s of ['B3', 'C4', 'Cb4', 'B#3', 'F#5']) {
      const a = p(s);
      assert.equal(midiOf(halfStep(a, 1, key)), midiOf(a) + 1);
      assert.equal(midiOf(halfStep(a, -1, key)), midiOf(a) - 1);
    }
  }
});

test('never produces a double accidental', () => {
  for (let key = -7; key <= 7; key++) {
    for (let step = 0; step < 7; step++) for (const alter of [-1, 0, 1]) for (const dir of [1, -1]) {
      const r = halfStep({ step, oct: 4, alter }, dir, key);
      assert.ok(r && Math.abs(r.alter) <= 1, `key ${key} ${step}${alter} ${dir}`);
    }
  }
});
