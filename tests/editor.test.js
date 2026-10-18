import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultTune } from '../src/model.js';
import {
  staffIdx,
  staffView,
  selectedEvent,
  selectedTone,
  selectedPitch,
  insertIndex,
  activeDur,
  refDiatonic,
  noteFor,
  cycleTone,
  moveCursor,
  switchStaff,
  typeLetter,
  typeRest,
  addToneLetter,
  addTone,
  setDuration,
  toggleDotted,
  movePitch,
  moveHalfStep,
  setAlter,
  deleteSel,
  swapSel,
} from '../src/editor.js';

test('selection helpers correctly identify active event, tone, and pitch', () => {
  const tune = {
    ...defaultTune(),
    events: [
      { step: 0, oct: 4, alter: 0, dur: 2, tones: [{ step: 4, oct: 4, alter: 0 }] }, // C4 + G4
    ],
  };
  const cursor = { type: 'note', index: 0, tone: 1, staff: 0 };
  assert.equal(staffIdx(cursor), 0);
  assert.ok(selectedEvent(tune, cursor));
  assert.equal(selectedTone(tune, cursor), 1);
  const p = selectedPitch(tune, cursor);
  assert.equal(p.step, 4); // G
  assert.equal(p.oct, 4);
  assert.equal(insertIndex(cursor), 1);
  assert.equal(activeDur(tune, cursor, 3), 2);
});

test('refDiatonic and noteFor choose nearest octave within clef range', () => {
  const events = [{ step: 0, oct: 4, alter: 0, dur: 2 }]; // C4 (diatonic 28)
  const ref = refDiatonic(events, 0, 'treble');
  assert.equal(ref, 28);

  // E (step 2) closest to C4 (diatonic 28) should be E4 (diatonic 30)
  const n = noteFor(2, ref, 'treble', 0);
  assert.equal(n.step, 2);
  assert.equal(n.oct, 4);
});

test('cycleTone cycles chord notes from bottom to top', () => {
  // G4 (step 4, oct 4 = diatonic 32), C4 (step 0, oct 4 = diatonic 28)
  const pitches = [
    { step: 4, oct: 4, alter: 0 }, // index 0 in entry order (higher)
    { step: 0, oct: 4, alter: 0 }, // index 1 in entry order (lower)
  ];
  // Diatonic bottom is index 1 (C4), top is index 0 (G4)
  // Starting at tone 1 (C4), cycle +1 goes to tone 0 (G4)
  assert.equal(cycleTone(pitches, 1, 1), 0);
  // Starting at tone 0 (G4), cycle +1 wraps to tone 1 (C4)
  assert.equal(cycleTone(pitches, 0, 1), 1);
});

test('moveCursor steps through notes and transitions to caret at boundaries', () => {
  const cursor = { type: 'note', index: 1, staff: 0 };
  // Move left to index 0
  assert.deepEqual(moveCursor(cursor, 3, -1), { type: 'note', index: 0, tone: 0, staff: 0 });
  // Move left from 0 -> caret at 0
  assert.deepEqual(moveCursor({ type: 'note', index: 0, staff: 0 }, 3, -1), { type: 'caret', index: 0, staff: 0 });
  // Move right from 2 (last note) -> caret at 3
  assert.deepEqual(moveCursor({ type: 'note', index: 2, staff: 0 }, 3, 1), { type: 'caret', index: 3, staff: 0 });
});

test('typeLetter inserts a note following key signature and clef', () => {
  const tune = defaultTune();
  const cursor = { type: 'caret', index: 0, staff: 0 };
  // Step 0 = C in C major
  const op = typeLetter(tune, cursor, 0, 2);
  assert.ok(op.result.tune);
  assert.equal(op.result.tune.events.length, 1);
  assert.equal(op.result.tune.events[0].step, 0);
  assert.equal(op.result.tune.events[0].dur, 2);
  assert.deepEqual(op.cursor, { type: 'note', index: 0, staff: 0 });
  assert.equal(op.sound.step, 0);
});

test('typeRest replaces selected note or inserts rest', () => {
  const tune = {
    ...defaultTune(),
    events: [{ step: 0, oct: 4, alter: 0, dur: 2 }],
  };
  const cursor = { type: 'note', index: 0, staff: 0 };
  const op = typeRest(tune, cursor, 2);
  assert.ok(op.result.tune.events[0].rest);
  assert.equal(op.result.tune.events[0].dur, 2);
});

test('movePitch, moveHalfStep and setAlter modify selected pitch', () => {
  const tune = {
    ...defaultTune(),
    events: [{ step: 0, oct: 4, alter: 0, dur: 2 }], // C4
  };
  const cursor = { type: 'note', index: 0, tone: 0, staff: 0 };

  // Move pitch 1 diatonic step up -> D4
  const op1 = movePitch(tune, cursor, 1);
  assert.equal(op1.result.tune.events[0].step, 1);

  // Half step up in C major -> C#4
  const op2 = moveHalfStep(tune, cursor, 1);
  assert.equal(op2.sound.alter, 1);

  // Set sharp
  const op3 = setAlter(tune, cursor, 1);
  assert.equal(op3.result.tune.events[0].alter, 1);
});

test('deleteSel removes chord tone or whole note', () => {
  // Chord with 2 notes
  const chordTune = {
    ...defaultTune(),
    events: [{ step: 0, oct: 4, alter: 0, dur: 2, tones: [{ step: 4, oct: 4, alter: 0 }] }],
  };
  const cursor = { type: 'note', index: 0, tone: 0, staff: 0 };
  const op = deleteSel(chordTune, cursor);
  assert.equal(op.result.tune.events[0].tones, undefined); // tone deleted, 1 pitch left
  assert.deepEqual(op.cursor, { type: 'note', index: 0, tone: 0, staff: 0 });
});
