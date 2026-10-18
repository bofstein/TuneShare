import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultTune } from '../src/model.js';
import {
  initNewPopover,
  copyLink,
  exportMusicXml,
  initShortcutSheet,
  initDebugModal,
} from '../src/dialogs.js';

test('initNewPopover handles toggle, cancel, confirmation and outside click', () => {
  let pointerdownHandler = null;
  globalThis.document = {
    addEventListener(event, handler) {
      if (event === 'pointerdown') pointerdownHandler = handler;
    },
  };

  const newBtn = {};
  const cancelBtn = {};
  const okBtn = {};
  const popEl = { hidden: true };
  let confirmed = false;

  initNewPopover({
    newBtn,
    popEl,
    cancelBtn,
    okBtn,
    onConfirm: () => { confirmed = true; },
  });

  // Clicking newBtn toggles hidden
  newBtn.onclick();
  assert.equal(popEl.hidden, false);

  // Clicking cancelBtn hides
  cancelBtn.onclick();
  assert.equal(popEl.hidden, true);

  // Clicking okBtn hides and confirms
  popEl.hidden = false;
  okBtn.onclick();
  assert.equal(popEl.hidden, true);
  assert.equal(confirmed, true);

  // Pointerdown outside closes popover
  popEl.hidden = false;
  pointerdownHandler({ target: { closest: () => null } });
  assert.equal(popEl.hidden, true);

  // Pointerdown inside does not close popover
  popEl.hidden = false;
  pointerdownHandler({ target: { closest: sel => (sel === '.pop-wrap' ? true : null) } });
  assert.equal(popEl.hidden, false);
});

test('copyLink shares link on mobile or copies to clipboard on desktop', async () => {
  let flushed = false;
  const tune = { ...defaultTune(), title: 'Test Melody' };
  let toastMsg = null;
  const toast = msg => { toastMsg = msg; };

  globalThis.location = { href: 'http://localhost/#testlink' };

  // 1. Mobile with navigator.share
  let sharedData = null;
  globalThis.matchMedia = query => ({ matches: query.includes('max-width') });
  Object.defineProperty(globalThis, 'navigator', {
    value: {
      share: async data => { sharedData = data; },
      clipboard: { writeText: async () => {} },
    },
    configurable: true,
    writable: true,
  });

  await copyLink({
    getTune: () => tune,
    onFlushUrl: () => { flushed = true; },
    toast,
  });
  assert.equal(flushed, true);
  assert.deepEqual(sharedData, { title: 'Test Melody', url: 'http://localhost/#testlink' });

  // 2. Mobile with navigator.share throwing AbortError (user dismisses system share sheet)
  globalThis.navigator.share = async () => {
    const err = new Error('Share canceled');
    err.name = 'AbortError';
    throw err;
  };
  await assert.doesNotReject(() => copyLink({ getTune: () => tune, onFlushUrl: () => {}, toast }));

  // 3. Desktop with navigator.clipboard.writeText
  globalThis.matchMedia = () => ({ matches: false });
  let copiedText = '';
  globalThis.navigator = {
    clipboard: {
      writeText: async text => { copiedText = text; },
    },
  };

  await copyLink({ getTune: () => tune, onFlushUrl: () => {}, toast });
  assert.equal(copiedText, 'http://localhost/#testlink');
  assert.equal(toastMsg.title, 'Link copied');

  // 4. Desktop with clipboard failure falling back to window.prompt
  globalThis.navigator.clipboard.writeText = async () => { throw new Error('Blocked'); };
  let promptMsg = null, promptVal = null;
  globalThis.window = {
    prompt: (msg, val) => { promptMsg = msg; promptVal = val; },
  };

  await copyLink({ getTune: () => tune, onFlushUrl: () => {}, toast });
  assert.match(promptMsg, /Copy this link/);
  assert.equal(promptVal, 'http://localhost/#testlink');
});

