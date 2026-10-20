import test from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../src/model.js';
import { copySel, deleteRange, extendSel, extendTo, pasteEvents, selectedRange } from '../src/editor.js';

const n = (step, dur = 2) => ({ step, oct: 4, alter: 0, dur });
const tune = events => ({ ...M.defaultTune(), events });

test('shift-arrow builds a range from the caret and the anchor stays put', () => {
  let c = { type: 'caret', index: 1, staff: 0 };
  c = extendSel(c, 4, 1);
  assert.deepEqual(selectedRange(c), [1, 1]);
  c = extendSel(c, 4, 1);
  c = extendSel(c, 4, 1);
  assert.deepEqual(selectedRange(c), [1, 3]);
  c = extendSel(c, 4, 1);
  assert.deepEqual(selectedRange(c), [1, 3]);
  assert.deepEqual(selectedRange(extendTo(c, 4, 0)), [0, 1]);
});

test('copy then paste at the caret ripples later notes and selects the pasted run', () => {
  const t = tune([n(0), n(1), n(2), n(3)]);
  const clip = copySel(t, { type: 'note', index: 1, anchor: 0, staff: 0 });
  assert.equal(clip.length, 2);
  const op = pasteEvents(t, { type: 'caret', index: 4, staff: 0 }, clip);
  assert.deepEqual(op.result.tune.events.map(e => e.step), [0, 1, 2, 3, 0, 1]);
  assert.deepEqual(selectedRange(op.cursor), [4, 5]);
});

test('paste over a range replaces it; paste after one selected note inserts', () => {
  const t = tune([n(0), n(1), n(2), n(3)]);
  const clip = [n(6)];
  const r = pasteEvents(t, { type: 'note', index: 3, anchor: 1, staff: 0 }, clip);
  assert.deepEqual(r.result.tune.events.map(e => e.step), [0, 6]);
  const i = pasteEvents(t, { type: 'note', index: 0, staff: 0 }, clip);
  assert.deepEqual(i.result.tune.events.map(e => e.step), [0, 6, 1, 2, 3]);
});

test('paste that would push notes off the end is refused', () => {
  const t = { ...tune(Array.from({ length: 16 }, () => n(0))), measures: 4 };
  assert.equal(pasteEvents(t, { type: 'caret', index: 2, staff: 0 }, [n(1)]).result.error, M.ERR_FULL);
});

test('paste works on the lower staff only', () => {
  const t = { ...tune([n(0)]), staff2: { clef: 'bass', events: [n(4), n(5)] } };
  const clip = copySel(t, { type: 'note', index: 1, anchor: 0, staff: 1 });
  const op = pasteEvents(t, { type: 'caret', index: 2, staff: 1 }, clip);
  const whole = M.withStaffView(t, 1, op.result.tune);
  assert.deepEqual(whole.events.map(e => e.step), [0]);
  assert.deepEqual(whole.staff2.events.map(e => e.step), [4, 5, 4, 5]);
});

test('delete range removes the whole run', () => {
  const t = tune([n(0), n(1), n(2)]);
  const op = deleteRange(t, { type: 'note', index: 0, anchor: 1, staff: 0 });
  assert.deepEqual(op.result.tune.events.map(e => e.step), [2]);
});
