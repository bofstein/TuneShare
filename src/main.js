// App controller: wires the store, staff rendering, input, toolbar and playback.
import {
  CLEFS, DUR_NAME, DUR_TICKS, KEY_NAMES, canDot, clampDiatonic, diatonic, fromDiatonic, keyAlter, keyLabel,
  keyName, pitchName, tempoWord, toggleDot, undotted,
} from './theory.js';
import * as M from './model.js';
import { decode, encode } from './codec.js';
import { dumpFragment } from './debug.js';
import { layout, G } from './layout.js';
import { renderStaff, renderOverlay } from './render.js';
import { Player, preview } from './audio.js';
import { Store } from './store.js';
import { toggleTheme } from './theme.js';

const $ = id => document.getElementById(id);
const host = $('staffHost'), card = $('staffCard');

// ---------- state ----------
const initial = decode(location.hash);
const store = new Store(initial.tune);
store.lastHash = location.hash;
const player = new Player();
let inputDur = 2;               // duration for the next note; follows the selected note's length
let previewOn = true, loopOn = false;
let playing = [];               // "staff:index" keys of the events sounding now
let lay = null;
let hover = null;               // {slot, pos} ghost while hovering / placing / dragging a chip
let drag = null;                // active pointer interaction

// Edits work on the active staff (the cursor's) through a view of the tune: header fields plus
// that staff's clef and events. apply() writes the view back. See model.js, "second staff".
const staffIdx = () => store.cursor.staff || 0;
const tune = () => M.staffView(store.tune, staffIdx());
const twoStaves = () => M.staffCount(store.tune) > 1;
const staffName = s => (s ? 'lower staff' : 'upper staff');
const selIndex = () => (store.cursor.type === 'note' ? store.cursor.index : -1);
const selected = () => tune().events[selIndex()] || null;
/** Which pitch of the selected chord is selected (0 = main pitch). */
const selTone = () => {
  const e = selected();
  return e && !e.rest ? Math.min(store.cursor.tone || 0, M.pitchesOf(e).length - 1) : 0;
};
const selPitch = () => { const e = selected(); return e && !e.rest ? M.pitchesOf(e)[selTone()] : null; };
const insertIndex = () => (store.cursor.type === 'note' ? store.cursor.index + 1 : store.cursor.index);
const activeDur = () => (selected() ? selected().dur : inputDur);

// ---------- toasts ----------
const ICON_WARN = '<svg viewBox="0 0 24 24"><path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/></svg>';
const ICON_OK = '<svg viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5"/></svg>';
let toastTimer = 0;
function toast({ kind = 'info', title, body = '', action, onAction, ms }) {
  const region = $('toasts');
  clearTimeout(toastTimer);
  region.innerHTML = `<div class="toast ${kind}" role="status"><span class="ti">${kind === 'info' ? ICON_OK : ICON_WARN}</span>
    <div class="tx"><b></b><span></span></div>${action ? '<button class="act"></button>' : ''}
    <button class="x" aria-label="Dismiss"><svg viewBox="0 0 24 24"><path d="M18 6L6 18M6 6l12 12"/></svg></button></div>`;
  const el = region.firstElementChild;
  el.querySelector('b').textContent = title;
  el.querySelector('.tx span').textContent = body;
  const close = () => { region.innerHTML = ''; };
  if (action) { const b = el.querySelector('.act'); b.textContent = action; b.onclick = () => { close(); onAction(); }; }
  el.querySelector('.x').onclick = close;
  toastTimer = setTimeout(close, ms ?? (kind === 'info' ? 2500 : 6000));
}

function warnFull() {
  const t = tune();
  if (t.measures < M.MAX_MEASURES) {
    toast({ kind: 'warn', title: 'Not enough room', body: `This would push notes past the end of bar ${t.measures}.`, action: 'Add measure', onAction: () => setMeasures(t.measures + 1) });
  } else {
    toast({ kind: 'warn', title: 'The tune is full', body: `All ${M.MAX_MEASURES} measures are used. Delete or shorten a note first.` });
  }
}

// ---------- edits ----------
const ERRORS = {
  'chord-full': ['Chord is full', `Chords can have up to ${M.MAX_CHORD_NOTES} notes.`],
  duplicate: ['Already in the chord', 'That line or space already has a note in this chord.'],
  'staff-not-empty': ["The lower staff isn't empty", 'Delete its notes first.'],
};
/** Commit an edit made on the view of staff s (default: the active staff). */
function apply(result, cursor, sound, s = staffIdx()) {
  if (result.error) return showError(result);
  applyWhole({ tune: M.withStaffView(store.tune, s, result.tune) }, cursor && { ...cursor, staff: s }, sound);
  return true;
}
/** Commit an edit made on the whole tune (all staves). */
function applyWhole(result, cursor, sound) {
  if (result.error) return showError(result);
  store.commit(result.tune, cursor);
  if (sound && previewOn && !sound.rest) preview(...M.pitchesOf(sound));
  return true;
}
function showError(result) {
  if (result.error === M.ERR_FULL) warnFull();
  else if (ERRORS[result.error]) toast({ kind: 'warn', title: ERRORS[result.error][0], body: ERRORS[result.error][1], ms: 4000 });
  return false;
}

