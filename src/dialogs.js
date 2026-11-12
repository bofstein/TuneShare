// Modals, popovers, link sharing, and MusicXML / MP3 export.
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
  download(blob, fileName(tune));
}

function download(blob, name) {
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

let mp3Busy = false;
/**
 * Render the tune to MP3 with the current instrument and sound mode and download it
 * (lazily loads the encoder off the critical path).
 */
export async function exportMp3(tune, { toast }) {
  if (mp3Busy) return;
  mp3Busy = true;
  try {
    toast({ title: 'Making MP3…', body: 'Getting ready', ms: 600000 });
    const { toMp3 } = await import('./mp3.js');
    let shown = '';
    const { blob, level, missingSamples } = await toMp3(tune, {
      onStage(stage, f) {
        const body = stage === 'samples' ? `Loading HD sounds ${Math.round(f * 100)}%` : `Rendering ${Math.round(f * 100)}%`;
        if (body !== shown) { shown = body; toast({ title: 'Making MP3…', body, ms: 600000 }); }
      },
    });
    const base = (tune.title || 'tune').replace(/[\\/:*?"<>|]+/g, '').trim().slice(0, 80) || 'tune';
    download(blob, base + '.mp3');
    const mb = (blob.size / 1048576).toFixed(1);
    if (missingSamples) toast({ kind: 'warn', title: 'MP3 downloaded', body: `${missingSamples} HD ${missingSamples === 1 ? 'sound' : 'sounds'} didn't load, so those notes use the standard sound.`, ms: 6000 });
    else if (level.channels === 1) toast({ kind: 'warn', title: 'MP3 downloaded in lower quality', body: 'This tune was too long for full quality on this device.', ms: 6000 });
    else toast({ title: 'MP3 downloaded', body: `${mb} MB`, ms: 3000 });
  } catch (err) {
    console.error(err);
    toast({ kind: 'warn', title: "Couldn't make the MP3", body: err?.message || 'Something went wrong.', ms: 6000 });
  } finally {
    mp3Busy = false;
  }
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
  const toggleDebug = () => (debugEl.hidden ? openDebug() : closeDebug());
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
