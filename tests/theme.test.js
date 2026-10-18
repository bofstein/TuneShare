import test from 'node:test';
import assert from 'node:assert/strict';
import { toggleTheme } from '../src/theme.js';

test('toggleTheme toggles root dataset and persists to localStorage', () => {
  const stored = {};
  globalThis.document = {
    documentElement: {
      dataset: { theme: 'light' },
    },
  };
  globalThis.localStorage = {
    setItem: (k, v) => { stored[k] = v; },
    getItem: k => stored[k],
  };

  toggleTheme();
  assert.equal(globalThis.document.documentElement.dataset.theme, 'dark');
  assert.equal(stored.theme, 'dark');

  toggleTheme();
  assert.equal(globalThis.document.documentElement.dataset.theme, 'light');
  assert.equal(stored.theme, 'light');
});

test('toggleTheme swallows localStorage exceptions when storage is blocked', () => {
  globalThis.document = {
    documentElement: {
      dataset: { theme: 'dark' },
    },
  };
  globalThis.localStorage = {
    setItem: () => { throw new Error('SecurityError: Access is denied'); },
  };

  assert.doesNotThrow(() => {
    toggleTheme();
  });
  assert.equal(globalThis.document.documentElement.dataset.theme, 'light');
});