/** Add a chord tone with letter `step` to the selected note, in the nearest octave above the selected pitch. */
function addToneLetter(step) {
  const sel = selected(), sp = selPitch();
  if (!sel || sel.rest) { typeLetter(step); return; }
  const c = CLEFS[tune().clef], ref = diatonic(sp);
  let d = step + 7 * Math.ceil((ref + 1 - step) / 7);
  if (d > c.max) d -= 7;
  addTone({ ...fromDiatonic(d), alter: keyAlter(tune().key, step) });
}

function addTone(p) {
  const i = selIndex();
  apply(M.addTone(tune(), i, p), { type: 'note', index: i, tone: M.pitchesOf(selected()).length }, p);
}

function cycleTone(dir) {
  const e = selected();
  if (!e || e.rest) return;
  const ps = M.pitchesOf(e);
  if (ps.length < 2) return;
  // Cycle in pitch order (bottom to top), not entry order.
  const order = ps.map((p, t) => [diatonic(p), t]).sort((a, b) => a[0] - b[0]).map(([, t]) => t);
  const k = order.indexOf(selTone());
  const tone = order[(k + dir + order.length) % order.length];
  store.setCursor({ ...store.cursor, tone });
  if (previewOn && !player.playing) preview(ps[tone]);
}

function refDiatonic(index) {
  for (let i = Math.min(index, tune().events.length - 1); i >= 0; i--) {
    const e = tune().events[i];
    if (!e.rest) return diatonic(e);
  }
  return CLEFS[tune().clef].middle;
}

function noteFor(step, ref) {
  const base = step + 7 * Math.round((ref - step) / 7);
  let d = base;
  const c = CLEFS[tune().clef];
  while (d < c.min) d += 7;
  while (d > c.max) d -= 7;
  return { ...fromDiatonic(d), alter: keyAlter(tune().key, step) };
}

function typeLetter(step) {
  const sel = selected();
  if (sel && sel.rest) {
    const n = { ...noteFor(step, refDiatonic(selIndex() - 1)), dur: sel.dur };
    apply(M.replace(tune(), selIndex(), n), null, n);
    return;
  }
  const idx = insertIndex();
  const n = { ...noteFor(step, refDiatonic(idx - 1)), dur: activeDur() };
  apply(M.insert(tune(), idx, n), { type: 'note', index: idx }, n);
}

function typeRest() {
  const sel = selected();
  if (sel && !sel.rest) { apply(M.replace(tune(), selIndex(), { rest: true, dur: sel.dur })); return; }
  const idx = insertIndex();
  apply(M.insert(tune(), idx, { rest: true, dur: activeDur() }), { type: 'note', index: idx });
}

function setDur(base) {
  const sel = selected();
  if (sel) {
    const dur = sel.dur >= 5 && canDot(base) ? base + 4 : base;
    apply(M.setDuration(tune(), selIndex(), dur));
  } else { inputDur = base; sync(); }
}

function toggleDotted() {
  const sel = selected();
  if (sel) { if (canDot(sel.dur) || sel.dur >= 5) apply(M.setDuration(tune(), selIndex(), toggleDot(sel.dur))); }
  else { inputDur = toggleDot(inputDur); sync(); }
}

function movePitch(steps) {
  const cur = selPitch();
  if (!cur) return;
  const d = clampDiatonic(tune().clef, diatonic(cur) + steps);
  const p = { ...fromDiatonic(d), alter: Math.abs(steps) === 7 ? cur.alter : keyAlter(tune().key, fromDiatonic(d).step) };
  apply(M.setTonePitch(tune(), selIndex(), selTone(), p), null, p);
}

function setAlter(a) {
  const cur = selPitch();
  if (!cur) return;
  const keyDefault = keyAlter(tune().key, cur.step);
  const p = { ...cur, alter: cur.alter === a && a !== keyDefault ? keyDefault : a };
  apply(M.setTonePitch(tune(), selIndex(), selTone(), p), null, p);
}

function deleteSel() {
  const i = selIndex();
  if (i < 0) {
    // Backspace at the caret deletes the event before it.
    const c = store.cursor.index;
    if (c > 0) apply(M.remove(tune(), c - 1), { type: 'caret', index: c - 1 });
    return;
  }
  const e = tune().events[i];
  if (!e.rest && M.pitchesOf(e).length > 1) {
    // In a chord, delete just the selected tone; keep the chord selected.
    apply(M.removeTone(tune(), i, selTone()), { type: 'note', index: i, tone: 0 });
    return;
  }
  apply(M.remove(tune(), i), i > 0 ? { type: 'note', index: i - 1 } : { type: 'caret', index: 0 });
}

function swapSel(dir) {
  const i = selIndex();
  if (i < 0) return;
  const j = i + dir;
  if (j < 0 || j >= tune().events.length) return;
  apply(M.swap(tune(), i, dir), { type: 'note', index: j });
}

