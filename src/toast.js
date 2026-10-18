// Toast notification UI and error reporting.
import * as M from './model.js';

const ICON_WARN = '<svg viewBox="0 0 24 24"><path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/></svg>';
const ICON_OK = '<svg viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5"/></svg>';

export const ERRORS = {
  'chord-full': ['Chord is full', `Chords can have up to ${M.MAX_CHORD_NOTES} notes.`],
  duplicate: ['Already in the chord', 'That line or space already has a note in this chord.'],
  'staff-not-empty': ["The lower staff isn't empty", 'Delete its notes first, or delete them all now.'],
};

let toastContainer = null;
let toastTimer = 0;

/**
 * Configure DOM container for toast notifications.
 */
export function setToastContainer(el) {
  toastContainer = el;
}

/**
 * Display a toast notification with optional action button and auto-dismiss.
 */
export function toast({ kind = 'info', title, body = '', action, onAction, ms }) {
  if (!toastContainer) return;
  clearTimeout(toastTimer);
  toastContainer.innerHTML = `<div class="toast ${kind}" role="status"><span class="ti">${kind === 'info' ? ICON_OK : ICON_WARN}</span>
    <div class="tx"><b></b><span></span></div>${action ? '<button class="act"></button>' : ''}
    <button class="x" aria-label="Dismiss"><svg viewBox="0 0 24 24"><path d="M18 6L6 18M6 6l12 12"/></svg></button></div>`;
  const el = toastContainer.firstElementChild;
  el.querySelector('b').textContent = title;
  el.querySelector('.tx span').textContent = body;
  const close = () => { if (toastContainer) toastContainer.innerHTML = ''; };
  if (action) {
    const b = el.querySelector('.act');
    b.textContent = action;
    b.onclick = () => { close(); onAction(); };
  }
  el.querySelector('.x').onclick = close;
  toastTimer = setTimeout(close, ms ?? (kind === 'info' ? 2500 : 6000));
}

/**
 * Show a warning when an edit cannot fit in the available measures.
 */
export function warnFull(tune, onAddMeasure) {
  if (tune.measures < M.MAX_MEASURES) {
    toast({
      kind: 'warn',
      title: 'Not enough room',
      body: `This would push notes past the end of bar ${tune.measures}.`,
      action: 'Add measure',
      onAction: () => onAddMeasure && onAddMeasure(tune.measures + 1),
    });
  } else {
    toast({
      kind: 'warn',
      title: 'The tune is full',
      body: `All ${M.MAX_MEASURES} measures are used. Delete or shorten a note first.`,
    });
  }
}

/**
 * Show error toast for model edit failure.
 */
export function showError(result, tune, onAddMeasure) {
  if (result.error === M.ERR_FULL) {
    warnFull(tune, onAddMeasure);
  } else if (ERRORS[result.error]) {
    toast({ kind: 'warn', title: ERRORS[result.error][0], body: ERRORS[result.error][1], ms: 4000 });
  }
  return false;
}
