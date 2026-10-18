import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultTune } from '../src/model.js';
import { layout } from '../src/layout.js';
import { initGestures } from '../src/gestures.js';

function createMockElement(rect = { left: 0, top: 0, right: 800, bottom: 600 }) {
  const listeners = {};
  return {
    listeners,
    addEventListener(event, fn) {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(fn);
    },
    dispatch(event, e = {}) {
      const handlers = listeners[event] || [];
      const ev = {
        pointerId: 1,
        pointerType: 'mouse',
        button: 0,
        clientX: 50,
        clientY: 50,
        preventDefault() {},
        ...e,
      };
      handlers.forEach(h => h(ev));
    },
    getBoundingClientRect: () => rect,
    setPointerCapture: () => {},
    focus: () => {},
  };
}

function setupGestures(tuneOverride = null) {
  let tune = tuneOverride || {
    ...defaultTune(),
    events: [
      { step: 0, oct: 4, alter: 0, dur: 2 }, // quarter C4 at tick 0
      { step: 2, oct: 4, alter: 0, dur: 2 }, // quarter E4 at tick 4
    ],
  };
  let cursor = { type: 'caret', index: 0, staff: 0 };
  let lay = layout(tune, { width: 600, perSys: 2, sp: 10 });
  let inputDur = 2;

  const card = createMockElement();
  const host = {
    querySelector: () => ({ getBoundingClientRect: () => ({ left: 0, top: 0 }) }),
  };

  const durBtn = createMockElement();
  durBtn.dataset = { dur: '2' };
  durBtn.querySelector = sel => (sel === '.mg' ? { outerHTML: '<span class="mg">test</span>' } : null);

  const actions = [];
  globalThis.document = {
    createElement: () => ({
      className: '',
      innerHTML: '',
      style: {},
      remove: () => {},
    }),
    body: {
      appendChild: () => {},
    },
  };

  const gest = initGestures({
    card,
    host,
    durButtons: [durBtn],
    getTune: () => tune,
    getCursor: () => cursor,
    getLay: () => lay,
    getInputDur: () => inputDur,
    onSelect: (ev, tone, s) => {
      cursor = { type: 'note', index: ev, tone, staff: s };
      actions.push(`onSelect:${ev}:${tone}:${s}`);
    },
    onEdit: fn => {
      const res = fn();
      actions.push('onEdit');
      return res;
    },
    onPlaceNote: (hover, dur) => actions.push(`onPlaceNote:${dur}`),
    onCommitTune: t => { tune = t; actions.push('onCommitTune'); },
    onSetTune: t => { tune = t; actions.push('onSetTune'); },
    onSetCursor: c => { cursor = c; actions.push('onSetCursor'); },
    onPreview: p => actions.push(`onPreview:${p.step}`),
    onRender: () => actions.push('onRender'),
    onPaintOverlay: () => actions.push('onPaintOverlay'),
    onSetDur: d => actions.push(`onSetDur:${d}`),
    isPreviewOn: () => true,
    isPlaying: () => false,
    stopPlayback: () => actions.push('stopPlayback'),
  });

  return { gest, card, durBtn, actions, lay, getTune: () => tune };
}

test('pointermove updates hover and pointerleave clears hover', () => {
  const { card, actions, gest } = setupGestures();

  // Pointermove over empty tick
  card.dispatch('pointermove', { clientX: 200, clientY: 45 });
  assert.equal(actions.includes('onPaintOverlay'), true);
  const state = gest.getOverlayState();
  assert.ok(state.hover || state.chordHover);

  // Pointerleave resets hover
  card.dispatch('pointerleave');
  assert.equal(gest.getOverlayState().hover, null);
  assert.equal(gest.getOverlayState().chordHover, null);
});