test('exportMusicXml lazily imports musicxml and triggers download', async () => {
  let clicked = false;
  let createdBlob = null;
  let objectUrl = 'blob:mock-url';
  let revokedUrl = null;

  globalThis.Blob = class {
    constructor(parts, opts) {
      createdBlob = { parts, opts };
    }
  };

  globalThis.URL = {
    createObjectURL: () => objectUrl,
    revokeObjectURL: url => { revokedUrl = url; },
  };

  const anchorMock = {
    href: '',
    download: '',
    click: () => { clicked = true; },
  };

  globalThis.document = {
    createElement: tag => (tag === 'a' ? anchorMock : {}),
  };

  const tune = { ...defaultTune(), title: 'Ode to Joy' };
  await exportMusicXml(tune);

  assert.equal(clicked, true);
  assert.equal(anchorMock.download, 'Ode to Joy.musicxml');
  assert.equal(anchorMock.href, objectUrl);
  assert.ok(createdBlob.parts[0].includes('<?xml'));

  // Revocation timeout check
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.equal(revokedUrl, objectUrl);
});

test('initShortcutSheet opens, closes, and detects click on backdrop', () => {
  let focusedEl = null;
  const sheetEl = { hidden: true };
  const closeBtn = { focus: () => { focusedEl = 'closeBtn'; } };
  const openBtn = {};
  const cardEl = { focus: () => { focusedEl = 'cardEl'; } };

  const sheet = initShortcutSheet({ sheetEl, closeBtn, openBtn, cardEl });

  assert.equal(sheet.isOpen(), false);

  openBtn.onclick();
  assert.equal(sheetEl.hidden, false);
  assert.equal(focusedEl, 'closeBtn');
  assert.equal(sheet.isOpen(), true);

  closeBtn.onclick();
  assert.equal(sheetEl.hidden, true);
  assert.equal(focusedEl, 'cardEl');
  assert.equal(sheet.isOpen(), false);

  // Click on backdrop closes
  sheet.openSheet();
  sheetEl.onclick({ target: sheetEl });
  assert.equal(sheetEl.hidden, true);

  // Click on inner content does not close
  sheet.openSheet();
  sheetEl.onclick({ target: {} });
  assert.equal(sheetEl.hidden, false);
});

test('initDebugModal lazily loads debug module, toggles display and copies dump', async () => {
  let focusedEl = null;
  let sheetClosed = false;
  let toastMsg = null;

  const debugEl = { hidden: true };
  const dumpEl = { textContent: '', focus: () => { focusedEl = 'dumpEl'; } };
  const closeBtn = {};
  const copyBtn = {};
  const cardEl = { focus: () => { focusedEl = 'cardEl'; } };
  const tune = defaultTune();

  globalThis.location = { hash: '#test' };

  const debug = initDebugModal({
    debugEl,
    dumpEl,
    closeBtn,
    copyBtn,
    cardEl,
    getTune: () => tune,
    closeSheet: () => { sheetClosed = true; },
    toast: msg => { toastMsg = msg; },
  });

  assert.equal(debug.isOpen(), false);

  // Toggle debug opens and loads debug dump
  await debug.toggleDebug();
  assert.equal(sheetClosed, true);
  assert.equal(debugEl.hidden, false);
  assert.ok(dumpEl.textContent.includes('Tune'));
  assert.equal(focusedEl, 'dumpEl');
  assert.equal(debug.isOpen(), true);

  // Toggle debug again closes
  debug.toggleDebug();
  assert.equal(debugEl.hidden, true);
  assert.equal(focusedEl, 'cardEl');

  // Copy dump to clipboard
  let copiedText = '';
  globalThis.navigator.clipboard = {
    writeText: async text => { copiedText = text; },
  };

  await copyBtn.onclick();
  assert.ok(copiedText.length > 0);
  assert.equal(toastMsg.title, 'Debug dump copied');

  // Copy failure fallback to window.prompt
  globalThis.navigator.clipboard = {
    writeText: async () => { throw new Error('Blocked'); },
  };
  let promptVal = '';
  globalThis.window = {
    prompt: (_msg, val) => { promptVal = val; },
  };

  await copyBtn.onclick();
  assert.equal(promptVal, dumpEl.textContent);

  // Backdrop click closes modal
  await debug.openDebug();
  debugEl.onclick({ target: debugEl });
  assert.equal(debugEl.hidden, true);
});