function moveCursor(dir) {
  const c = store.cursor, n = tune().events.length;
  if (!n) return;
  let i;
  if (c.type === 'note') i = c.index + dir;
  else i = dir > 0 ? c.index : c.index - 1;
  if (i < 0) { store.setCursor({ type: 'caret', index: 0 }); return; }
  if (i >= n) { store.setCursor({ type: 'caret', index: n }); return; }
  select(i);
}

function select(i, tone = 0, staff = staffIdx()) {
  store.setCursor({ type: 'note', index: i, tone, staff });
  const e = tune().events[i];
  if (e && !e.rest && previewOn && !player.playing) preview(...M.pitchesOf(e));
}

function setMeasures(n) {
  const r = M.setMeasures(store.tune, n);
  if (r.error) { toast({ kind: 'warn', title: `Measure ${tune().measures} isn't empty`, body: 'Delete its notes first.', ms: 4000 }); return; }
  applyWhole(r);
}

/** Move to the other staff, keeping the caret at the same point in time. */
function switchStaff(dir) {
  const to = staffIdx() + dir;
  if (!lay || to < 0 || to >= M.staffCount(store.tune)) return;
  const cur = lay.geo.staves[staffIdx()], c = store.cursor;
  const tick = c.index < cur.starts.length ? cur.starts[c.index] : cur.used;
  const next = lay.geo.staves[to].starts;
  let index = next.findIndex(t => t >= tick);
  if (index < 0) index = next.length;
  store.setCursor({ type: 'caret', index, staff: to });
}

function setStaves(n) {
  if (n === M.staffCount(store.tune)) return;
  if (n === 2) { applyWhole(M.addStaff(store.tune), { type: 'caret', index: 0, staff: 1 }); return; }
  applyWhole(M.removeStaff(store.tune, 1), { type: 'caret', index: store.tune.events.length, staff: 0 });
}

function edit(fn) { return () => { stopPlayback(); fn(); }; }

