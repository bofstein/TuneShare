// Tiny tune-writing helper for tests: "B4:q C#5:e r:h".
const STEP = { C: 0, D: 1, E: 2, F: 3, G: 4, A: 5, B: 6 };
const DUR = { s: 0, e: 1, q: 2, h: 3, w: 4, 'e.': 5, 'q.': 6, 'h.': 7 };
export function parse(src) {
  return src.split(/\s+/).filter(t => t && t !== '|').map(t => {
    const [p, d] = t.split(':');
    if (p === 'r') return { rest: true, dur: DUR[d] };
    const m = p.match(/^([A-G])([#b]?)(\d)$/);
    return { dur: DUR[d], step: STEP[m[1]], oct: +m[3], alter: m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0 };
  });
}
export const tune = (src, over = {}) => ({ title: '', bpm: 100, key: 0, clef: 'treble', time: '4/4', measures: 4, events: parse(src), ...over });
export const ODE = 'B4:q B4:q C5:q D5:q | D5:q C5:q B4:q A4:q | G4:q G4:q A4:q B4:q | B4:q. A4:e A4:h | B4:q B4:q C5:q D5:q | D5:q C5:q B4:q A4:q | G4:q G4:q A4:q B4:q | A4:q. G4:e G4:h';
