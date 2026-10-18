import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultTune } from '../src/model.js';
import { Store } from '../src/store.js';

test('Store initializes state, cursor, and history stacks', () => {
  const tune = defaultTune();
  const store = new Store(tune);

  assert.equal(store.tune, tune);
  assert.deepEqual(store.cursor, { type: 'caret', index: 0, staff: 0 });
  assert.equal(store.undoStack.length, 0);
  assert.equal(store.redoStack.length, 0);
});

test('Store subscribe and emit notifies listeners on change', () => {
  const store = new Store(defaultTune());
  const changes = [];
  store.subscribe(ch => changes.push(ch));

  store.emit('tune');
  store.emit('cursor');

  assert.deepEqual(changes, ['tune', 'cursor']);
});

test('Store setCursor retains staff and clamps within event bounds', () => {
  const tune = {
    ...defaultTune(),
    events: [
      { step: 0, oct: 4, alter: 0, dur: 2 },
      { step: 2, oct: 4, alter: 0, dur: 2 },
    ],
  };
  const store = new Store(tune);

  // Set note cursor without specifying staff -> keeps staff 0
  store.setCursor({ type: 'note', index: 1 });
  assert.deepEqual(store.cursor, { type: 'note', index: 1, staff: 0 });

  // Out of bounds note cursor clamps to caret at end of events
  store.setCursor({ type: 'note', index: 99 });
  assert.deepEqual(store.cursor, { type: 'caret', index: 2, staff: 0 });

  // Caret cursor clamped within [0, n]
  store.setCursor({ type: 'caret', index: -5 });
  assert.deepEqual(store.cursor, { type: 'caret', index: 0, staff: 0 });

  store.setCursor({ type: 'caret', index: 10 });
  assert.deepEqual(store.cursor, { type: 'caret', index: 2, staff: 0 });
});

test('Store commit records undo state, clears redo, and respects MAX_UNDO limit', () => {
  const tune = defaultTune();
  const store = new Store(tune);

  // Setup mock location/history for writeUrl
  globalThis.location = { hash: '', href: 'http://localhost/' };
  globalThis.history = { replaceState: (_st, _title, hash) => { globalThis.location.hash = hash; } };

  const tune1 = { ...tune, bpm: 120 };
  store.commit(tune1, { type: 'note', index: 0 });

  assert.equal(store.tune, tune1);
  assert.equal(store.undoStack.length, 1);
  assert.equal(store.undoStack[0].tune, tune);

  // Test MAX_UNDO = 200 limit
  for (let i = 0; i < 210; i++) {
    store.commit({ ...tune, bpm: 100 + i });
  }
  assert.equal(store.undoStack.length, 200);
});

test('Store undo and redo cycles through history correctly', () => {
  const tune0 = defaultTune();
  const store = new Store(tune0);

  const tune1 = { ...tune0, bpm: 110 };
  const tune2 = { ...tune0, bpm: 130 };

  store.commit(tune1, { type: 'caret', index: 0, staff: 0 });
  store.commit(tune2, { type: 'caret', index: 0, staff: 0 });

  assert.equal(store.tune.bpm, 130);

  // Undo to tune1
  store.undo();
  assert.equal(store.tune.bpm, 110);
  assert.equal(store.redoStack.length, 1);

  // Undo to tune0
  store.undo();
  assert.equal(store.tune.bpm, 100);

  // Undo at start is a no-op
  store.undo();
  assert.equal(store.tune.bpm, 100);

  // Redo to tune1
  store.redo();
  assert.equal(store.tune.bpm, 110);

  // Redo to tune2
  store.redo();
  assert.equal(store.tune.bpm, 130);

  // Redo at end is a no-op
  store.redo();
  assert.equal(store.tune.bpm, 130);
});

test('Store load replaces tune and clears undo/redo history', () => {
  const store = new Store(defaultTune());
  store.commit({ ...defaultTune(), bpm: 140 });
  assert.equal(store.undoStack.length, 1);

  const freshTune = { ...defaultTune(), bpm: 80, events: [{ rest: true, dur: 4 }] };
  let notified = false;
  store.subscribe(ch => { if (ch === 'tune') notified = true; });

  store.load(freshTune);
  assert.equal(store.tune, freshTune);
  assert.equal(store.undoStack.length, 0);
  assert.equal(store.redoStack.length, 0);
  assert.deepEqual(store.cursor, { type: 'caret', index: 1, staff: 0 });
  assert.equal(notified, true);
});

test('Store writeUrl and flushUrl updates location hash and invokes onUrl callback', async () => {
  globalThis.location = { hash: '', href: 'http://localhost/' };
  let replacedHash = '';
  globalThis.history = { replaceState: (_st, _title, hash) => {
    replacedHash = hash;
    globalThis.location.hash = hash;
  } };

  const store = new Store(defaultTune());
  let urlLen = 0;
  store.onUrl = len => { urlLen = len; };

  store.writeUrl();
  assert.ok(store.timer > 0);

  // Immediate flushUrl clears timer and writes hash
  store.flushUrl();
  assert.ok(store.lastHash.startsWith('#'));
  assert.equal(globalThis.location.hash, store.lastHash);
  assert.equal(replacedHash, store.lastHash);
  assert.ok(urlLen > 0);
});