// ---------- playback ----------
function togglePlay() {
  if (player.playing) { stopPlayback(); return; }
  const from = selIndex() >= 0 && lay ? lay.geo.staves[staffIdx()].starts[selIndex()] : 0;
  player.play(store.tune, from, {
    loop: () => loopOn,
    onEvent: keys => { playing = keys; paintClasses(); if (keys.length) scrollToEvent(keys[0]); },
    onEnd: () => { playing = []; paintClasses(); syncPlay(); },
  });
  syncPlay();
}
function stopPlayback() {
  if (!player.playing) return;
  player.stop(); playing = []; paintClasses(); syncPlay();
}
function scrollToEvent(key) {
  const [s, i] = key.split(':');
  const g = host.querySelector(`.ev[data-s="${s}"][data-i="${i}"]`);
  if (g && g.scrollIntoView) g.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

// ---------- rendering ----------
function render() {
  const w = Math.max(280, host.clientWidth);
  const perSys = w >= 860 ? 4 : w >= 560 ? 3 : 2;
  const sp = w >= 560 ? 10 : 8;
  lay = layout(tune(), { width: w, perSys, sp });
  host.innerHTML = renderStaff(lay);
  paintClasses();
  paintOverlay();
  sync();
}

function paintClasses() {
  host.querySelectorAll('.ev').forEach(g => {
    const i = +g.dataset.i, sel = +g.dataset.s === staffIdx() && i === selIndex();
    g.classList.toggle('sel', sel);
    g.classList.toggle('play', playing.includes(`${g.dataset.s}:${i}`));
    g.querySelectorAll('.halo').forEach(h => h.classList.toggle('on', sel && +h.dataset.tone === selTone()));
  });
}

/** Compute where an insert at (loc) would go: {st, index|tick, k, x}, st = the staff under the pointer. */
function slotFor(loc) {
  const { geo } = lay, st = loc.s, ev = M.staffEvents(store.tune, st), { used, starts } = geo.staves[st];
  if (loc.abs >= used) {
    const tick = Math.min(Math.round(loc.abs / 2) * 2, M.capacity(store.tune) - 1);
    if (tick <= used) {
      const s = geo.slotX(used);
      return { st, index: ev.length, k: s.k, x: s.x, abs: used };
    }
    const m = Math.floor(tick / geo.tpm);
    return { st, tick, k: geo.systems.findIndex(s => m >= s.mFirst && m <= s.mLast), x: geo.tx(m, tick - m * geo.tpm), abs: tick, free: true };
  }
  let j = 0;
  while (j < ev.length - 1 && starts[j + 1] <= loc.abs) j++;
  const len = DUR_TICKS[ev[j].dur];
  const index = loc.abs - starts[j] < len / 2 ? j : j + 1;
  const abs = index < ev.length ? starts[index] : used;
  const s = geo.slotX(abs);
  return { st, index, k: s.k, x: s.x, abs };
}

const clefOf = s => M.staffView(store.tune, s).clef;
function ghostPos(loc) {
  const clef = clefOf(loc.s), c = CLEFS[clef];
  return clampDiatonic(clef, loc.pos + c.bottom) - c.bottom;
}

function paintOverlay() {
  const ov = host.querySelector('.overlay');
  if (!ov || !lay) return;
  const o = {};
  const hw = 1.18 * lay.sp;
  if (hover) {
    const { slot, pos, tip, rest } = hover;
    o.marker = slot.free ? null : { k: slot.k, s: slot.st, x: slot.x };
    o.ghost = { k: slot.k, s: slot.st, x: slot.free ? slot.x : slot.x - hw / 2, pos, ticks: DUR_TICKS[activeDurForGhost()], rest };
    if (tip) o.tip = tip;
  } else if (store.cursor.type === 'caret') {
    const { starts, used } = lay.geo.staves[staffIdx()];
    const abs = store.cursor.index < tune().events.length ? starts[store.cursor.index] : used;
    const s = lay.geo.slotX(Math.min(abs, M.capacity(tune()) - 1));
    o.marker = { k: s.k, s: staffIdx(), x: s.x, caret: true };
  }
  ov.innerHTML = renderOverlay(lay, o);
}
const activeDurForGhost = () => (drag && drag.kind === 'chip' ? drag.dur : inputDur);

// ---------- toolbar / controls sync ----------
const kbd = s => `<kbd>${s}</kbd>`;
function sync() {
  const t = tune(), sel = selected();
  if (sel) inputDur = sel.dur;    // new notes take the length of the last selected note (#6)
  const dur = activeDur(), base = undotted(dur);
  document.querySelectorAll('[data-dur]').forEach(b => b.classList.toggle('on', +b.dataset.dur === base));
  $('dot').classList.toggle('on', dur >= 5);
  $('dot').disabled = !canDot(dur) && dur < 5;
  $('rest').classList.toggle('on', !!(sel && sel.rest));
  const isNote = !!(sel && !sel.rest), sp = selPitch();
  document.querySelectorAll('[data-alter]').forEach(b => {
    const a = +b.dataset.alter;
    b.disabled = !isNote;
    b.classList.toggle('on', isNote && sp.alter === a && a !== keyAlter(t.key, sp.step));
  });
  $('octUp').disabled = $('octDown').disabled = !isNote;
  $('del').disabled = !t.events.length;
  $('undo').disabled = $('undoSm').disabled = !store.undoStack.length;
  $('redo').disabled = !store.redoStack.length;

  const ro = $('readout');
  const where = twoStaves() ? ` · ${staffName(staffIdx())}` : '';
  if (sel) {
    const st = lay ? lay.geo.staves[staffIdx()].starts[selIndex()] : 0, tpm = M.measureTicks(t);
    const bt = (st % tpm) / 4 + 1;
    const frac = bt % 1, beat = Math.floor(bt) + (frac === 0.5 ? '½' : frac === 0.25 ? '¼' : frac === 0.75 ? '¾' : '');
    ro.className = 'readout';
    ro.innerHTML = `<span></span><span class="sub">bar ${Math.floor(st / tpm) + 1} · beat ${beat}${where}</span>`;
    if (sel.rest) ro.firstChild.textContent = 'Rest · ' + DUR_NAME[sel.dur];
    else {
      // Chord: list pitches bottom to top, underlining the selected one.
      const ps = M.pitchesOf(sel).map((p, t) => [p, t]).sort((a, b) => diatonic(a[0]) - diatonic(b[0]));
      ro.firstChild.innerHTML = ps.map(([p, t]) => (ps.length > 1 && t === selTone() ? `<u>${pitchName(p)}</u>` : pitchName(p))).join(' + ')
        + ' · ' + DUR_NAME[sel.dur];
    }
  } else {
    ro.className = 'readout idle';
    ro.innerHTML = `<span>Next note: ${DUR_NAME[inputDur]}</span><span class="sub">${where ? `on the ${staffName(staffIdx())} · Alt+↑↓ switches` : 'type A–G or click the staff'}</span>`;
  }

  $('hint').innerHTML = sel
    ? `<span>${kbd('↑')}${kbd('↓')} pitch</span><span>${kbd('⇧')}+${kbd('A')}–${kbd('G')} add to chord</span>${sel && M.pitchesOf(sel).length > 1 ? `<span>${kbd('Tab')} next chord note</span>` : ''}<span>${kbd('⇧')}+${kbd('↑')}${kbd('↓')} octave</span><span>${kbd('1')}–${kbd('5')} length</span><span>${kbd('#')} ${kbd('-')} ${kbd('=')} accidentals</span><span>${kbd('A')}–${kbd('G')} insert after</span><span>${kbd('⌫')} delete</span><span>${kbd('?')} all shortcuts</span>`
    : `<span>Type ${kbd('A')}–${kbd('G')} to add notes</span><span>Click the staff to place one</span><span>Drag a note from the toolbar</span><span>${kbd('Space')} play</span><span>${kbd('?')} all shortcuts</span>`;
  $('emptyHint').hidden = store.tune.events.length > 0 || twoStaves();

  if (document.activeElement !== $('title')) $('title').value = t.title;
  if (document.activeElement !== $('bpm')) $('bpm').value = t.bpm;
  $('tempoWord').textContent = tempoWord(t.bpm);
  $('key').value = String(t.key);
  $('clefT').classList.toggle('on', t.clef === 'treble');
  $('clefB').classList.toggle('on', t.clef === 'bass');
  $('clefLbl').textContent = twoStaves() ? `Clef (${staffIdx() ? 'lower' : 'upper'})` : 'Clef';
  $('staves1').classList.toggle('on', !twoStaves());
  $('staves2').classList.toggle('on', twoStaves());
  $('time').value = t.time;
  $('measures').textContent = t.measures;
  $('mUp').disabled = t.measures >= M.MAX_MEASURES;
  $('mDown').disabled = t.measures <= 1;
  $('settingsSummary').innerHTML = `<span class="mg">${G.mQ}</span>=${t.bpm} · ${keyName(t.key).split(' / ')[0]} · ${t.time} · ${t.measures} bars${twoStaves() ? ' · 2 staves' : ''}`;
  document.title = t.title ? `${t.title} — TuneShare` : 'TuneShare';
  card.setAttribute('aria-label', sel ? `Staff${where}. Selected: ${sel.rest ? 'rest' : M.pitchesOf(sel).map(pitchName).join(', ')}, ${DUR_NAME[sel.dur]}` : 'Staff');
  syncPlay();
}

const PLAY = '<svg viewBox="0 0 24 24"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z"/></svg>';
const STOP = '<svg viewBox="0 0 24 24"><rect x="5" y="5" width="14" height="14" rx="2.5"/></svg>';
function syncPlay() {
  const b = $('play');
  b.classList.toggle('playing', player.playing);
  b.innerHTML = player.playing ? STOP : PLAY;
  b.setAttribute('aria-label', player.playing ? 'Stop (Space)' : 'Play (Space)');
  $('loop').classList.toggle('on', loopOn);
  $('loop').setAttribute('aria-pressed', loopOn);
  $('preview').classList.toggle('on', previewOn);
  $('preview').setAttribute('aria-pressed', previewOn);
}

// ---------- keyboard ----------
document.addEventListener('keydown', e => {
  const t = e.target;
  // Ctrl+D works everywhere (even in text fields) and overrides the browser's bookmark shortcut.
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'd') { toggleDebug(); e.preventDefault(); return; }
  if (!$('debug').hidden) { if (e.key === 'Escape') { closeDebug(); e.preventDefault(); } return; }
  if (t.closest && t.closest('input, select, textarea')) return;
  if (!$('sheet').hidden) { if (e.key === 'Escape' || e.key === '?') closeSheet(); return; }
  if (drag && e.key === 'Escape') { cancelDrag(); e.preventDefault(); return; }
  const mod = e.ctrlKey || e.metaKey;
  if (mod) {
    const k = e.key.toLowerCase();
    if (k === 'z' && !e.shiftKey) { stopPlayback(); store.undo(); e.preventDefault(); }
    else if ((k === 'z' && e.shiftKey) || k === 'y') { stopPlayback(); store.redo(); e.preventDefault(); }
    return;
  }
  const key = e.key;
  let handled = true;
  if (/^[a-g]$/i.test(key) && !e.altKey) {
    const step = 'CDEFGAB'.indexOf(key.toUpperCase());
    edit(() => (e.shiftKey ? addToneLetter(step) : typeLetter(step)))();
  }
  else if (key === 'Tab' && selected() && M.pitchesOf(selected()).length > 1) cycleTone(e.shiftKey ? -1 : 1);
  else if (key === 'r' || key === 'R') edit(typeRest)();
  else if (/^[1-5]$/.test(key)) edit(() => setDur([4, 3, 2, 1, 0][+key - 1]))();
  else if (key === '.') edit(toggleDotted)();
  else if ((key === 'ArrowUp' || key === 'ArrowDown') && e.altKey) switchStaff(key === 'ArrowUp' ? -1 : 1);
  else if (key === 'ArrowUp') edit(() => movePitch(e.shiftKey ? 7 : 1))();
  else if (key === 'ArrowDown') edit(() => movePitch(e.shiftKey ? -7 : -1))();
  else if (key === '#' || key === '+') edit(() => setAlter(1))();
  else if (key === '-' || key === '_') edit(() => setAlter(-1))();
  else if (key === '=' || key === 'n' || key === 'N') edit(() => setAlter(0))();
  else if (key === 'ArrowLeft') e.altKey ? edit(() => swapSel(-1))() : moveCursor(-1);
  else if (key === 'ArrowRight') e.altKey ? edit(() => swapSel(1))() : moveCursor(1);
  else if (key === 'Home') store.setCursor({ type: 'caret', index: 0 });
  else if (key === 'End') store.setCursor({ type: 'caret', index: tune().events.length });
  else if (key === 'Backspace' || key === 'Delete') edit(deleteSel)();
  else if (key === 'Escape') { if (selIndex() >= 0) store.setCursor({ type: 'caret', index: selIndex() + 1 }); }
  else if (key === ' ') { if (t.closest && t.closest('button') && t !== card) return; togglePlay(); }
  else if (key === 'l' || key === 'L') { loopOn = !loopOn; syncPlay(); }
  else if (key === '?') openSheet();
  else handled = false;
  if (handled) e.preventDefault();
});

