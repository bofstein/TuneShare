import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultTune } from '../src/model.js';
import { initKeyboard } from '../src/keyboard.js';

function setupKeyboard(overrides = {}) {
  let keydownHandler = null;
  globalThis.document = {
    addEventListener(event, handler) {
      if (event === 'keydown') keydownHandler = handler;
    },
  };

  const calls = [];
  const flags = {
    debugOpen: false,
    sheetOpen: false,
    dragging: false,
  };

  const cardEl = { isCard: true, closest: () => null };

  const tune = {
    ...defaultTune(),
    events: [
      { step: 0, oct: 4, alter: 0, dur: 2, tones: [{ step: 2, oct: 4, alter: 0 }] }, // chord note
    ],
  };
  const cursor = { type: 'note', index: 0, staff: 0 };

  const opts = {
    onDebug: () => calls.push('onDebug'),
    isDebugOpen: () => flags.debugOpen,
    closeDebug: () => calls.push('closeDebug'),
    isSheetOpen: () => flags.sheetOpen,
    closeSheet: () => calls.push('closeSheet'),
    openSheet: () => calls.push('openSheet'),
    isDragging: () => flags.dragging,
    cancelDrag: () => calls.push('cancelDrag'),
    onUndo: () => calls.push('onUndo'),
    onRedo: () => calls.push('onRedo'),
    onMovePitch: val => calls.push(`onMovePitch:${val}`),
    onMoveHalfStep: val => calls.push(`onMoveHalfStep:${val}`),
    onTypeLetter: step => calls.push(`onTypeLetter:${step}`),
    onAddToneLetter: step => calls.push(`onAddToneLetter:${step}`),
    onCycleTone: dir => calls.push(`onCycleTone:${dir}`),
    onTypeRest: () => calls.push('onTypeRest'),
    onSetDur: dur => calls.push(`onSetDur:${dur}`),
    onToggleDotted: () => calls.push('onToggleDotted'),
    onSwitchStaff: dir => calls.push(`onSwitchStaff:${dir}`),
    onSetAlter: alter => calls.push(`onSetAlter:${alter}`),
    onSwapSel: dir => calls.push(`onSwapSel:${dir}`),
    onMoveCursor: dir => calls.push(`onMoveCursor:${dir}`),
    onDeleteSel: () => calls.push('onDeleteSel'),
    onHome: () => calls.push('onHome'),
    onEnd: () => calls.push('onEnd'),
    onEscape: () => calls.push('onEscape'),
    onTogglePlay: () => calls.push('onTogglePlay'),
    onToggleLoop: () => calls.push('onToggleLoop'),
    cardEl,
    getTune: () => tune,
    getCursor: () => cursor,
    ...overrides,
  };

  initKeyboard(opts);

  const dispatch = (evt = {}) => {
    const e = {
      key: evt.key || '',
      ctrlKey: !!evt.ctrlKey,
      metaKey: !!evt.metaKey,
      shiftKey: !!evt.shiftKey,
      altKey: !!evt.altKey,
      target: evt.target || { closest: () => null },
      defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; },
    };
    keydownHandler(e);
    return e;
  };

  return { dispatch, calls, flags, cardEl };
}

test('Ctrl+D triggers debug modal and overrides bookmark shortcut', () => {
  const { dispatch, calls } = setupKeyboard();
  const evt = dispatch({ key: 'd', ctrlKey: true });
  assert.equal(calls.includes('onDebug'), true);
  assert.equal(evt.defaultPrevented, true);
});

test('Escape closes open debug modal, sheet, or cancels drag', () => {
  const { dispatch, calls, flags } = setupKeyboard();

  // Debug modal open
  flags.debugOpen = true;
  dispatch({ key: 'Escape' });
  assert.equal(calls.includes('closeDebug'), true);

  // Sheet open
  flags.debugOpen = false;
  flags.sheetOpen = true;
  dispatch({ key: 'Escape' });
  assert.equal(calls.includes('closeSheet'), true);

  // Dragging active
  flags.sheetOpen = false;
  flags.dragging = true;
  dispatch({ key: 'Escape' });
  assert.equal(calls.includes('cancelDrag'), true);
});

test('Typing in form fields ignores musical editing shortcuts', () => {
  const { dispatch, calls } = setupKeyboard();
  const inputTarget = { closest: sel => (sel.includes('input') ? true : null) };

  dispatch({ key: 'c', target: inputTarget });
  dispatch({ key: ' ', target: inputTarget });
  assert.equal(calls.length, 0);
});

