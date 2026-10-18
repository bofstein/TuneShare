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

test('selection helpers handle caret or empty selection gracefully', () => {
  const tune = defaultTune();
  const cursor = { type: 'caret', index: 0, staff: 0 };
  assert.equal(selectedEvent(tune, cursor), null);
  assert.equal(selectedTone(tune, cursor), 0);
  assert.equal(selectedPitch(tune, cursor), null);
  assert.equal(insertIndex(cursor), 0);
  assert.equal(activeDur(tune, cursor, 3), 3);
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
  const pitches = [
    { step: 4, oct: 4, alter: 0 },
    { step: 0, oct: 4, alter: 0 },
  ];
  assert.equal(cycleTone(pitches, 1, 1), 0);
  assert.equal(cycleTone(pitches, 0, 1), 1);
  assert.equal(cycleTone([{ step: 0, oct: 4, alter: 0 }], 0, 1), 0);
});

test('moveCursor steps through notes and transitions to caret at boundaries', () => {
  const cursor = { type: 'note', index: 1, staff: 0 };
  assert.deepEqual(moveCursor(cursor, 3, -1), { type: 'note', index: 0, tone: 0, staff: 0 });
  assert.deepEqual(moveCursor({ type: 'note', index: 0, staff: 0 }, 3, -1), { type: 'caret', index: 0, staff: 0 });
  assert.deepEqual(moveCursor({ type: 'note', index: 2, staff: 0 }, 3, 1), { type: 'caret', index: 3, staff: 0 });
  assert.deepEqual(moveCursor(cursor, 0, 1), cursor);
});

test('switchStaff moves between upper and lower staves maintaining tick offset', () => {
  const stavesGeo = [
    { used: 16, starts: [0, 4, 8, 12] },
    { used: 16, starts: [0, 8] },
  ];
  // Cursor at note 2 (tick 8) on staff 0 -> should map to note 1 (tick 8) on staff 1
  const c0 = { type: 'note', index: 2, staff: 0 };
  const c1 = switchStaff(c0, stavesGeo, 2, 1);
  assert.deepEqual(c1, { type: 'caret', index: 1, staff: 1 });

  // Out of bounds staff switch returns cursor unchanged
  assert.deepEqual(switchStaff(c0, stavesGeo, 2, -1), c0);
  assert.deepEqual(switchStaff(c1, stavesGeo, 2, 1), c1);
});

test('typeLetter inserts a note following key signature and clef, or replaces rest', () => {
  const tune = defaultTune();
  const cursor = { type: 'caret', index: 0, staff: 0 };
  const op = typeLetter(tune, cursor, 0, 2);
  assert.ok(op.result.tune);
  assert.equal(op.result.tune.events.length, 1);
  assert.equal(op.result.tune.events[0].step, 0);

  // When a rest is selected, typeLetter replaces it in-place
  const restTune = { ...defaultTune(), events: [{ rest: true, dur: 3 }] };
  const restCursor = { type: 'note', index: 0, staff: 0 };
  const opReplace = typeLetter(restTune, restCursor, 2, 2);
  assert.equal(opReplace.result.tune.events[0].rest, undefined);
  assert.equal(opReplace.result.tune.events[0].step, 2);
  assert.equal(opReplace.result.tune.events[0].dur, 3);
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

  // At caret: inserts rest
  const caretCursor = { type: 'caret', index: 1, staff: 0 };
  const opInsert = typeRest(tune, caretCursor, 1);
  assert.equal(opInsert.result.tune.events.length, 2);
  assert.ok(opInsert.result.tune.events[1].rest);
});

test('addToneLetter and addTone expand chords', () => {
  const tune = {
    ...defaultTune(),
    events: [{ step: 0, oct: 4, alter: 0, dur: 2 }], // C4
  };
  const cursor = { type: 'note', index: 0, staff: 0 };

  // Add E (step 2) above C4 -> E4
  const op = addToneLetter(tune, cursor, 2, 2);
  assert.ok(op.result.tune.events[0].tones);
  assert.equal(op.result.tune.events[0].tones.length, 1);
  assert.equal(op.result.tune.events[0].tones[0].step, 2);

  // Add specific pitch
  const opDirect = addTone(tune, cursor, { step: 4, oct: 4, alter: 0 });
  assert.equal(opDirect.result.tune.events[0].tones[0].step, 4);

  // If applied to a rest, delegates to typeLetter
  const restTune = { ...defaultTune(), events: [{ rest: true, dur: 2 }] };
  const opRest = addToneLetter(restTune, { type: 'note', index: 0, staff: 0 }, 0, 2);
  assert.equal(opRest.result.tune.events[0].step, 0);
});

