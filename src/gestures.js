// Pointer events and drag interactions on the staff and duration chips.
import { CLEFS, canDot, clampDiatonic, diatonic, fromDiatonic, keyAlter } from './theory.js';
import * as M from './model.js';
import { chordTargetAt, ghostPos, slotFor } from './position.js';
import { formatGhostTip } from './ui-format.js';
import { selectedEvent, selectedIndex, staffIdx } from './editor.js';

/**
 * Initialize pointer interactions for the staff and duration chips.
 */
export function initGestures({
  card,
  host,
  durButtons,
  getTune,
  getCursor,
  getLay,
  getInputDur,
  onSelect,
  onEdit,
  onPlaceNote,
  onCommitTune,
  onSetTune,
  onSetCursor,
  onPreview,
  onRender,
  onPaintOverlay,
  onSetDur,
  isPreviewOn,
  isPlaying,
  stopPlayback,
}) {
  let chordHover = null;
  let hover = null;
  let drag = null;

  const svgPoint = ev => {
    const svg = host.querySelector('svg');
    const r = svg ? svg.getBoundingClientRect() : { left: 0, top: 0 };
    return { x: ev.clientX - r.left, y: ev.clientY - r.top };
  };

  const overStaff = ev => {
    const r = card.getBoundingClientRect();
    return ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom;
  };

  const activeDurForGhost = () => (drag && drag.kind === 'chip' ? drag.dur : getInputDur());

  const hoverAt = (ev, withTip) => {
    const lay = getLay();
    if (!lay) return null;
    const { x, y } = svgPoint(ev);
    const yy = ev.pointerType === 'touch' ? y - 3 * lay.sp : y;
    const loc = lay.geo.locate(x, yy);
    if (!loc) return null;
    const tune = getTune();
    const slot = slotFor(loc, x, tune, lay.geo, lay.sp);
    const pos = ghostPos(loc, tune);
    const h = { slot, pos };
    if (withTip) {
      h.tip = formatGhostTip(slot, pos, tune, activeDurForGhost());
    }
    return h;
  };

  const cancelDrag = () => {
    const d = drag;
    drag = null;
    hover = null;
    if (!d) return;
    if (d.kind === 'pitch' && d.moved) {
      onSetTune(d.original);
      onRender();
    }
    if (d.kind === 'chip') d.el?.remove();
    onPaintOverlay();
  };

  // Staff pointer move (hover / ghost)
  card.addEventListener('pointermove', ev => {
    if (drag) return;
    const lay = getLay();
    if (ev.pointerType !== 'mouse' || !lay) return;
    const { x, y } = svgPoint(ev);
    if (lay.geo.hitEvent(x, y)) {
      if (hover || chordHover) { hover = chordHover = null; onPaintOverlay(); }
      return;
    }
    chordHover = chordTargetAt(x, y, getTune(), lay.geo, ev.pointerType);
    if (chordHover) { hover = null; onPaintOverlay(); return; }
    hover = hoverAt(ev, false);
    onPaintOverlay();
  });

  card.addEventListener('pointerleave', () => {
    if (!drag && (hover || chordHover)) {
      hover = chordHover = null;
      onPaintOverlay();
    }
  });

  // Staff pointerdown
  card.addEventListener('pointerdown', ev => {
    const lay = getLay();
    if (ev.button !== 0 || !lay) return;
    card.focus({ preventScroll: true });
    const { x, y } = svgPoint(ev);
    const hit = lay.geo.hitEvent(x, y);
    const tune = getTune(), cursor = getCursor(), sIdx = staffIdx(cursor);
    const sel = selectedEvent(tune, cursor);

    // Shift-click in selected note's column adds chord tone
    if (ev.shiftKey && sel && !sel.rest && (!hit || hit.s !== sIdx || hit.ev !== selectedIndex(cursor))) {
      const span = lay.geo.eventSpan(selectedIndex(cursor), sIdx), loc = lay.geo.locate(x, y);
      if (span && loc && loc.k === span.k && loc.s === sIdx && x >= span.x1 && x <= span.x2) {
        const view = M.staffView(tune, sIdx), c = CLEFS[view.clef];
        const d = clampDiatonic(view.clef, loc.pos + c.bottom), p = fromDiatonic(d);
        onEdit(() => ({
          result: M.addTone(view, selectedIndex(cursor), { ...p, alter: keyAlter(view.key, p.step) }),
          cursor: { type: 'note', index: selectedIndex(cursor), tone: M.pitchesOf(sel).length, staff: sIdx },
          sound: p,
          staff: sIdx,
        }));
        ev.preventDefault();
        return;
      }
    }

    const ct = !hit && !ev.shiftKey && chordTargetAt(x, y, tune, lay.geo, ev.pointerType);
    if (ct) {
      stopPlayback();
      onSelect(ct.ev, 0, ct.st);
      chordHover = null;
      onEdit(() => ({
        result: M.addTone(M.staffView(getTune(), ct.st), ct.ev, ct.pitch),
        cursor: { type: 'note', index: ct.ev, tone: 1, staff: ct.st },
        sound: ct.pitch,
        staff: ct.st,
      }));
      ev.preventDefault();
      return;
    }

    if (hit) {
      stopPlayback();
      onSelect(hit.ev, hit.tone, hit.s);
      const e = M.staffEvents(tune, hit.s)[hit.ev];
      if (!e.rest) {
        const d0 = diatonic(M.pitchesOf(e)[hit.tone]);
        drag = { kind: 'pitch', id: ev.pointerId, index: hit.ev, tone: hit.tone, startY: y, original: tune, startD: d0, lastD: d0 };
      }
    } else {
      hover = hoverAt(ev, false);
      if (!hover) { onSetCursor({ type: 'caret', index: M.staffEvents(tune, sIdx).length, staff: sIdx }); return; }
      drag = { kind: 'place', id: ev.pointerId };
      onPaintOverlay();
    }
    card.setPointerCapture(ev.pointerId);
    ev.preventDefault();
  });

  // Staff pointermove while dragging
  card.addEventListener('pointermove', ev => {
    if (!drag || drag.id !== ev.pointerId) return;
    if (drag.kind === 'place') {
      const h = hoverAt(ev, false);
      if (h) { hover = h; onPaintOverlay(); }
      return;
    }
    if (drag.kind === 'pitch') {
      const lay = getLay(), tune = getTune(), sIdx = staffIdx(getCursor());
      const { y } = svgPoint(ev);
      const steps = Math.round((drag.startY - y) / (lay.sp / 2));
      const view = M.staffView(tune, sIdx);
      const d = clampDiatonic(view.clef, drag.startD + steps);
      if (d === drag.lastD) return;
      drag.lastD = d;
      drag.moved = true;
      const p = { ...fromDiatonic(d), alter: keyAlter(view.key, fromDiatonic(d).step) };
      const r = M.setTonePitch(view, drag.index, drag.tone, p);
      if (r.error) return;
      onSetTune(M.withStaffView(tune, sIdx, r.tune));
      onRender();
      if (isPreviewOn()) onPreview(p);
    }
  });

  // Staff pointerup
  card.addEventListener('pointerup', ev => {
    if (!drag || drag.id !== ev.pointerId) return;
    const d = drag;
    drag = null;
    if (d.kind === 'place') {
      const h = hover;
      hover = null;
      if (h && overStaff(ev)) onPlaceNote(h, getInputDur());
      else onPaintOverlay();
    } else if (d.kind === 'pitch' && d.moved) {
      const final = getTune();
      onSetTune(d.original);
      onCommitTune(final);
    }
  });

  card.addEventListener('pointercancel', ev => {
    if (drag && drag.id === ev.pointerId) cancelDrag();
  });

  // Duration chips dragging
  durButtons.forEach(btn => {
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
        const sel = selectedEvent(getTune(), getCursor());
        const inputDur = getInputDur();
        drag.dur = sel ? drag.base : (inputDur >= 5 && canDot(drag.base) ? drag.base + 4 : drag.base);
        drag.el = document.createElement('div');
        drag.el.className = 'drag-chip';
        drag.el.innerHTML = btn.querySelector('.mg').outerHTML;
        document.body.appendChild(drag.el);
      }
      drag.el.style.left = ev.clientX + 'px';
      drag.el.style.top = ev.clientY + 'px';
      hover = overStaff(ev) ? hoverAt(ev, true) : null;
      onPaintOverlay();
    });

    btn.addEventListener('pointerup', ev => {
      if (!drag || drag.kind !== 'chip' || drag.id !== ev.pointerId) return;
      const d = drag;
      drag = null;
      if (!d.started) { onSetDur(d.base); return; }
      d.el.remove();
      const h = hover;
      hover = null;
      if (h && overStaff(ev)) onPlaceNote(h, d.dur);
      else onPaintOverlay();
    });

    btn.addEventListener('pointercancel', () => {
      if (drag && drag.kind === 'chip') cancelDrag();
    });
  });

  return {
    getOverlayState: () => ({ chordHover, hover, drag, activeDurForGhost }),
    cancelDrag,
    isDragging: () => !!drag,
  };
}
