// Modals, popovers, link sharing, and MusicXML export.
import { encode } from './codec.js';

/**
 * Initialize New Tune confirmation popover.
 */
export function initNewPopover({ newBtn, popEl, cancelBtn, okBtn, onConfirm }) {
  newBtn.onclick = () => { popEl.hidden = !popEl.hidden; };
  cancelBtn.onclick = () => { popEl.hidden = true; };
  okBtn.onclick = () => {
    popEl.hidden = true;
    onConfirm();
  };
  document.addEventListener('pointerdown', e => {
    if (!popEl.hidden && !e.target.closest('.pop-wrap')) popEl.hidden = true;
  });
}

/**
 * Copy or share current link via Web Share API or clipboard.
 */
export async function copyLink({ getTune, onFlushUrl, toast }) {
  onFlushUrl();
  const url = location.href;
  if (matchMedia('(max-width: 599px)').matches && navigator.share) {
    try {
      await navigator.share({ title: getTune().title || 'TuneShare', url });
      return;
    } catch (err) {
      if (err.name === 'AbortError') return;
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    toast({ title: 'Link copied', body: `${url.length} characters` });
  } catch {
    window.prompt('Copy this link:', url);
  }
}

/**
 * Trigger MusicXML file download (lazily loads musicxml module off critical path).
 */
export async function exportMusicXml(tune) {
  const { fileName, toMusicXML } = await import('./musicxml.js');
  const blob = new Blob([toMusicXML(tune)], { type: 'application/vnd.recordare.musicxml+xml' });
  const a = Object.assign(document.createElement('a'), {
    href: URL.createObjectURL(blob),
    download: fileName(tune),
  });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/**
 * Initialize keyboard shortcuts dialog sheet.
 */
export function initShortcutSheet({ sheetEl, closeBtn, openBtn, cardEl }) {
  const openSheet = () => { sheetEl.hidden = false; closeBtn.focus(); };
  const closeSheet = () => { sheetEl.hidden = true; cardEl.focus({ preventScroll: true }); };
  openBtn.onclick = openSheet;
  closeBtn.onclick = closeSheet;
  sheetEl.onclick = e => { if (e.target === sheetEl) closeSheet(); };
  return { openSheet, closeSheet, isOpen: () => !sheetEl.hidden };
}

/**
 * Initialize URL protobuf debug inspector modal (lazily loads debug module off critical path).
 */
export function initDebugModal({ debugEl, dumpEl, closeBtn, copyBtn, cardEl, getTune, closeSheet, toast }) {
  let dumpFragmentFn = null;
  const paintDebug = async () => {
    if (!dumpFragmentFn) {
      const mod = await import('./debug.js');
      dumpFragmentFn = mod.dumpFragment;
    }
    dumpEl.textContent = dumpFragmentFn('#' + encode(getTune()));
  };
  const openDebug = async () => {
    closeSheet();
    await paintDebug();
    debugEl.hidden = false;
    dumpEl.focus();
  };
  const closeDebug = () => { debugEl.hidden = true; cardEl.focus({ preventScroll: true }); };
  const toggleDebug = () => { debugEl.hidden ? openDebug() : closeDebug(); };
  closeBtn.onclick = closeDebug;
  debugEl.onclick = e => { if (e.target === debugEl) closeDebug(); };
  copyBtn.onclick = async () => {
    try {
      await navigator.clipboard.writeText(dumpEl.textContent);
      toast({ title: 'Debug dump copied' });
    } catch {
      window.prompt('Copy the dump:', dumpEl.textContent);
    }
  };
  return { openDebug, closeDebug, toggleDebug, paintDebug, isOpen: () => !debugEl.hidden };
}
