import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultTune } from '../src/model.js';
import { layout } from '../src/layout.js';
import {
  formatReadout,
  formatHint,
  formatSettingsSummary,
  formatAriaLabel,
  formatGhostTip,
  formatHdStatus,
  kbd,
} from '../src/ui-format.js';

test('kbd helper wraps text with kbd tag', () => {
  assert.equal(kbd('Space'), '<kbd>Space</kbd>');
});

test('formatReadout formats idle state with next note duration', () => {
  const tune = defaultTune();
  const cursor = { type: 'caret', index: 0, staff: 0 };
  const res = formatReadout(tune, cursor, null, 2);
  assert.equal(res.isIdle, true);
  assert.equal(res.textHtml, 'Next note: quarter');
  assert.match(res.subText, /type A–G/);
});

test('formatReadout formats selected note and chord with underline on selected tone', () => {
  const tune = {
    ...defaultTune(),
    events: [
      { step: 0, oct: 4, alter: 0, dur: 2, tones: [{ step: 2, oct: 4, alter: 0 }] }, // C4 + E4
    ],
  };
  const lay = layout(tune, { width: 600, perSys: 2, sp: 10 });
  // Select E4 (tone 1)
  const cursor = { type: 'note', index: 0, tone: 1, staff: 0 };
  const res = formatReadout(tune, cursor, lay, 2);
  assert.equal(res.isIdle, false);
  assert.equal(res.textHtml, 'C4 + <u>E4</u> · quarter');
  assert.equal(res.subText, 'bar 1 · beat 1');
});

test('formatSettingsSummary includes tempo, key, time signature and bars', () => {
  const tune = defaultTune();
  const summary = formatSettingsSummary(tune);
  assert.match(summary, /100/);
  assert.match(summary, /C major/);
  assert.match(summary, /4\/4/);
  assert.match(summary, /4 bars/);

  // Two staves and non-default instrument
  const twoStaffTune = {
    ...tune,
    instrument: 'flute',
    staff2: { clef: 'bass', events: [] },
  };
  const summary2 = formatSettingsSummary(twoStaffTune);
  assert.match(summary2, /2 staves/);
  assert.match(summary2, /Flute/);
});

test('formatHint returns contextual keyboard hints for idle and selected states', () => {
  const idleHint = formatHint(null);
  assert.match(idleHint, /Type <kbd>A<\/kbd>–<kbd>G<\/kbd>/);
  assert.match(idleHint, /<kbd>Space<\/kbd> play/);

  const singleNoteHint = formatHint({ step: 0, oct: 4, dur: 2 });
  assert.match(singleNoteHint, /half step/);
  assert.doesNotMatch(singleNoteHint, /next chord note/);

  const chordHint = formatHint({ step: 0, oct: 4, dur: 2, tones: [{ step: 2, oct: 4 }] });
  assert.match(chordHint, /next chord note/);
});

test('formatAriaLabel describes selection and staff for screen readers', () => {
  const tune = {
    ...defaultTune(),
    events: [{ step: 0, oct: 4, alter: 0, dur: 2 }],
  };
  const cursor = { type: 'note', index: 0, tone: 0, staff: 0 };
  const label = formatAriaLabel(tune, cursor);
  assert.equal(label, 'Staff. Selected: C4, quarter');

  // Caret cursor has no selected event
  assert.equal(formatAriaLabel(tune, { type: 'caret', index: 0, staff: 0 }), 'Staff');

  // Multi-staff tune with rest
  const twoStaffTune = {
    ...defaultTune(),
    staff2: { clef: 'bass', events: [{ rest: true, dur: 3 }] },
  };
  const labelRest = formatAriaLabel(twoStaffTune, { type: 'note', index: 0, staff: 1 });
  assert.equal(labelRest, 'Staff · lower staff. Selected: rest, half');
});

test('formatGhostTip provides descriptive insertion hints', () => {
  const tune = defaultTune();
  const slot = { st: 0, free: true, tick: 0 };
  const tip = formatGhostTip(slot, 0, tune, 2);
  assert.equal(tip.text, 'Insert E4 · quarter');
  assert.equal(tip.sub, 'earlier beats fill with rests');

  // Slot at end of events
  const slotAtEnd = { st: 0, free: false, index: 0 };
  const tipEnd = formatGhostTip(slotAtEnd, 0, tune, 2);
  assert.equal(tipEnd.sub, 'at the end');

  // Slot pushing 1 note
  const tuneWith1Note = {
    ...tune,
    events: [{ step: 0, oct: 4, dur: 2 }],
  };
  const tipPush1 = formatGhostTip(slotAtEnd, 0, tuneWith1Note, 2);
  assert.equal(tipPush1.sub, 'pushes 1 note later');

  // Slot pushing 2 notes
  const tuneWith2Notes = {
    ...tune,
    events: [{ step: 0, oct: 4, dur: 2 }, { step: 2, oct: 4, dur: 2 }],
  };
  const tipPush2 = formatGhostTip(slotAtEnd, 0, tuneWith2Notes, 2);
  assert.equal(tipPush2.sub, 'pushes 2 notes later');
});

test('formatHdStatus formats disabled, loading, and ready states accurately', () => {
  // Disabled state
  const disabled = formatHdStatus(false, { loaded: 2, total: 4, percent: 50, ready: false });
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.active, false);
  assert.equal(disabled.percent, 0);
  assert.equal(disabled.ringOffset, 37.7);
  assert.equal(disabled.badgeClass, '');
  assert.match(disabled.title, /Stream & cache/);

  // Loading partial state
  const partial = formatHdStatus(true, { loaded: 3, total: 6, percent: 50, ready: false });
  assert.equal(partial.enabled, true);
  assert.equal(partial.active, true);
  assert.equal(partial.percent, 50);
  assert.equal(partial.ringOffset, 18.9); // 37.7 * 0.5 = 18.85 rounded to 18.9
  assert.equal(partial.badgeClass, 'loading');
  assert.equal(partial.title, 'HD Samples: loading 3/6 notes (50%)');

  // Completed ready state
  const ready = formatHdStatus(true, { loaded: 6, total: 6, percent: 100, ready: true });
  assert.equal(ready.enabled, true);
  assert.equal(ready.active, true);
  assert.equal(ready.percent, 100);
  assert.equal(ready.ringOffset, 0);
  assert.equal(ready.badgeClass, 'ready');
  assert.equal(ready.title, 'HD Samples (all 6 notes ready)');

  // Default empty progress
  const empty = formatHdStatus(true, null);
  assert.equal(empty.ready, undefined);
  assert.equal(empty.badgeClass, 'ready');
  assert.equal(empty.percent, 100);
});
