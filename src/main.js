// App controller: orchestrates the store, rendering pipeline, input, toolbar, and playback.
import {
  CLEFS,
  DUR_TICKS,
  KEY_NAMES,
  canDot,
  fromDiatonic,
  keyAlter,
  keyLabel,
  tempoWord,
  undotted,
} from './theory.js';
import * as M from './model.js';
import { VERSION, decode } from './codec.js';
import { layout } from './layout.js';
import { OVERLAY, renderOverlay, renderSystems } from './render.js';
import { Player, preview, setInstrument, warmTune } from './audio.js';
import { DEFAULT_INSTRUMENT, INSTRUMENTS } from './instruments.js';
import { Store } from './store.js';
import { toggleTheme } from './theme.js';

// Modular functional units
import {
  activeDur as getActiveDur,
  addToneLetter,
  cycleTone,
  deleteSel,
  moveCursor,
  moveHalfStep,
  movePitch,
  selectedEvent,
  selectedIndex,
  selectedPitch,
  selectedTone,
  setAlter,
  setDuration,
  staffIdx,
  staffView,
  swapSel,
  switchStaff,
  toggleDotted,
  twoStaves,
  typeLetter,
  typeRest,
} from './editor.js';
import { formatAriaLabel, formatHint, formatReadout, formatSettingsSummary } from './ui-format.js';
import { ERRORS, setToastContainer, showError, toast, warnFull } from './toast.js';
import { copyLink, exportMusicXml, initDebugModal, initNewPopover, initShortcutSheet } from './dialogs.js';
import { initGestures } from './gestures.js';
import { initKeyboard } from './keyboard.js';

const $ = id => document.getElementById(id);
const host = $('staffHost'), card = $('staffCard');

// ---------- state ----------
setToastContainer($('toasts'));
const initial = decode(location.hash);
const store = new Store(initial.tune);
store.lastHash = location.hash;
if (initial.version < VERSION && !initial.repaired) store.flushUrl();

const player = new Player();
let inputDur = 2;               // duration for next note; follows selected note's length
let previewOn = true, loopOn = false;
let playing = [];               // "staff:index" keys of events sounding now
let lay = null;

// ---------- helpers ----------
const tune = () => staffView(store.tune, store.cursor);
const selIndex = () => selectedIndex(store.cursor);
const selected = () => selectedEvent(store.tune, store.cursor);
const activeDur = () => getActiveDur(store.tune, store.cursor, inputDur);
const edit = fn => () => { stopPlayback(); fn(); };

// ---------- edits & commits ----------
function apply(result, cursor, sound, s = staffIdx(store.cursor)) {
  if (result.error) return showError(result, tune(), setMeasures);
  applyWhole({ tune: M.withStaffView(store.tune, s, result.tune) }, cursor && { ...cursor, staff: s }, sound);
  return true;
}

function applyWhole(result, cursor, sound) {
  if (result.error) return showError(result, tune(), setMeasures);
  store.commit(result.tune, cursor);
  if (sound && previewOn && !sound.rest) preview(...M.pitchesOf(sound));
  return true;
}

function applyOp(op) {
  if (!op) return;
  if (op.inputDur !== undefined) { inputDur = op.inputDur; sync(); return; }
  if (op.result) apply(op.result, op.cursor, op.sound, op.staff);
}

function select(i, tone = 0, staff = staffIdx(store.cursor)) {
  store.setCursor({ type: 'note', index: i, tone, staff });
  const e = staffView(store.tune, staff).events[i];
  if (e && !e.rest && previewOn && !player.playing) preview(...M.pitchesOf(e));
}

function setMeasures(n) {
  const r = M.setMeasures(store.tune, n);
  if (r.error) {
    toast({ kind: 'warn', title: `Measure ${tune().measures} isn't empty`, body: 'Delete its notes first.', ms: 4000 });
    return;
  }
  applyWhole(r);
}

