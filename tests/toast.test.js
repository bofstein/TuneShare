import test from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../src/model.js';
import {
  setToastContainer,
  toast,
  warnFull,
  showError,
  ERRORS,
} from '../src/toast.js';

function createMockContainer() {
  const container = {
    _html: '',
    firstElementChild: null,
    get innerHTML() { return this._html; },
    set innerHTML(val) {
      this._html = val;
      if (!val) {
        this.firstElementChild = null;
        return;
      }
      const bNode = { textContent: '' };
      const spanNode = { textContent: '' };
      const actBtn = val.includes('class="act"') ? { textContent: '', onclick: null } : null;
      const xBtn = { onclick: null };
      this.firstElementChild = {
        querySelector(selector) {
          if (selector === 'b') return bNode;
          if (selector === '.tx span') return spanNode;
          if (selector === '.act') return actBtn;
          if (selector === '.x') return xBtn;
          return null;
        },
        b: bNode,
        span: spanNode,
        act: actBtn,
        x: xBtn,
      };
    },
  };
  return container;
}

test('toast does nothing when container is not configured', () => {
  setToastContainer(null);
  assert.doesNotThrow(() => {
    toast({ title: 'Noop', body: 'No container' });
  });
});

test('toast renders info notification and allows manual dismiss', () => {
  const container = createMockContainer();
  setToastContainer(container);

  toast({ kind: 'info', title: 'Saved', body: 'All changes saved' });
  assert.ok(container.innerHTML.includes('toast info'));
  assert.equal(container.firstElementChild.b.textContent, 'Saved');
  assert.equal(container.firstElementChild.span.textContent, 'All changes saved');

  // Dismiss via close button
  container.firstElementChild.x.onclick();
  assert.equal(container.innerHTML, '');
});

test('toast renders action button and executes onAction callback', () => {
  const container = createMockContainer();
  setToastContainer(container);

  let actionClicked = false;
  toast({
    kind: 'warn',
    title: 'Undo limit',
    body: 'Revert to beginning?',
    action: 'Revert',
    onAction: () => { actionClicked = true; },
  });

  assert.ok(container.innerHTML.includes('toast warn'));
  assert.ok(container.firstElementChild.act);
  assert.equal(container.firstElementChild.act.textContent, 'Revert');

  container.firstElementChild.act.onclick();
  assert.equal(actionClicked, true);
  assert.equal(container.innerHTML, '');
});

test('toast auto-dismisses after specified timeout', async () => {
  const container = createMockContainer();
  setToastContainer(container);

  toast({ kind: 'info', title: 'Temporary', body: 'Disappearing', ms: 50 });
  assert.notEqual(container.innerHTML, '');

  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(container.innerHTML, '');
});

test('warnFull offers measure expansion when below MAX_MEASURES', () => {
  const container = createMockContainer();
  setToastContainer(container);

  let addedBar = 0;
  const tune = { ...M.defaultTune(), measures: 4 };
  warnFull(tune, bar => { addedBar = bar; });

  assert.equal(container.firstElementChild.b.textContent, 'Not enough room');
  assert.equal(container.firstElementChild.act.textContent, 'Add measure');

  container.firstElementChild.act.onclick();
  assert.equal(addedBar, 5);
});

test('warnFull indicates tune is full when reaching MAX_MEASURES', () => {
  const container = createMockContainer();
  setToastContainer(container);

  const tune = { ...M.defaultTune(), measures: M.MAX_MEASURES };
  warnFull(tune);

  assert.equal(container.firstElementChild.b.textContent, 'The tune is full');
  assert.equal(container.firstElementChild.act, null);
});

test('showError maps known model errors and warns when full', () => {
  const container = createMockContainer();
  setToastContainer(container);

  const tune = { ...M.defaultTune(), measures: 4 };

  // ERR_FULL
  showError({ error: M.ERR_FULL }, tune);
  assert.equal(container.firstElementChild.b.textContent, 'Not enough room');

  // Known ERRORS mapping: chord-full, duplicate, staff-not-empty
  for (const errKey of Object.keys(ERRORS)) {
    showError({ error: errKey }, tune);
    assert.equal(container.firstElementChild.b.textContent, ERRORS[errKey][0]);
    assert.equal(container.firstElementChild.span.textContent, ERRORS[errKey][1]);
  }

  // Unknown error returns false
  const handled = showError({ error: 'unknown-err' }, tune);
  assert.equal(handled, false);
});
