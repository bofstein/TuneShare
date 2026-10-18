import test from 'node:test';
import assert from 'node:assert/strict';

// Helper to construct a mock DOM element
function createElement(tag = 'div', attrs = {}) {
  const listeners = {};
  const children = [];
  const el = {
    tagName: tag.toUpperCase(),
    dataset: {},
    classList: {
      _classes: new Set(),
      add(c) { this._classes.add(c); },
      remove(c) { this._classes.delete(c); },
      toggle(c, force) {
        if (force === undefined) {
          if (this._classes.has(c)) this._classes.delete(c);
          else this._classes.add(c);
        } else if (force) this._classes.add(c);
        else this._classes.delete(c);
      },
      contains(c) { return this._classes.has(c); },
    },
    style: {
      setProperty(k, v) { this[k] = v; },
      removeProperty(k) { delete this[k]; },
    },
    attributes: {},
    setAttribute(k, v) { this.attributes[k] = String(v); },
    getAttribute(k) { return this.attributes[k]; },
    addEventListener(evt, fn) {
      listeners[evt] = listeners[evt] || [];
      listeners[evt].push(fn);
    },
    removeEventListener(evt, fn) {
      if (listeners[evt]) listeners[evt] = listeners[evt].filter(f => f !== fn);
    },
    dispatchEvent(evt) {
      if (listeners[evt.type]) listeners[evt.type].forEach(f => f(evt));
    },
    focus() {},
    blur() {},
    getBoundingClientRect() { return { left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600 }; },
    querySelectorAll(selector) {
      const results = [];
      if (selector === '[data-dur]') {
        for (let i = 0; i < 5; i++) {
          const btn = createElement('button');
          btn.dataset.dur = String(i);
          results.push(btn);
        }
      } else if (selector === '[data-alter]') {
        for (const a of [-1, 0, 1]) {
          const btn = createElement('button');
          btn.dataset.alter = String(a);
          results.push(btn);
        }
      }
      return results;
    },
    querySelector(sel) {
      if (sel === 'svg') return createElement('svg');
      if (sel === '.overlay') return createElement('g');
      if (sel === '.tune-bar') return createElement('div');
      return createElement('div');
    },
    clientWidth: 800,
    clientHeight: 600,
    innerHTML: '',
    textContent: '',
    value: '',
    disabled: false,
    hidden: false,
    ...attrs,
  };
  return el;
}

test('main.js loads, parses URL fragment, and renders without unhandled exceptions', async () => {
  const elements = {};
  const elementIds = [
    'toasts', 'staffHost', 'staffCard', 'title', 'bpm', 'tempoWord',
    'key', 'clefT', 'clefB', 'clefLbl', 'staves1', 'staves2', 'time',
    'instrument', 'measures', 'mUp', 'mDown', 'settingsSummary', 'readout',
    'hint', 'emptyHint', 'dot', 'rest', 'octUp', 'octDown', 'del',
    'undo', 'undoSm', 'redo', 'play', 'loop', 'preview', 'new', 'newPop',
    'newCancel', 'newOk', 'copy', 'exportXml', 'theme', 'sheet',
    'sheetClose', 'help', 'debug', 'debugDump', 'debugClose', 'debugCopy',
    'settingsToggle', 'noteBar', 'hdSamples', 'hdBadge', 'hdText', 'hdRingFill', 'hdField',
  ];
  for (const id of elementIds) {
    elements[id] = createElement('div', { id });
  }

  // Global environment mocks
  globalThis.document = {
    getElementById(id) {
      if (!elements[id]) elements[id] = createElement('div', { id });
      return elements[id];
    },
    querySelectorAll(sel) {
      return elements.staffCard.querySelectorAll(sel);
    },
    querySelector(sel) {
      return elements.staffCard.querySelector(sel);
    },
    addEventListener() {},
    removeEventListener() {},
    fonts: { ready: Promise.resolve() },
    documentElement: { dataset: {} },
    activeElement: null,
  };

  globalThis.location = {
    hash: '#2.ChRQaGFudG9tIG9mIHRoZSBPcGVyYRgBMAhSKA3dFyQ_FQ13F0Y1KV9ENV0QkIuPNSZe75grmqdQTPCcXCg42xbKIMBKFggBIhICCMjk0IOcEDoIOwIB8IOcGDw',
    href: 'https://bofstein.github.io/TuneShare/#2.ChRQaGFudG9tIG9mIHRoZSBPcGVyYRgBMAhSKA3dFyQ_FQ13F0Y1KV9ENV0QkIuPNSZe75grmqdQTPCcXCg42xbKIMBKFggBIhICCMjk0IOcEDoIOwIB8IOcGDw',
    reload() {},
  };

  globalThis.window = globalThis;
  globalThis.sessionStorage = {
    getItem() { return null; },
    setItem() {},
  };
  globalThis.localStorage = {
    getItem() { return null; },
    setItem() {},
  };
  globalThis.history = {
    replaceState() {},
  };
  globalThis.addEventListener = () => {};
  globalThis.removeEventListener = () => {};
  globalThis.matchMedia = () => ({ matches: false });
  globalThis.requestAnimationFrame = fn => setTimeout(fn, 0);
  globalThis.cancelAnimationFrame = id => clearTimeout(id);

  // Attempt to import main.js - should fail if variables or references are broken!
  await import(`../src/main.js?test=${Date.now()}`);

  assert.ok(elements.staffHost.innerHTML.length > 0, 'Staff should have rendered SVG markup');
  assert.equal(elements.title.value, 'Phantom of the Opera');

  // Verify toggling hdSamples invokes onchange cleanly without exceptions
  assert.equal(typeof elements.hdSamples.onchange, 'function');
  elements.hdSamples.checked = true;
  assert.doesNotThrow(() => elements.hdSamples.onchange());
  elements.hdSamples.checked = false;
  assert.doesNotThrow(() => elements.hdSamples.onchange());
});
