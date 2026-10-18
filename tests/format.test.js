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
});

test('formatAriaLabel describes selection and staff for screen readers', () => {
  const tune = {
    ...defaultTune(),
    events: [{ step: 0, oct: 4, alter: 0, dur: 2 }],
  };
  const cursor = { type: 'note', index: 0, tone: 0, staff: 0 };
  const label = formatAriaLabel(tune, cursor);
  assert.equal(label, 'Staff. Selected: C4, quarter');
});

test('formatGhostTip provides descriptive insertion hints', () => {
  const tune = defaultTune();
  const slot = { st: 0, free: true, tick: 0 };
  const tip = formatGhostTip(slot, 0, tune, 2);
  assert.equal(tip.text, 'Insert E4 · quarter');
  assert.equal(tip.sub, 'earlier beats fill with rests');
});