// ---------- pointer: staff ----------
function svgPoint(ev) {
  const svg = host.querySelector('svg');
  const r = svg.getBoundingClientRect();
  return { x: ev.clientX - r.left, y: ev.clientY - r.top };
}
function overStaff(ev) {
  const r = card.getBoundingClientRect();
  return ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom;
}
function hoverAt(ev, withTip) {
  if (!lay) return null;
  const { x, y } = svgPoint(ev);
  const yy = ev.pointerType === 'touch' ? y - 3 * lay.sp : y;     // keep the ghost visible above the finger
  const loc = lay.geo.locate(x, yy);
  if (!loc) return null;
  const slot = slotFor(loc);
  const pos = ghostPos(loc);
  const h = { slot, pos };
  if (withTip) {
    const c = CLEFS[clefOf(slot.st)], d = pos + c.bottom, p = fromDiatonic(d);
    const name = pitchName({ ...p, alter: keyAlter(tune().key, p.step) });
    const dur = activeDurForGhost();
    const moved = slot.free ? 0 : M.staffEvents(store.tune, slot.st).slice(slot.index).filter(e => !e.rest).length;
    h.tip = { text: `Insert ${name} · ${DUR_NAME[dur]}`, sub: slot.free ? 'earlier beats fill with rests' : moved ? `pushes ${moved} note${moved > 1 ? 's' : ''} later` : 'at the end' };
  }
  return h;
}