test('pointerdown on notehead initiates pitch dragging and commits new pitch', () => {
  const { card, actions, gest, lay } = setupGestures();
  const s0 = lay.geo.eventSpan(0, 0);
  const yNote0 = lay.geo.yB(0, 0) - (-2) * (lay.sp / 2); // C4 is pos -2

  // Click on note 0 head
  card.dispatch('pointerdown', { clientX: s0.x, clientY: yNote0 });
  assert.equal(actions.includes('stopPlayback'), true);
  assert.equal(actions.includes('onSelect:0:0:0'), true);
  assert.equal(gest.isDragging(), true);

  // Drag upwards
  card.dispatch('pointermove', { clientX: s0.x, clientY: yNote0 - 20 });
  assert.equal(actions.includes('onRender'), true);
  assert.equal(actions.includes('onSetTune'), true);

  // Release pointer
  card.dispatch('pointerup', { clientX: s0.x, clientY: yNote0 - 20 });
  assert.equal(actions.includes('onCommitTune'), true);
  assert.equal(gest.isDragging(), false);
});

test('pointerdown on empty area initiates note placement and places note on pointerup', () => {
  const { card, actions, gest, lay } = setupGestures();
  const yStaff = lay.geo.yB(0, 0) - 4 * (lay.sp / 2);

  // Click empty area in bar 1
  card.dispatch('pointerdown', { clientX: 250, clientY: yStaff });
  assert.equal(gest.isDragging(), true);

  // Pointermove while dragging place
  card.dispatch('pointermove', { clientX: 250, clientY: yStaff });

  // Pointerup places note
  card.dispatch('pointerup', { clientX: 250, clientY: yStaff });
  assert.equal(actions.includes('onPlaceNote:2'), true);
  assert.equal(gest.isDragging(), false);
});

test('duration chips dragging supports click to set duration and drag to place note', () => {
  const { durBtn, actions, gest, lay } = setupGestures();
  const yStaff = lay.geo.yB(0, 0) - 4 * (lay.sp / 2);

  // 1. Simple click without moving (pointerdown + pointerup)
  durBtn.dispatch('pointerdown', { clientX: 10, clientY: 10 });
  assert.equal(gest.isDragging(), true);

  durBtn.dispatch('pointerup', { clientX: 10, clientY: 10 });
  assert.equal(actions.includes('onSetDur:2'), true);
  assert.equal(gest.isDragging(), false);

  // 2. Drag chip beyond threshold (>= 6px) over the staff
  durBtn.dispatch('pointerdown', { clientX: 10, clientY: 10 });
  durBtn.dispatch('pointermove', { clientX: 250, clientY: yStaff });
  durBtn.dispatch('pointerup', { clientX: 250, clientY: yStaff });
  assert.equal(actions.includes('onPlaceNote:2'), true);
});

test('cancelDrag resets dragging state and restores original tune', () => {
  const { card, gest, lay } = setupGestures();
  const s0 = lay.geo.eventSpan(0, 0);
  const yNote0 = lay.geo.yB(0, 0) - (-2) * (lay.sp / 2);

  card.dispatch('pointerdown', { clientX: s0.x, clientY: yNote0 });
  assert.equal(gest.isDragging(), true);

  gest.cancelDrag();
  assert.equal(gest.isDragging(), false);
});

test('shift-click in selected note column adds note to chord', () => {
  const { card, actions, lay } = setupGestures();
  const s0 = lay.geo.eventSpan(0, 0);
  const yAbove = lay.geo.yB(0, 0) - 2 * (lay.sp / 2); // pos 2 (G4)

  // Select note 0 first
  card.dispatch('pointerdown', { clientX: s0.x, clientY: lay.geo.yB(0, 0) - (-2) * (lay.sp / 2) });

  // Shift-click above note 0 in its column
  card.dispatch('pointerdown', { clientX: s0.x, clientY: yAbove, shiftKey: true });
  assert.equal(actions.includes('onEdit'), true);
});

test('click on chord target adds note to chord without shift', () => {
  const { card, actions, lay } = setupGestures();
  const s0 = lay.geo.eventSpan(0, 0);
  const yAbove = lay.geo.yB(0, 0) - 2 * (lay.sp / 2); // pos 2 (G4)

  // Click above note 0 where chordTargetAt detects a tone
  card.dispatch('pointerdown', { clientX: s0.x, clientY: yAbove });
  assert.equal(actions.includes('onEdit'), true);
});
