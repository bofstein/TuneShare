import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tuneNotes } from '../src/audio.js';
import { RENDER_LEVELS } from '../src/mp3.js';
import { tune } from './helpers.js';

test('tuneNotes lists every sounding pitch once, in time order, at the tune tempo', () => {
  // 120 bpm: a quarter is 0.5s. Chord on beat 2 gives two notes at the same time.
  const t = tune('C4:q E4:q r:q D4:q', { bpm: 120, measures: 1 });
  t.events[1].tones = [{ step: 4, oct: 4, alter: 0 }]; // + G4
  const { notes, duration } = tuneNotes(t);
  assert.deepEqual(notes.map(n => n.midi), [60, 64, 67, 62]);
  assert.deepEqual(notes.map(n => +(n.t0 - 0.05).toFixed(3)), [0, 0.5, 0.5, 1.5]);
  assert.ok(notes.every((n, i) => !i || n.t0 >= notes[i - 1].t0));
  assert.ok(Math.abs(notes[1].level - 1 / Math.SQRT2) < 1e-9, 'chord notes are scaled like live playback');
  assert.ok(duration >= 0.05 + 2 && duration <= 0.05 + 2 + 2, `whole bar plus release tail, got ${duration}`);
});

test('tuneNotes includes the second staff', () => {
  const t = tune('C5:w', { measures: 1 });
  t.staff2 = { clef: 'bass', events: tune('C3:w').events };
  assert.deepEqual(tuneNotes(t).notes.map(n => n.midi).sort(), [48, 72]);
});

test('an empty tune has nothing to render', () => {
  assert.deepEqual(tuneNotes(tune('r:w', { measures: 1 })), { notes: [], duration: 0 });
});

test('MP3 render fallbacks go from most faithful to most frugal', () => {
  assert.equal(RENDER_LEVELS[0].chunk, Infinity);
  for (let i = 1; i < RENDER_LEVELS.length; i++) {
    const a = RENDER_LEVELS[i - 1], b = RENDER_LEVELS[i];
    assert.ok(b.chunk * b.sampleRate * b.channels < a.chunk * a.sampleRate * a.channels, b.name);
  }
});