function placeNote(h, dur) {
  const st = h.slot.st, view = M.staffView(store.tune, st);
  const c = CLEFS[view.clef], p = fromDiatonic(h.pos + c.bottom);
  const n = { ...p, alter: keyAlter(view.key, p.step), dur };
  stopPlayback();
  if (h.slot.free) {
    const r = M.insertAtTick(view, h.slot.tick, n);
    if (!r.error) apply(r, { type: 'note', index: r.tune.events.length - 1 }, n, st); else warnFull();
  } else apply(M.insert(view, h.slot.index, n), { type: 'note', index: h.slot.index }, n, st);
  paintOverlay();
}

card.addEventListener('pointermove', ev => {
  if (drag) return;
  if (ev.pointerType !== 'mouse' || !lay) return;
  const { x, y } = svgPoint(ev);
  if (lay.geo.hitEvent(x, y)) { if (hover) { hover = null; paintOverlay(); } return; }
  hover = hoverAt(ev, false);
  paintOverlay();
});
card.addEventListener('pointerleave', () => { if (!drag && hover) { hover = null; paintOverlay(); } });

card.addEventListener('pointerdown', ev => {
  if (ev.button !== 0 || !lay) return;
  card.focus({ preventScroll: true });
  const { x, y } = svgPoint(ev);
  const hit = lay.geo.hitEvent(x, y);
  // Shift-click in the selected note's column adds a chord tone at that pitch.
  const sel = selected();
  if (ev.shiftKey && sel && !sel.rest && (!hit || hit.s !== staffIdx() || hit.ev !== selIndex())) {
    const span = lay.geo.eventSpan(selIndex(), staffIdx()), loc = lay.geo.locate(x, y);
    if (span && loc && loc.k === span.k && loc.s === staffIdx() && x >= span.x1 && x <= span.x2) {
      const c = CLEFS[tune().clef], d = clampDiatonic(tune().clef, loc.pos + c.bottom), p = fromDiatonic(d);
      edit(() => addTone({ ...p, alter: keyAlter(tune().key, p.step) }))();
      ev.preventDefault();
      return;
    }
  }
  if (hit) {
    stopPlayback();
    select(hit.ev, hit.tone, hit.s);
    const e = tune().events[hit.ev];
    if (!e.rest) {
      const d0 = diatonic(M.pitchesOf(e)[hit.tone]);
      drag = { kind: 'pitch', id: ev.pointerId, index: hit.ev, tone: hit.tone, startY: y, original: store.tune, startD: d0, lastD: d0 };
    }
  } else {
    hover = hoverAt(ev, false);
    if (!hover) { store.setCursor({ type: 'caret', index: tune().events.length }); return; }
    drag = { kind: 'place', id: ev.pointerId };
    paintOverlay();
  }
  card.setPointerCapture(ev.pointerId);
  ev.preventDefault();
});

card.addEventListener('pointermove', ev => {
  if (!drag || drag.id !== ev.pointerId) return;
  if (drag.kind === 'place') { const h = hoverAt(ev, false); if (h) { hover = h; paintOverlay(); } return; }
  if (drag.kind === 'pitch') {
    const { y } = svgPoint(ev);
    const steps = Math.round((drag.startY - y) / (lay.sp / 2));
    const d = clampDiatonic(tune().clef, drag.startD + steps);
    if (d === drag.lastD) return;
    drag.lastD = d; drag.moved = true;
    const p = { ...fromDiatonic(d), alter: keyAlter(tune().key, fromDiatonic(d).step) };
    const r = M.setTonePitch(tune(), drag.index, drag.tone, p);
    if (r.error) return;                       // would land on another chord note: skip that position
    store.tune = M.withStaffView(store.tune, staffIdx(), r.tune);
    render();
    if (previewOn) preview(p);
  }
});

