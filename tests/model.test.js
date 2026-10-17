import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../src/model.js';
import { tune, parse, ODE } from './helpers.js';

const n = s => parse(s)[0];

test('insert pushes later notes', () => {
  const r = M.insert(tune('C4:q D4:q E4:q'), 1, n('G4:q'));
  assert.deepEqual(r.tune.events, parse('C4:q G4:q D4:q E4:q'));
});

test('insert into a full tune is rejected', () => {
  const t = tune(ODE, { measures: 8 });
  assert.equal(M.insert(t, 3, n('C5:q')).error, M.ERR_FULL);
});

test('insert uses up trailing rests, shortening them if needed', () => {
  const t = tune('C4:w | D4:w | E4:w | F4:h r:h');
  const r = M.insert(t, 0, n('G4:q'));
  assert.deepEqual(r.tune.events, parse('G4:q C4:w D4:w E4:w F4:h r:q'));
  const r2 = M.insert(t, 0, n('G4:h'));
  assert.deepEqual(r2.tune.events, parse('G4:h C4:w D4:w E4:w F4:h'));
  assert.equal(M.insert(t, 0, n('G4:h.')).error, M.ERR_FULL);
});

test('partial rest trim is re-spelled as legal values', () => {
  const t = tune('C4:w | C4:w | C4:w | C4:q r:h.');
  const r = M.insert(t, 0, n('D4:s'));
  // overflow of 1 tick shortens the 12-tick rest to 11 = 8 + 3
  assert.deepEqual(r.tune.events.slice(-2), parse('r:h r:e.'));
});

test('lengthening ripples and respects the overflow rule', () => {
  const t = tune('C4:q D4:q', { measures: 1 });
  assert.deepEqual(M.setDuration(t, 0, 3).tune.events, parse('C4:h D4:q'));
  assert.equal(M.setDuration(t, 0, 4).error, M.ERR_FULL);
});

test('delete closes the gap', () => {
  assert.deepEqual(M.remove(tune('C4:q D4:q E4:q'), 1).tune.events, parse('C4:q E4:q'));
});

test('insertAtTick pads with beat-aligned rests', () => {
  const r = M.insertAtTick(tune(''), 16 + 6, n('C5:q'));
  assert.deepEqual(r.tune.events, parse('r:w r:q r:e C5:q'));
});

test('remove measure only when it is empty', () => {
  assert.equal(M.setMeasures(tune('C4:w C4:w C4:w C4:q'), 3).error, 'measure-not-empty');
  assert.equal(M.setMeasures(tune('C4:w C4:w C4:w r:w'), 3).tune.measures, 3);
});

test('time signature change expands measures to fit', () => {
  const r = M.setTime(tune('C4:w C4:w C4:w C4:w'), '3/4');
  assert.equal(r.tune.measures, 6);
  assert.equal(r.expanded, 6);
  assert.equal(M.setTime(tune('C4:w '.repeat(12), { measures: 12 }), '2/4').error, M.ERR_FULL);
});

test('swap reorders neighbours', () => {
  assert.deepEqual(M.swap(tune('C4:q D4:h'), 0, 1).tune.events, parse('D4:h C4:q'));
});

const P = (step, oct, alter = 0) => ({ step, oct, alter });

test('addTone builds chords up to the cap and refuses duplicates', () => {
  let t = tune('C4:q');
  for (const step of [2, 4, 6]) t = M.addTone(t, 0, P(step, 4)).tune;
  t = M.addTone(t, 0, P(1, 5)).tune;
  t = M.addTone(t, 0, P(3, 5)).tune;
  assert.equal(M.pitchesOf(t.events[0]).length, M.MAX_CHORD_NOTES);
  assert.equal(M.addTone(t, 0, P(5, 5)).error, 'chord-full');
  assert.equal(M.addTone(tune('C4:q'), 0, P(0, 4, 1)).error, 'duplicate');
  assert.equal(M.addTone(tune('r:q'), 0, P(0, 4)).error, 'not-a-note');
});

test('removeTone promotes the next tone, and removes the event when one pitch is left', () => {
  let t = M.addTone(tune('C4:q D4:q'), 0, P(2, 4)).tune;
  assert.deepEqual(M.removeTone(t, 0, 0).tune.events[0], { dur: 2, ...P(2, 4) });
  assert.deepEqual(M.removeTone(M.removeTone(t, 0, 0).tune, 0, 0).tune.events, parse('D4:q'));
});

test('chords keep their tones through ripple edits and length changes', () => {
  const t = M.addTone(tune('C4:q'), 0, P(2, 4)).tune;
  const r = M.setDuration(M.insert(t, 0, n('G4:q')).tune, 1, 3).tune;
  assert.deepEqual(r.events[1].tones, [P(2, 4)]);
  assert.equal(r.events[1].dur, 3);
});