test('Ctrl+Z and Ctrl+Y/Ctrl+Shift+Z trigger undo and redo', () => {
  const { dispatch, calls } = setupKeyboard();

  dispatch({ key: 'z', ctrlKey: true });
  assert.equal(calls.includes('onUndo'), true);

  dispatch({ key: 'z', ctrlKey: true, shiftKey: true });
  assert.equal(calls.includes('onRedo'), true);

  dispatch({ key: 'y', ctrlKey: true });
  assert.equal(calls.filter(c => c === 'onRedo').length, 2);
});

test('Ctrl+ArrowUp and Ctrl+ArrowDown adjust pitch by scale step or octave', () => {
  const { dispatch, calls } = setupKeyboard();

  dispatch({ key: 'ArrowUp', ctrlKey: true });
  assert.equal(calls.includes('onMovePitch:1'), true);

  dispatch({ key: 'ArrowDown', ctrlKey: true, shiftKey: true });
  assert.equal(calls.includes('onMovePitch:-7'), true);
});

test('Letter keys insert note or add tone to chord', () => {
  const { dispatch, calls } = setupKeyboard();

  // 'C' note (step 0)
  dispatch({ key: 'c' });
  assert.equal(calls.includes('onTypeLetter:0'), true);

  // Shift+'G' (step 4)
  dispatch({ key: 'G', shiftKey: true });
  assert.equal(calls.includes('onAddToneLetter:4'), true);
});

test('Tab cycles chord tones forward and backward', () => {
  const { dispatch, calls } = setupKeyboard();

  dispatch({ key: 'Tab' });
  assert.equal(calls.includes('onCycleTone:1'), true);

  dispatch({ key: 'Tab', shiftKey: true });
  assert.equal(calls.includes('onCycleTone:-1'), true);
});

test('Duration and modification shortcuts change rhythm and accidentals', () => {
  const { dispatch, calls } = setupKeyboard();

  dispatch({ key: 'r' });
  assert.equal(calls.includes('onTypeRest'), true);

  // 1 = whole (dur 4), 3 = quarter (dur 2)
  dispatch({ key: '1' });
  assert.equal(calls.includes('onSetDur:4'), true);
  dispatch({ key: '3' });
  assert.equal(calls.includes('onSetDur:2'), true);

  dispatch({ key: '.' });
  assert.equal(calls.includes('onToggleDotted'), true);

  // Alterations
  dispatch({ key: '#' });
  assert.equal(calls.includes('onSetAlter:1'), true);
  dispatch({ key: '-' });
  assert.equal(calls.includes('onSetAlter:-1'), true);
  dispatch({ key: 'n' });
  assert.equal(calls.includes('onSetAlter:0'), true);
});

test('Navigation and editing shortcuts handle cursor, home, end, swap, delete, escape', () => {
  const { dispatch, calls } = setupKeyboard();

  dispatch({ key: 'ArrowLeft' });
  assert.equal(calls.includes('onMoveCursor:-1'), true);
  dispatch({ key: 'ArrowRight', altKey: true });
  assert.equal(calls.includes('onSwapSel:1'), true);

  dispatch({ key: 'ArrowUp', altKey: true });
  assert.equal(calls.includes('onSwitchStaff:-1'), true);
  dispatch({ key: 'ArrowDown', altKey: true });
  assert.equal(calls.includes('onSwitchStaff:1'), true);

  dispatch({ key: 'ArrowUp' });
  assert.equal(calls.includes('onMoveHalfStep:1'), true);
  dispatch({ key: 'ArrowDown', shiftKey: true });
  assert.equal(calls.includes('onMovePitch:-7'), true);

  dispatch({ key: 'Home' });
  assert.equal(calls.includes('onHome'), true);
  dispatch({ key: 'End' });
  assert.equal(calls.includes('onEnd'), true);

  dispatch({ key: 'Backspace' });
  assert.equal(calls.includes('onDeleteSel'), true);
  dispatch({ key: 'Escape' });
  assert.equal(calls.includes('onEscape'), true);
});

test('Playback, loop, and sheet triggers handle space, l, and ?', () => {
  const { dispatch, calls, cardEl } = setupKeyboard();

  dispatch({ key: ' ' });
  assert.equal(calls.includes('onTogglePlay'), true);

  // Space inside another button is ignored
  const btnTarget = { closest: sel => (sel.includes('button') ? true : null) };
  dispatch({ key: ' ', target: btnTarget });
  assert.equal(calls.filter(c => c === 'onTogglePlay').length, 1);

  // Space inside card button is allowed
  dispatch({ key: ' ', target: cardEl });
  assert.equal(calls.filter(c => c === 'onTogglePlay').length, 2);

  dispatch({ key: 'l' });
  assert.equal(calls.includes('onToggleLoop'), true);

  dispatch({ key: '?' });
  assert.equal(calls.includes('openSheet'), true);

  // Unhandled key does not prevent default
  const unhandled = dispatch({ key: 'x' });
  assert.equal(unhandled.defaultPrevented, false);
});
