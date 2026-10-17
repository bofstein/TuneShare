// Current tune + cursor, undo/redo, debounced URL writes.
import { encode } from './codec.js';
import { staffCount, staffEvents } from './model.js';

const MAX_UNDO = 200;

export class Store {
  constructor(tune) {
    this.tune = tune;
    this.cursor = { type: 'caret', index: tune.events.length, staff: 0 };
    this.undoStack = [];
    this.redoStack = [];
    this.listeners = [];
    this.lastHash = '';
    this.timer = 0;
  }

  subscribe(fn) { this.listeners.push(fn); }
  emit(change) { this.listeners.forEach(fn => fn(change)); }

  /** A cursor without `staff` stays on the current staff. */
  withStaff(cursor) { return cursor.staff === undefined ? { ...cursor, staff: this.cursor.staff || 0 } : cursor; }

  /** Apply a new tune (undoable) and optionally move the cursor. */
  commit(tune, cursor) {
    this.undoStack.push({ tune: this.tune, cursor: this.cursor });
    if (this.undoStack.length > MAX_UNDO) this.undoStack.shift();
    this.redoStack = [];
    this.tune = tune;
    if (cursor) this.cursor = this.withStaff(cursor);
    this.clampCursor();
    this.writeUrl();
    this.emit('tune');
  }

  setCursor(cursor) { this.cursor = this.withStaff(cursor); this.clampCursor(); this.emit('cursor'); }

  clampCursor() {
    const staff = Math.min(this.cursor.staff || 0, staffCount(this.tune) - 1);
    const n = staffEvents(this.tune, staff).length, c = { ...this.cursor, staff };
    this.cursor = c;
    if (c.type === 'note' && (c.index < 0 || c.index >= n)) this.cursor = { type: 'caret', index: n, staff };
    if (c.type === 'caret') this.cursor = { type: 'caret', index: Math.max(0, Math.min(n, c.index)), staff };
  }

  undo() { this.step(this.undoStack, this.redoStack); }
  redo() { this.step(this.redoStack, this.undoStack); }
  step(from, to) {
    const s = from.pop();
    if (!s) return;
    to.push({ tune: this.tune, cursor: this.cursor });
    this.tune = s.tune; this.cursor = s.cursor;
    this.clampCursor();
    this.writeUrl();
    this.emit('tune');
  }

  /** Replace everything (e.g. a pasted link): new undo history. */
  load(tune) {
    this.tune = tune;
    this.cursor = { type: 'caret', index: tune.events.length, staff: 0 };
    this.undoStack = []; this.redoStack = [];
    this.emit('tune');
  }

  writeUrl() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flushUrl(), 150);
  }

  flushUrl() {
    clearTimeout(this.timer);
    const hash = '#' + encode(this.tune);
    this.lastHash = hash;
    if (location.hash !== hash) history.replaceState(null, '', hash);
    this.onUrl?.(location.href.length);
  }
}