function setStaves(n) {
  if (n === M.staffCount(store.tune)) return;
  if (n === 2) { applyWhole(M.addStaff(store.tune), { type: 'caret', index: 0, staff: 1 }); return; }
  const r = M.removeStaff(store.tune, 1);
  if (r.error !== 'staff-not-empty') { applyWhole(r, { type: 'caret', index: store.tune.events.length, staff: 0 }); return; }
  toast({
    kind: 'warn', title: ERRORS[r.error][0], body: ERRORS[r.error][1], ms: 6000,
    action: 'Delete lower staff notes',
    onAction: () => applyWhole(M.removeStaff(store.tune, 1, true), { type: 'caret', index: store.tune.events.length, staff: 0 }),
  });
}

// ---------- playback ----------
function togglePlay() {
  if (player.playing) { stopPlayback(); return; }
  const s = staffIdx(store.cursor);
  const from = selIndex() >= 0 && lay ? lay.geo.staves[s].starts[selIndex()] : 0;
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
let shown = null;
function paintStaff({ open, systems }) {
  if (shown && shown.open === open && shown.systems.length === systems.length) {
    const gs = host.querySelectorAll('g.sys');
    systems.forEach((markup, k) => { if (markup !== shown.systems[k]) gs[k].outerHTML = markup; });
  } else host.innerHTML = open + systems.join('') + OVERLAY + '</svg>';
  shown = { open, systems };
}

function render() {
  const w = Math.max(280, host.clientWidth);
  const perSys = w >= 860 ? 4 : w >= 560 ? 3 : 2;
  const sp = w >= 560 ? 10 : 8;
  lay = layout(store.tune, { width: w, perSys, sp });
  paintStaff(renderSystems(lay));
  paintClasses();
  paintOverlay();
  sync();
}

function paintClasses() {
  host.querySelectorAll('.ev').forEach(g => {
    const i = +g.dataset.i, sel = +g.dataset.s === staffIdx(store.cursor) && i === selIndex();
    g.classList.toggle('sel', sel);
    g.classList.toggle('play', playing.includes(`${g.dataset.s}:${i}`));
    g.querySelectorAll('.halo').forEach(h => h.classList.toggle('on', sel && +h.dataset.tone === selectedTone(store.tune, store.cursor)));
  });
}

function paintOverlay() {
  const ov = host.querySelector('.overlay');
  if (!ov || !lay) return;
  const { chordHover, hover, activeDurForGhost } = gestures.getOverlayState();
  const o = {};
  const hw = 1.18 * lay.sp;
  if (chordHover) {
    o.ghost = { k: chordHover.k, s: chordHover.st, x: chordHover.x, pos: chordHover.pos, ticks: DUR_TICKS[chordHover.dur] };
  } else if (hover) {
    const { slot, pos, tip, rest } = hover;
    o.marker = slot.free ? null : { k: slot.k, s: slot.st, x: slot.x };
    o.ghost = { k: slot.k, s: slot.st, x: slot.free ? slot.x : slot.x - hw / 2, pos, ticks: DUR_TICKS[activeDurForGhost()], rest };
    if (tip) o.tip = tip;
  }
  ov.innerHTML = renderOverlay(lay, o);
}

// ---------- dialogs & modals ----------
const sheet = initShortcutSheet({ sheetEl: $('sheet'), closeBtn: $('sheetClose'), openBtn: $('help'), cardEl: card });
const debug = initDebugModal({
  debugEl: $('debug'), dumpEl: $('debugDump'), closeBtn: $('debugClose'), copyBtn: $('debugCopy'),
  cardEl: card, getTune: () => store.tune, closeSheet: sheet.closeSheet, toast,
});
initNewPopover({
  newBtn: $('new'), popEl: $('newPop'), cancelBtn: $('newCancel'), okBtn: $('newOk'),
  onConfirm: () => { stopPlayback(); store.commit(M.defaultTune(), { type: 'caret', index: 0, staff: 0 }); },
});
$('copy').onclick = () => copyLink({ getTune: () => store.tune, onFlushUrl: () => store.flushUrl(), toast });
$('exportXml').onclick = () => exportMusicXml(store.tune);
$('theme').onclick = toggleTheme;

// ---------- gestures & pointer ----------
const gestures = initGestures({
  card,
  host,
  durButtons: document.querySelectorAll('[data-dur]'),
  getTune: () => store.tune,
  getCursor: () => store.cursor,
  getLay: () => lay,
  getInputDur: () => inputDur,
  onSelect: select,
  onEdit: opFn => edit(() => applyOp(opFn()))(),
  onPlaceNote: (h, dur) => {
    const st = h.slot.st, view = M.staffView(store.tune, st);
    const c = CLEFS[view.clef], p = fromDiatonic(h.pos + c.bottom);
    const n = { ...p, alter: keyAlter(view.key, p.step), dur };
    stopPlayback();
    if (h.slot.free) {
      const r = M.insertAtTick(view, h.slot.tick, n);
      if (!r.error) apply(r, { type: 'note', index: r.tune.events.length - 1 }, n, st);
      else warnFull(tune(), setMeasures);
    } else apply(M.insert(view, h.slot.index, n), { type: 'note', index: h.slot.index }, n, st);
    paintOverlay();
  },
  onCommitTune: final => store.commit(final),
  onSetTune: t => { store.tune = t; },
  onSetCursor: c => store.setCursor(c),
  onPreview: p => preview(p),
  onRender: render,
  onPaintOverlay: paintOverlay,
  onSetDur: base => edit(() => applyOp(setDuration(store.tune, store.cursor, base)))(),
  isPreviewOn: () => previewOn,
  isPlaying: () => player.playing,
  stopPlayback,
});

// ---------- keyboard ----------
initKeyboard({
  onDebug: debug.toggleDebug,
  isDebugOpen: debug.isOpen,
  closeDebug: debug.closeDebug,
  isSheetOpen: sheet.isOpen,
  closeSheet: sheet.closeSheet,
  openSheet: sheet.openSheet,
  isDragging: gestures.isDragging,
  cancelDrag: gestures.cancelDrag,
  onUndo: () => { stopPlayback(); store.undo(); },
  onRedo: () => { stopPlayback(); store.redo(); },
  onMovePitch: steps => edit(() => applyOp(movePitch(store.tune, store.cursor, steps)))(),
  onMoveHalfStep: dir => edit(() => applyOp(moveHalfStep(store.tune, store.cursor, dir)))(),
  onTypeLetter: step => edit(() => applyOp(typeLetter(store.tune, store.cursor, step, activeDur())))(),
  onAddToneLetter: step => edit(() => applyOp(addToneLetter(store.tune, store.cursor, step, activeDur())))(),
  onCycleTone: dir => {
    const e = selected();
    if (!e || e.rest) return;
    const ps = M.pitchesOf(e);
    const tone = cycleTone(ps, selectedTone(store.tune, store.cursor), dir);
    store.setCursor({ ...store.cursor, tone });
    if (previewOn && !player.playing) preview(ps[tone]);
  },
  onTypeRest: () => edit(() => applyOp(typeRest(store.tune, store.cursor, activeDur())))(),
  onSetDur: base => edit(() => applyOp(setDuration(store.tune, store.cursor, base)))(),
  onToggleDotted: () => edit(() => applyOp(toggleDotted(store.tune, store.cursor, inputDur)))(),
  onSwitchStaff: dir => {
    if (!lay) return;
    const next = switchStaff(store.cursor, lay.geo.staves, M.staffCount(store.tune), dir);
    store.setCursor(next);
  },
  onSetAlter: alter => edit(() => applyOp(setAlter(store.tune, store.cursor, alter)))(),
  onSwapSel: dir => edit(() => applyOp(swapSel(store.tune, store.cursor, dir)))(),
  onMoveCursor: dir => {
    const s = staffIdx(store.cursor);
    const next = moveCursor(store.cursor, staffView(store.tune, s).events.length, dir);
    if (next.type === 'note') {
      store.setCursor(next);
      const e = tune().events[next.index];
      if (e && !e.rest && previewOn && !player.playing) preview(...M.pitchesOf(e));
    } else store.setCursor(next);
  },
  onDeleteSel: () => edit(() => applyOp(deleteSel(store.tune, store.cursor)))(),
  onHome: () => store.setCursor({ type: 'caret', index: 0, staff: staffIdx(store.cursor) }),
  onEnd: () => store.setCursor({ type: 'caret', index: tune().events.length, staff: staffIdx(store.cursor) }),
  onEscape: () => { if (selIndex() >= 0) store.setCursor({ type: 'caret', index: selIndex() + 1, staff: staffIdx(store.cursor) }); },
  onTogglePlay: togglePlay,
  onToggleLoop: () => { loopOn = !loopOn; syncPlay(); },
  cardEl: card,
  getTune: () => store.tune,
  getCursor: () => store.cursor,
});

// ---------- toolbar & settings sync ----------
function sync() {
  const t = tune(), sel = selected();
  if (sel) inputDur = sel.dur;
  const dur = activeDur(), base = undotted(dur);
  document.querySelectorAll('[data-dur]').forEach(b => b.classList.toggle('on', +b.dataset.dur === base));
  $('dot').classList.toggle('on', dur >= 5);
  $('dot').disabled = !canDot(dur) && dur < 5;
  $('rest').classList.toggle('on', !!(sel && sel.rest));
  const isNote = !!(sel && !sel.rest), sp = selectedPitch(store.tune, store.cursor);
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
  const readoutInfo = formatReadout(store.tune, store.cursor, lay, inputDur);
  ro.className = readoutInfo.isIdle ? 'readout idle' : 'readout';
  ro.innerHTML = `<span>${readoutInfo.textHtml}</span><span class="sub">${readoutInfo.subText}</span>`;

  $('hint').innerHTML = formatHint(sel);
  $('emptyHint').hidden = store.tune.events.length > 0 || twoStaves(store.tune);

  if (document.activeElement !== $('title')) $('title').value = t.title;
  if (document.activeElement !== $('bpm')) $('bpm').value = t.bpm;
  $('tempoWord').textContent = tempoWord(t.bpm);
  $('key').value = String(t.key);
  $('clefT').classList.toggle('on', t.clef === 'treble');
  $('clefB').classList.toggle('on', t.clef === 'bass');
  $('clefLbl').textContent = twoStaves(store.tune) ? `Clef (${staffIdx(store.cursor) ? 'lower' : 'upper'})` : 'Clef';
  $('staves1').classList.toggle('on', !twoStaves(store.tune));
  $('staves2').classList.toggle('on', twoStaves(store.tune));
  $('time').value = t.time;
  $('instrument').value = t.instrument || DEFAULT_INSTRUMENT;
  setInstrument(t.instrument || DEFAULT_INSTRUMENT);
  warmTune(store.tune);
  $('measures').textContent = t.measures;
  $('mUp').disabled = t.measures >= M.MAX_MEASURES;
  $('mDown').disabled = t.measures <= 1;
  $('settingsSummary').innerHTML = formatSettingsSummary(store.tune);
  document.title = t.title ? `${t.title} — TuneShare` : 'TuneShare';
  card.setAttribute('aria-label', formatAriaLabel(store.tune, store.cursor));
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

// ---------- toolbar & tune settings events ----------
$('dot').onclick = edit(() => applyOp(toggleDotted(store.tune, store.cursor, inputDur)));
$('rest').onclick = edit(() => applyOp(typeRest(store.tune, store.cursor, activeDur())));
document.querySelectorAll('[data-alter]').forEach(b => {
  b.onclick = edit(() => applyOp(setAlter(store.tune, store.cursor, +b.dataset.alter)));
});
$('octUp').onclick = edit(() => applyOp(movePitch(store.tune, store.cursor, 7)));
$('octDown').onclick = edit(() => applyOp(movePitch(store.tune, store.cursor, -7)));
$('del').onclick = edit(() => applyOp(deleteSel(store.tune, store.cursor)));
$('undo').onclick = $('undoSm').onclick = edit(() => store.undo());
$('redo').onclick = edit(() => store.redo());
$('noteBar').addEventListener('click', () => card.focus({ preventScroll: true }));

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
$('instrument').innerHTML = INSTRUMENTS.map(x => `<option value="${x.id}">${x.name}${x.id === DEFAULT_INSTRUMENT ? ' (default)' : ''}</option>`).join('');
$('instrument').onchange = e => {
  const id = e.target.value;
  setField({ instrument: id === DEFAULT_INSTRUMENT ? undefined : id });
  setInstrument(id);
  if (previewOn) preview({ step: 0, oct: 4, alter: 0 }, { step: 2, oct: 4, alter: 0 }, { step: 4, oct: 4, alter: 0 });
};
$('time').onchange = e => {
  stopPlayback();
  const r = M.setTime(store.tune, e.target.value);
  if (r.error) {
    toast({ kind: 'warn', title: "The tune doesn't fit", body: `It needs more than ${M.MAX_MEASURES} measures in ${e.target.value}.` });
    sync();
    return;
  }
  applyWhole(r);
  if (r.expanded) toast({ title: `Expanded to ${r.expanded} measures to fit` });
};
$('mUp').onclick = () => { stopPlayback(); setMeasures(tune().measures + 1); };
$('mDown').onclick = () => { stopPlayback(); setMeasures(tune().measures - 1); };

const setBpm = v => {
  const b = Math.max(40, Math.min(240, Math.round(v) || 100));
  if (b !== tune().bpm) setField({ bpm: b }); else sync();
};
$('bpm').onchange = e => setBpm(+e.target.value);
$('bpm').onkeydown = e => { if (e.key === 'Enter') e.target.blur(); };
$('bpmDown').onclick = e => setBpm(tune().bpm - (e.shiftKey ? 1 : 5));
$('bpmUp').onclick = e => setBpm(tune().bpm + (e.shiftKey ? 1 : 5));
$('title').onchange = e => {
  const v = e.target.value.slice(0, 60);
  if (v !== tune().title) setField({ title: v });
};
$('title').onkeydown = e => {
  if (e.key === 'Enter') e.target.blur();
  if (e.key === 'Escape') { e.target.value = tune().title; e.target.blur(); }
};
$('settingsToggle').onclick = () => {
  const bar = document.querySelector('.tune-bar'), open = !bar.classList.contains('open');
  bar.classList.toggle('open', open);
  $('settingsToggle').setAttribute('aria-expanded', open);
};

// ---------- store + URL wiring ----------
store.subscribe(change => {
  if (change === 'tune' && debug.isOpen()) debug.paintDebug();
  if (change === 'tune') render();
  else { paintClasses(); paintOverlay(); sync(); }
});

const LONG_LINK = 2000;
let warnedLong = false;
store.onUrl = len => {
  if (len > LONG_LINK && !warnedLong) {
    toast({ kind: 'warn', title: 'This link is getting long', body: `${len} characters — some apps may cut it off.` });
  }
  warnedLong = len > LONG_LINK;
};

function newerLink(version) {
  let tried = true;
  try {
    tried = sessionStorage.getItem('reloadedFor') === String(version);
    if (!tried) sessionStorage.setItem('reloadedFor', String(version));
  } catch { /* storage blocked */ }
  if (!tried) { location.reload(); return; }
  toast({
    kind: 'warn', title: 'Made with a newer TuneShare',
    body: 'Reload to get the latest version. Some features of this tune may not display until you do.',
    action: 'Reload', onAction: () => location.reload(), ms: 15000,
  });
}

addEventListener('hashchange', () => {
  if (location.hash === store.lastHash) return;
  stopPlayback();
  const r = decode(location.hash);
  store.lastHash = location.hash;
  store.load(r.tune);
  if (r.newer) newerLink(r.version);
  else if (r.repaired) toast({ kind: 'warn', title: 'This link was damaged', body: 'Some notes may be missing.' });
});

let resizeRaf = 0;
addEventListener('resize', () => { cancelAnimationFrame(resizeRaf); resizeRaf = requestAnimationFrame(render); });

// ---------- start ----------
document.fonts.ready.then(render);
render();
if (initial.newer) newerLink(initial.version);
else if (initial.repaired) toast({ kind: 'warn', title: 'This link was damaged', body: 'Some notes may be missing.' });
card.focus({ preventScroll: true });