function endDrag(ev) {
  if (!drag || drag.id !== ev.pointerId) return;
  const d = drag; drag = null;
  if (d.kind === 'place') {
    const h = hover; hover = null;
    if (h && overStaff(ev)) placeNote(h, inputDur); else paintOverlay();
  } else if (d.kind === 'pitch' && d.moved) {
    const final = store.tune;
    store.tune = d.original;
    store.commit(final);
  }
}
card.addEventListener('pointerup', endDrag);
card.addEventListener('pointercancel', ev => { if (drag && drag.id === ev.pointerId) cancelDrag(); });

function cancelDrag() {
  const d = drag; drag = null; hover = null;
  if (!d) return;
  if (d.kind === 'pitch' && d.moved) { store.tune = d.original; render(); }
  if (d.kind === 'chip') d.el?.remove();
  paintOverlay();
}

// ---------- pointer: duration chips (click or drag onto the staff) ----------
document.querySelectorAll('[data-dur]').forEach(btn => {
  btn.addEventListener('pointerdown', ev => {
    if (ev.button !== 0) return;
    const base = +btn.dataset.dur;
    drag = { kind: 'chip', id: ev.pointerId, base, dur: base, x0: ev.clientX, y0: ev.clientY, started: false, btn };
    btn.setPointerCapture(ev.pointerId);
  });
  btn.addEventListener('pointermove', ev => {
    if (!drag || drag.kind !== 'chip' || drag.id !== ev.pointerId) return;
    if (!drag.started) {
      if (Math.hypot(ev.clientX - drag.x0, ev.clientY - drag.y0) < 6) return;
      drag.started = true;
      const sel = selected();
      drag.dur = sel ? drag.base : (inputDur >= 5 && canDot(drag.base) ? drag.base + 4 : drag.base);
      drag.el = document.createElement('div');
      drag.el.className = 'drag-chip';
      drag.el.innerHTML = btn.querySelector('.mg').outerHTML;
      document.body.appendChild(drag.el);
    }
    drag.el.style.left = ev.clientX + 'px'; drag.el.style.top = ev.clientY + 'px';
    hover = overStaff(ev) ? hoverAt(ev, true) : null;
    paintOverlay();
  });
  btn.addEventListener('pointerup', ev => {
    if (!drag || drag.kind !== 'chip' || drag.id !== ev.pointerId) return;
    const d = drag; drag = null;
    if (!d.started) { edit(() => setDur(d.base))(); return; }
    d.el.remove();
    const h = hover; hover = null;
    if (h && overStaff(ev)) placeNote(h, d.dur);
    else paintOverlay();
  });
  btn.addEventListener('pointercancel', () => { if (drag && drag.kind === 'chip') cancelDrag(); });
});

// ---------- toolbar buttons ----------
$('dot').onclick = edit(toggleDotted);
$('rest').onclick = edit(typeRest);
document.querySelectorAll('[data-alter]').forEach(b => { b.onclick = edit(() => setAlter(+b.dataset.alter)); });
$('octUp').onclick = edit(() => movePitch(7));
$('octDown').onclick = edit(() => movePitch(-7));
$('del').onclick = edit(deleteSel);
$('undo').onclick = $('undoSm').onclick = edit(() => store.undo());
$('redo').onclick = edit(() => store.redo());
// Keep focus on the staff after toolbar clicks so keyboard entry continues.
$('noteBar').addEventListener('click', () => card.focus({ preventScroll: true }));

