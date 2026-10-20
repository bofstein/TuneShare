// Keyboard shortcut dispatcher.
import * as M from './model.js';
import { selectedEvent } from './editor.js';

/**
 * Initialize global keyboard shortcuts for notation editing, navigation, and playback.
 */
export function initKeyboard({
  onDebug,
  isDebugOpen,
  closeDebug,
  isSheetOpen,
  closeSheet,
  openSheet,
  isDragging,
  cancelDrag,
  onUndo,
  onRedo,
  onMovePitch,
  onMoveHalfStep,
  onTypeLetter,
  onAddToneLetter,
  onCycleTone,
  onTypeRest,
  onSetDur,
  onToggleDotted,
  onSwitchStaff,
  onSetAlter,
  onSwapSel,
  onMoveCursor,
  onExtendSel,
  onCopy,
  onCut,
  onPaste,
  onSelectAll,
  onDeleteSel,
  onHome,
  onEnd,
  onEscape,
  onTogglePlay,
  onToggleLoop,
  cardEl,
  getTune,
  getCursor,
}) {
  document.addEventListener('keydown', e => {
    const t = e.target;
    // Ctrl+D works everywhere (even in text fields) and overrides browser bookmark
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'd') {
      onDebug();
      e.preventDefault();
      return;
    }
    if (isDebugOpen()) {
      if (e.key === 'Escape') { closeDebug(); e.preventDefault(); }
      return;
    }
    if (t.closest && t.closest('input, select, textarea')) return;
    if (isSheetOpen()) {
      if (e.key === 'Escape' || e.key === '?') closeSheet();
      return;
    }
    if (isDragging() && e.key === 'Escape') {
      cancelDrag();
      e.preventDefault();
      return;
    }

    const mod = e.ctrlKey || e.metaKey;
    if (mod) {
      const k = e.key.toLowerCase();
      if (k === 'z' && !e.shiftKey) { onUndo(); e.preventDefault(); }
      else if ((k === 'z' && e.shiftKey) || k === 'y') { onRedo(); e.preventDefault(); }
      else if (k === 'c' && !e.shiftKey && !e.altKey) { if (onCopy()) e.preventDefault(); }
      else if (k === 'x' && !e.shiftKey && !e.altKey) { if (onCut()) e.preventDefault(); }
      else if (k === 'v' && !e.shiftKey && !e.altKey) { if (onPaste()) e.preventDefault(); }
      else if (k === 'a' && !e.shiftKey && !e.altKey) { onSelectAll(); e.preventDefault(); }
      else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.altKey) {
        const dir = e.key === 'ArrowUp' ? 1 : -1;
        onMovePitch(e.shiftKey ? 7 * dir : dir);
        e.preventDefault();
      }
      return;
    }

    const key = e.key;
    let handled = true;
    const sel = selectedEvent(getTune(), getCursor());

    if (/^[a-g]$/i.test(key) && !e.altKey) {
      const step = 'CDEFGAB'.indexOf(key.toUpperCase());
      if (e.shiftKey) onAddToneLetter(step);
      else onTypeLetter(step);
    } else if (key === 'Tab' && sel && !sel.rest && M.pitchesOf(sel).length > 1) {
      onCycleTone(e.shiftKey ? -1 : 1);
    } else if (key === 'r' || key === 'R') {
      onTypeRest();
    } else if (/^[1-5]$/.test(key)) {
      onSetDur([4, 3, 2, 1, 0][+key - 1]);
    } else if (key === '.') {
      onToggleDotted();
    } else if ((key === 'ArrowUp' || key === 'ArrowDown') && e.altKey) {
      onSwitchStaff(key === 'ArrowUp' ? -1 : 1);
    } else if (key === 'ArrowUp') {
      if (e.shiftKey) onMovePitch(7); else onMoveHalfStep(1);
    } else if (key === 'ArrowDown') {
      if (e.shiftKey) onMovePitch(-7); else onMoveHalfStep(-1);
    } else if (key === '#' || key === '+') {
      onSetAlter(1);
    } else if (key === '-' || key === '_') {
      onSetAlter(-1);
    } else if (key === '=' || key === 'n' || key === 'N') {
      onSetAlter(0);
    } else if (key === 'ArrowLeft') {
      if (e.altKey) onSwapSel(-1); else if (e.shiftKey) onExtendSel(-1); else onMoveCursor(-1);
    } else if (key === 'ArrowRight') {
      if (e.altKey) onSwapSel(1); else if (e.shiftKey) onExtendSel(1); else onMoveCursor(1);
    } else if (key === 'Home') {
      onHome();
    } else if (key === 'End') {
      onEnd();
    } else if (key === 'Backspace' || key === 'Delete') {
      onDeleteSel();
    } else if (key === 'Escape') {
      onEscape();
    } else if (key === ' ') {
      if (t.closest && t.closest('button') && t !== cardEl) return;
      onTogglePlay();
    } else if (key === 'l' || key === 'L') {
      onToggleLoop();
    } else if (key === '?') {
      openSheet();
    } else {
      handled = false;
    }

    if (handled) e.preventDefault();
  });
}
