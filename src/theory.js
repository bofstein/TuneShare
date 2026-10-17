// Music theory helpers: durations, keys, pitch math. Pure, no DOM.

// Duration codes are fixed by the URL format — never renumber.
export const DUR_TICKS = [1, 2, 4, 8, 16, 3, 6, 12];
export const DUR_NAME = ['16th', 'eighth', 'quarter', 'half', 'whole', 'dotted eighth', 'dotted quarter', 'dotted half'];
export const TICKS_TO_DUR = { 1: 0, 2: 1, 4: 2, 8: 3, 16: 4, 3: 5, 6: 6, 12: 7 };
export const ticksOf = e => DUR_TICKS[e.dur];
export const isDotted = dur => dur >= 5;
export const undotted = dur => (dur >= 5 ? dur - 4 : dur);
export const canDot = dur => { const b = undotted(dur); return b >= 1 && b <= 3; };
export const toggleDot = dur => (dur >= 5 ? dur - 4 : canDot(dur) ? dur + 4 : dur);

export const TIMES = ['4/4', '3/4', '2/4', '6/8'];          // index = URL enum value
export const TICKS_PER_MEASURE = { '2/4': 8, '3/4': 12, '4/4': 16, '6/8': 12 };
export const BEAT_TICKS = { '2/4': 4, '3/4': 4, '4/4': 4, '6/8': 6 };

export const LETTERS = 'CDEFGAB';
export const SEMITONES = [0, 2, 4, 5, 7, 9, 11];
export const SHARP_ORDER = [3, 0, 4, 1, 5, 2, 6];            // F C G D A E B
export const FLAT_ORDER = [6, 2, 5, 1, 4, 0, 3];             // B E A D G C F

export const KEY_NAMES = [
  'C♭ major / A♭ minor', 'G♭ major / E♭ minor', 'D♭ major / B♭ minor', 'A♭ major / F minor',
  'E♭ major / C minor', 'B♭ major / G minor', 'F major / D minor', 'C major / A minor',
  'G major / E minor', 'D major / B minor', 'A major / F♯ minor', 'E major / C♯ minor',
  'B major / G♯ minor', 'F♯ major / D♯ minor', 'C♯ major / A♯ minor',
];
export const keyName = key => KEY_NAMES[key + 7];
export const keyLabel = key => keyName(key) + (key ? ` (${Math.abs(key)}${key > 0 ? '♯' : '♭'})` : '');

/** Alteration the key signature gives to a letter (0–6). */
export function keyAlter(key, step) {
  if (key > 0) return SHARP_ORDER.slice(0, key).includes(step) ? 1 : 0;
  if (key < 0) return FLAT_ORDER.slice(0, -key).includes(step) ? -1 : 0;
  return 0;
}

export const diatonic = p => p.oct * 7 + p.step;
export const fromDiatonic = d => ({ step: ((d % 7) + 7) % 7, oct: Math.floor(d / 7) });
export const midiOf = p => 12 * (p.oct + 1) + SEMITONES[p.step] + p.alter;
export const freqOf = midi => 440 * Math.pow(2, (midi - 69) / 12);
/**
 * The pitch one half step up (dir = 1) or down (dir = -1), spelled to suit the key:
 * a note of the key's scale if there is one, else a plain natural, else a sharp going up
 * or a flat going down. Alterations stay within −1..+1.
 */
export function halfStep(p, dir, key) {
  const target = midiOf(p) + dir;
  const spellings = [];
  for (let step = 0; step < 7; step++) {
    const oct = Math.round((target - SEMITONES[step]) / 12) - 1;
    const alter = target - midiOf({ step, oct, alter: 0 });
    if (Math.abs(alter) <= 1) spellings.push({ step, oct, alter });
  }
  return spellings.find(q => q.alter === keyAlter(key, q.step))
    || spellings.find(q => q.alter === 0)
    || spellings.find(q => q.alter === dir);
}
export const pitchName = p => LETTERS[p.step] + (p.alter === 1 ? '♯' : p.alter === -1 ? '♭' : '') + p.oct;

// Diatonic index of the bottom staff line, the middle line, and the editable range.
export const CLEFS = {
  treble: { bottom: 30, middle: 34, min: 24, max: 44 },    // E4, B4, F3–E6
  bass: { bottom: 18, middle: 22, min: 12, max: 32 },      // G2, D3, A1–G4
};
export const clampDiatonic = (clef, d) => Math.max(CLEFS[clef].min, Math.min(CLEFS[clef].max, d));

/** Greedy spelling of a length (ticks) into legal duration tick values. */
export function spell(len) {
  const out = [];
  for (const v of [16, 12, 8, 6, 4, 3, 2, 1]) while (len >= v) { out.push(v); len -= v; }
  return out;
}

/** Rest spelling aligned to the beat grid: [[tickInMeasure, ticks], …]. */
export function spellAligned(start, len) {
  const out = [];
  let t = start;
  const end = start + len;
  while (t < end) {
    for (const v of [16, 8, 4, 2, 1]) {
      if (t % v === 0 && t + v <= end) { out.push([t, v]); t += v; break; }
    }
  }
  return out;
}

export const tempoWord = b => (b < 60 ? 'Largo' : b < 76 ? 'Adagio' : b < 108 ? 'Andante' : b < 120 ? 'Moderato' : b < 168 ? 'Allegro' : 'Presto');
