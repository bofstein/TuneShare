// Tune → MusicXML 4.0 (partwise) for download. Works from the in-memory tune, not the link format.
// Rules: one part, one or two staves; notes crossing a bar line are split and tied (buildPieces).
import { LETTERS, keyAlter } from './theory.js';
import { pitchesOf, staffList } from './model.js';
import { buildPieces } from './layout.js';

const DIV = 4;                                               // divisions per quarter = ticks per quarter
const TYPE = { 16: ['whole', 0], 12: ['half', 1], 8: ['half', 0], 6: ['quarter', 1], 4: ['quarter', 0], 3: ['eighth', 1], 2: ['eighth', 0], 1: ['16th', 0] };
const ACC = { '-1': 'flat', 0: 'natural', 1: 'sharp' };
const CLEF = { treble: ['G', 2], bass: ['F', 4] };

export const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Safe file name from the title. */
export const fileName = t => (t.title || 'tune').replace(/[\\/:*?"<>|]+/g, '').trim().slice(0, 80) + '.musicxml';

function noteXml(p, pitch, chord, staffNo, voice, acc) {
  const [type, dots] = TYPE[p.ticks], x = [];
  x.push('<note>');
  if (chord) x.push('<chord/>');
  if (p.rest) x.push(p.whole ? '<rest measure="yes"/>' : '<rest/>');
  else x.push(`<pitch><step>${LETTERS[pitch.step]}</step>${pitch.alter ? `<alter>${pitch.alter}</alter>` : ''}<octave>${pitch.oct}</octave></pitch>`);
  x.push(`<duration>${p.ticks}</duration>`);
  if (p.tieTo) x.push('<tie type="start"/>');
  if (p.tiedFrom) x.push('<tie type="stop"/>');
  x.push(`<voice>${voice}</voice>`);
  if (!p.whole) x.push(`<type>${type}</type>`, '<dot/>'.repeat(dots));
  if (acc != null) x.push(`<accidental>${ACC[acc]}</accidental>`);
  x.push(`<staff>${staffNo}</staff>`);
  if (p.tieTo || p.tiedFrom) x.push(`<notations>${p.tiedFrom ? '<tied type="stop"/>' : ''}${p.tieTo ? '<tied type="start"/>' : ''}</notations>`);
  x.push('</note>');
  return x.join('');
}

/** Pieces of one staff grouped by measure, with empty measures filled by a whole-measure rest. */
function staffMeasures(tune, staff) {
  const { pcs, tpm } = buildPieces({ time: tune.time, measures: tune.measures, events: staff.events });
  const byM = Array.from({ length: tune.measures }, () => []);
  for (const p of pcs) {
    if (p.tieTo) p.tieTo.tiedFrom = true;
    if (p.m < tune.measures) byM[p.m].push(p);
  }
  return byM.map(list => (list.length ? list.sort((a, b) => a.tick - b.tick) : [{ rest: true, whole: true, ticks: tpm, m: 0 }]));
}

export function toMusicXML(tune) {
  const staves = staffList(tune), n = staves.length;
  const [beats, beatType] = tune.time.split('/');
  const perStaff = staves.map(s => staffMeasures(tune, s));
  const tpm = perStaff[0][0].reduce((a, p) => a + p.ticks, 0);
  const out = [];
  for (let m = 0; m < tune.measures; m++) {
    const x = [`<measure number="${m + 1}">`];
    if (m === 0) {
      x.push(`<attributes><divisions>${DIV}</divisions><key><fifths>${tune.key}</fifths></key>`,
        `<time><beats>${beats}</beats><beat-type>${beatType}</beat-type></time>`,
        n > 1 ? `<staves>${n}</staves>` : '',
        ...staves.map((s, i) => `<clef number="${i + 1}"><sign>${CLEF[s.clef][0]}</sign><line>${CLEF[s.clef][1]}</line></clef>`),
        '</attributes>',
        `<direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>${tune.bpm}</per-minute></metronome></direction-type><sound tempo="${tune.bpm}"/></direction>`);
    }
    perStaff.forEach((ms, s) => {
      if (s) x.push(`<backup><duration>${tpm}</duration></backup>`);
      const seen = {};                                       // diatonic line → alter shown so far this measure
      for (const p of ms[m]) {
        if (p.rest) { x.push(noteXml(p, null, false, s + 1, s + 1)); continue; }
        pitchesOf(p.e).forEach((q, i) => {
          const line = q.oct * 7 + q.step, cur = line in seen ? seen[line] : keyAlter(tune.key, q.step);
          const acc = !p.tiedFrom && cur !== q.alter ? q.alter : null;
          seen[line] = q.alter;
          x.push(noteXml(p, q, i > 0, s + 1, s + 1, acc));
        });
      }
    });
    x.push('</measure>');
    out.push(x.join(''));
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">
<score-partwise version="4.0">
${tune.title ? `<work><work-title>${esc(tune.title)}</work-title></work>\n` : ''}<identification><encoding><software>TuneShare</software></encoding></identification>
<part-list><score-part id="P1"><part-name>Music</part-name></score-part></part-list>
<part id="P1">
${out.join('\n')}
</part>
</score-partwise>
`;
}
