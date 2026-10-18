// UI string and accessibility formatting helpers. Pure, no DOM.
import {
  CLEFS,
  DUR_NAME,
  clampDiatonic,
  diatonic,
  fromDiatonic,
  keyAlter,
  keyName,
  pitchName,
} from './theory.js';
import * as M from './model.js';
import { DEFAULT_INSTRUMENT, instrumentName } from './instruments.js';
import { G } from './layout.js';

export const kbd = s => `<kbd>${s}</kbd>`;

const staffName = s => (s ? 'lower staff' : 'upper staff');

/**
 * Format readout status text and subtitle.
 */
export function formatReadout(tune, cursor, lay, inputDur) {
  const staff = cursor.staff || 0;
  const twoStaves = M.staffCount(tune) > 1;
  const where = twoStaves ? ` · ${staffName(staff)}` : '';
  const sel = cursor.type === 'note' ? M.staffEvents(tune, staff)[cursor.index] : null;

  if (sel) {
    const st = lay ? lay.geo.staves[staff].starts[cursor.index] : 0;
    const tpm = M.measureTicks(tune);
    const bt = (st % tpm) / 4 + 1;
    const frac = bt % 1;
    const beat = Math.floor(bt) + (frac === 0.5 ? '½' : frac === 0.25 ? '¼' : frac === 0.75 ? '¾' : '');
    const subText = `bar ${Math.floor(st / tpm) + 1} · beat ${beat}${where}`;

    if (sel.rest) {
      return { isIdle: false, textHtml: 'Rest · ' + DUR_NAME[sel.dur], subText };
    }

    const selTone = Math.min(cursor.tone || 0, M.pitchesOf(sel).length - 1);
    const ps = M.pitchesOf(sel)
      .map((p, t) => [p, t])
      .sort((a, b) => diatonic(a[0]) - diatonic(b[0]));

    const textHtml = ps
      .map(([p, t]) => (ps.length > 1 && t === selTone ? `<u>${pitchName(p)}</u>` : pitchName(p)))
      .join(' + ') + ' · ' + DUR_NAME[sel.dur];

    return { isIdle: false, textHtml, subText };
  }

  return {
    isIdle: true,
    textHtml: `Next note: ${DUR_NAME[inputDur]}`,
    subText: where ? `on the ${staffName(staff)} · Alt+↑↓ switches` : 'type A–G or click the staff',
  };
}

/**
 * Format contextual keyboard hints HTML.
 */
export function formatHint(selectedEvent) {
  if (selectedEvent) {
    const isMultiChord = selectedEvent && !selectedEvent.rest && M.pitchesOf(selectedEvent).length > 1;
    const tabHint = isMultiChord ? `<span>${kbd('Tab')} next chord note</span>` : '';
    return (
      `<span>${kbd('↑')}${kbd('↓')} half step</span>` +
      `<span>${kbd('Ctrl')}+${kbd('↑')}${kbd('↓')} scale step</span>` +
      `<span>${kbd('⇧')}+${kbd('A')}–${kbd('G')} add to chord</span>` +
      tabHint +
      `<span>${kbd('⇧')}+${kbd('↑')}${kbd('↓')} octave</span>` +
      `<span>${kbd('1')}–${kbd('5')} length</span>` +
      `<span>${kbd('#')} ${kbd('-')} ${kbd('=')} accidentals</span>` +
      `<span>${kbd('A')}–${kbd('G')} insert after</span>` +
      `<span>${kbd('⌫')} delete</span>` +
      `<span>${kbd('?')} all shortcuts</span>`
    );
  }
  return (
    `<span>Type ${kbd('A')}–${kbd('G')} to add notes</span>` +
    `<span>Click the staff to place one</span>` +
    `<span>Drag a note from the toolbar</span>` +
    `<span>${kbd('Space')} play</span>` +
    `<span>${kbd('?')} all shortcuts</span>`
  );
}

/**
 * Format summary line displayed in tune settings toggle button.
 */
export function formatSettingsSummary(tune) {
  const twoStaves = M.staffCount(tune) > 1;
  const inst = tune.instrument && tune.instrument !== DEFAULT_INSTRUMENT ? ` · ${instrumentName(tune.instrument)}` : '';
  const staves = twoStaves ? ' · 2 staves' : '';
  return `<span class="mg">${G.mQ}</span>=${tune.bpm} · ${keyName(tune.key).split(' / ')[0]} · ${tune.time} · ${tune.measures} bars${staves}${inst}`;
}

/**
 * Format accessibility label for screen readers on the main staff card.
 */
export function formatAriaLabel(tune, cursor) {
  const staff = cursor.staff || 0;
  const where = M.staffCount(tune) > 1 ? ` · ${staffName(staff)}` : '';
  const sel = cursor.type === 'note' ? M.staffEvents(tune, staff)[cursor.index] : null;
  if (!sel) return 'Staff';
  const desc = sel.rest ? 'rest' : M.pitchesOf(sel).map(pitchName).join(', ');
  return `Staff${where}. Selected: ${desc}, ${DUR_NAME[sel.dur]}`;
}

/**
 * Format hover tooltip when dragging or hovering note placement.
 */
export function formatGhostTip(slot, pos, tune, dur) {
  const view = M.staffView(tune, slot.st);
  const c = CLEFS[view.clef];
  const d = clampDiatonic(view.clef, pos + c.bottom);
  const p = fromDiatonic(d);
  const name = pitchName({ ...p, alter: keyAlter(view.key, p.step) });
  const moved = slot.free ? 0 : M.staffEvents(tune, slot.st).slice(slot.index).filter(e => !e.rest).length;
  const sub = slot.free
    ? 'earlier beats fill with rests'
    : moved
      ? `pushes ${moved} note${moved > 1 ? 's' : ''} later`
      : 'at the end';
  return { text: `Insert ${name} · ${DUR_NAME[dur]}`, sub };
}