test('setDuration and toggleDotted modify durations', () => {
  const tune = {
    ...defaultTune(),
    events: [{ step: 0, oct: 4, alter: 0, dur: 2 }], // Quarter
  };
  const cursor = { type: 'note', index: 0, staff: 0 };

  // Set to eighth (dur 1)
  const opDur = setDuration(tune, cursor, 1);
  assert.equal(opDur.result.tune.events[0].dur, 1);

  // Set duration with no selection updates inputDur
  assert.deepEqual(setDuration(tune, { type: 'caret', index: 0 }, 3), { inputDur: 3 });

  // Toggle dotted on quarter -> dotted quarter (dur 6)
  const opDot = toggleDotted(tune, cursor, 2);
  assert.equal(opDot.result.tune.events[0].dur, 6);

  // Toggle dotted with no selection updates inputDur
  assert.deepEqual(toggleDotted(tune, { type: 'caret', index: 0 }, 2), { inputDur: 6 });
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

  // Move pitch octave up -> C5
  const opOct = movePitch(tune, cursor, 7);
  assert.equal(opOct.sound.oct, 5);

  // Half step up in C major -> C#4
  const op2 = moveHalfStep(tune, cursor, 1);
  assert.equal(op2.sound.alter, 1);

  // Set sharp
  const op3 = setAlter(tune, cursor, 1);
  assert.equal(op3.result.tune.events[0].alter, 1);

  // Toggle sharp off when already sharp -> back to natural
  const sharpTune = { ...defaultTune(), events: [{ step: 0, oct: 4, alter: 1, dur: 2 }] };
  const opUntoggle = setAlter(sharpTune, cursor, 1);
  assert.equal(opUntoggle.result.tune.events[0].alter, 0);

  // No-ops when no pitch selected
  assert.equal(movePitch(tune, { type: 'caret', index: 0 }, 1), null);
  assert.equal(moveHalfStep(tune, { type: 'caret', index: 0 }, 1), null);
  assert.equal(setAlter(tune, { type: 'caret', index: 0 }, 1), null);
});

test('deleteSel removes chord tone, whole note, or note before caret', () => {
  // Chord with 2 notes
  const chordTune = {
    ...defaultTune(),
    events: [{ step: 0, oct: 4, alter: 0, dur: 2, tones: [{ step: 4, oct: 4, alter: 0 }] }],
  };
  const cursor = { type: 'note', index: 0, tone: 0, staff: 0 };
  const op = deleteSel(chordTune, cursor);
  assert.equal(op.result.tune.events[0].tones, undefined);

  // Single note at index 0 -> removes note, caret at 0
  const singleTune = { ...defaultTune(), events: [{ step: 0, oct: 4, alter: 0, dur: 2 }] };
  const opSingle = deleteSel(singleTune, { type: 'note', index: 0, staff: 0 });
  assert.equal(opSingle.result.tune.events.length, 0);
  assert.deepEqual(opSingle.cursor, { type: 'caret', index: 0, staff: 0 });

  // Caret at index 1 -> removes note before caret
  const opCaret = deleteSel(singleTune, { type: 'caret', index: 1, staff: 0 });
  assert.equal(opCaret.result.tune.events.length, 0);
  assert.deepEqual(opCaret.cursor, { type: 'caret', index: 0, staff: 0 });

  // Caret at index 0 -> null
  assert.equal(deleteSel(singleTune, { type: 'caret', index: 0, staff: 0 }), null);
});

test('swapSel reorders adjacent notes', () => {
  const tune = {
    ...defaultTune(),
    events: [
      { step: 0, oct: 4, alter: 0, dur: 2 },
      { step: 2, oct: 4, alter: 0, dur: 2 },
    ],
  };
  const cursor = { type: 'note', index: 0, staff: 0 };
  const op = swapSel(tune, cursor, 1);
  assert.equal(op.result.tune.events[0].step, 2);
  assert.equal(op.result.tune.events[1].step, 0);
  assert.deepEqual(op.cursor, { type: 'note', index: 1, staff: 0 });

  // Out of bounds swap returns null
  assert.equal(swapSel(tune, cursor, -1), null);
  assert.equal(swapSel(tune, { type: 'caret', index: 0 }, 1), null);
});

test('toggleDotted returns empty object for non-dottable duration like whole note', () => {
  const tune = {
    ...defaultTune(),
    events: [{ step: 0, oct: 4, alter: 0, dur: 4 }], // whole note cannot be dotted
  };
  const cursor = { type: 'note', index: 0, staff: 0 };
  const res = toggleDotted(tune, cursor, 2);
  assert.deepEqual(res, {});
});