// ---------- tune settings ----------
const setField = patch => { stopPlayback(); apply({ tune: { ...tune(), ...patch } }); };
$('play').onclick = togglePlay;
$('loop').onclick = () => { loopOn = !loopOn; syncPlay(); };
$('preview').onclick = () => { previewOn = !previewOn; syncPlay(); };
$('key').innerHTML = KEY_NAMES.map((_, i) => `<option value="${i - 7}">${keyLabel(i - 7)}</option>`).join('');
$('key').onchange = e => setField({ key: +e.target.value });
$('clefT').onclick = () => tune().clef !== 'treble' && setField({ clef: 'treble' });
$('clefB').onclick = () => tune().clef !== 'bass' && setField({ clef: 'bass' });
$('staves1').onclick = () => { stopPlayback(); setStaves(1); };
$('staves2').onclick = () => { stopPlayback(); setStaves(2); };
$('time').onchange = e => {
  stopPlayback();
  const r = M.setTime(store.tune, e.target.value);
  if (r.error) { toast({ kind: 'warn', title: "The tune doesn't fit", body: `It needs more than ${M.MAX_MEASURES} measures in ${e.target.value}.` }); sync(); return; }
  applyWhole(r);
  if (r.expanded) toast({ title: `Expanded to ${r.expanded} measures to fit` });
};
$('mUp').onclick = () => { stopPlayback(); setMeasures(tune().measures + 1); };
$('mDown').onclick = () => { stopPlayback(); setMeasures(tune().measures - 1); };
const setBpm = v => { const b = Math.max(40, Math.min(240, Math.round(v) || 100)); if (b !== tune().bpm) setField({ bpm: b }); else sync(); };
$('bpm').onchange = e => setBpm(+e.target.value);
$('bpm').onkeydown = e => { if (e.key === 'Enter') e.target.blur(); };
$('bpmDown').onclick = e => setBpm(tune().bpm - (e.shiftKey ? 1 : 5));
$('bpmUp').onclick = e => setBpm(tune().bpm + (e.shiftKey ? 1 : 5));
$('title').onchange = e => { const v = e.target.value.slice(0, 60); if (v !== tune().title) setField({ title: v }); };
$('title').onkeydown = e => {
  if (e.key === 'Enter') e.target.blur();
  if (e.key === 'Escape') { e.target.value = tune().title; e.target.blur(); }
};
$('settingsToggle').onclick = () => {
  const bar = document.querySelector('.tune-bar'), open = !bar.classList.contains('open');
  bar.classList.toggle('open', open);
  $('settingsToggle').setAttribute('aria-expanded', open);
};

// New tune (with confirmation popover)
$('new').onclick = () => { $('newPop').hidden = !$('newPop').hidden; };
$('newCancel').onclick = () => { $('newPop').hidden = true; };
$('newOk').onclick = () => {
  $('newPop').hidden = true;
  stopPlayback();
  store.commit(M.defaultTune(), { type: 'caret', index: 0, staff: 0 });
};
document.addEventListener('pointerdown', e => {
  if (!$('newPop').hidden && !e.target.closest('.pop-wrap')) $('newPop').hidden = true;
});

// Copy / share link
$('copy').onclick = async () => {
  store.flushUrl();
  const url = location.href;
  if (matchMedia('(max-width: 599px)').matches && navigator.share) {
    try { await navigator.share({ title: tune().title || 'TuneShare', url }); return; } catch (err) { if (err.name === 'AbortError') return; }
  }
  try { await navigator.clipboard.writeText(url); toast({ title: 'Link copied', body: `${url.length} characters` }); }
  catch { window.prompt('Copy this link:', url); }
};

// Shortcut sheet
function openSheet() { $('sheet').hidden = false; $('sheetClose').focus(); }
function closeSheet() { $('sheet').hidden = true; card.focus({ preventScroll: true }); }
$('help').onclick = openSheet;
$('theme').onclick = toggleTheme;
$('sheetClose').onclick = closeSheet;
$('sheet').onclick = e => { if (e.target === $('sheet')) closeSheet(); };

// Debug overlay (Ctrl+D): live dump of the protobuf behind the URL
function paintDebug() { $('debugDump').textContent = dumpFragment('#' + encode(tune())); }
function openDebug() { closeSheet(); paintDebug(); $('debug').hidden = false; $('debugDump').focus(); }
function closeDebug() { $('debug').hidden = true; card.focus({ preventScroll: true }); }
function toggleDebug() { $('debug').hidden ? openDebug() : closeDebug(); }
$('debugClose').onclick = closeDebug;
$('debug').onclick = e => { if (e.target === $('debug')) closeDebug(); };
$('debugCopy').onclick = async () => {
  try { await navigator.clipboard.writeText($('debugDump').textContent); toast({ title: 'Debug dump copied' }); }
  catch { window.prompt('Copy the dump:', $('debugDump').textContent); }
};

// ---------- store + URL wiring ----------
store.subscribe(change => {
  if (change === 'tune' && !$('debug').hidden) paintDebug();
  if (change === 'tune') render();
  else { paintClasses(); paintOverlay(); sync(); }
});
// Warn once when a link grows past what chat apps, email and QR codes handle reliably.
const LONG_LINK = 2000;
let warnedLong = false;
store.onUrl = len => {
  if (len > LONG_LINK && !warnedLong) toast({ kind: 'warn', title: 'This link is getting long', body: `${len} characters — some apps may cut it off.` });
  warnedLong = len > LONG_LINK;
};
addEventListener('hashchange', () => {
  if (location.hash === store.lastHash) return;
  stopPlayback();
  const r = decode(location.hash);
  store.lastHash = location.hash;
  store.load(r.tune);
  if (r.repaired) toast({ kind: 'warn', title: 'This link was damaged', body: 'Some notes may be missing.' });
});
let resizeRaf = 0;
addEventListener('resize', () => { cancelAnimationFrame(resizeRaf); resizeRaf = requestAnimationFrame(render); });

// ---------- start ----------
document.fonts.ready.then(render);
render();
if (initial.newer) toast({ kind: 'warn', title: 'Made with a newer TuneShare', body: 'Some features of this tune may not display.' });
else if (initial.repaired) toast({ kind: 'warn', title: 'This link was damaged', body: 'Some notes may be missing.' });
card.focus({ preventScroll: true });
