// MusicXML (.musicxml, .xml, .mxl) → tune. The counterpart of musicxml.js (export).
// Imports what TuneShare can show and reports everything else, so the user can decide before
// their tune is replaced. Scope follows the tune model: when the model gains a feature, take
// it out of LOST below, read it here, and the round-trip test in tests/musicxml-import.test.js
// will hold export and import to the same behavior. DESIGN.md, "MusicXML import".
import { parseXml, kid, kids, textOf, walk } from './xml.js';
import { DIV, CLEF } from './musicxml.js';
import { LETTERS, SEMITONES, TIMES, TICKS_PER_MEASURE, TICKS_TO_DUR, DUR_TICKS, spellAligned } from './theory.js';
import { MAX_MEASURES, MAX_CHORD_NOTES, withPitches } from './model.js';
import { INSTRUMENTS, DEFAULT_INSTRUMENT, instrumentFromGm } from './instruments.js';

// Elements TuneShare has no place for, by the name shown to the user.
const LOST = {
  lyric: 'lyrics', slur: 'slurs', dynamics: 'dynamics', wedge: 'crescendo/diminuendo hairpins',
  articulations: 'articulations (staccato, accents…)', ornaments: 'ornaments (trills, turns…)',
  fermata: 'fermatas', technical: 'technical marks (fingering, bowing…)', words: 'text directions',
  pedal: 'pedal marks', harmony: 'chord symbols', repeat: 'repeat signs', ending: '1st/2nd endings',
  'octave-shift': 'octave lines (8va)', tremolo: 'tremolos', glissando: 'glissandos', slide: 'slides',
  arpeggiate: 'arpeggio marks', segno: 'segno/coda signs', coda: 'segno/coda signs',
  rehearsal: 'rehearsal marks', 'time-modification': 'tuplets (rounded to the nearest 16th)',
  grace: 'grace notes', cue: 'cue notes', transpose: 'transposition (written pitch is kept)',
};
const LEGAL = new Set(DUR_TICKS);
const MAX_DIATONIC = 69;                                     // B9: the highest pitch a link can hold
const TIME_LIST = () => TIMES.join(', ');

class Incompatible extends Error {}

/** Read an uploaded file (bytes) into MusicXML text: plain XML in UTF-8/16, or a compressed .mxl zip. */
export async function readMusicXmlFile(bytes) {
  bytes = new Uint8Array(bytes);
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) return decodeText(await unzipScore(bytes));
  return decodeText(bytes);
}

function decodeText(b) {
  if (b[0] === 0xff && b[1] === 0xfe) return new TextDecoder('utf-16le').decode(b);
  if (b[0] === 0xfe && b[1] === 0xff) return new TextDecoder('utf-16be').decode(b);
  return new TextDecoder().decode(b);
}

/** The score file inside an .mxl zip (META-INF/container.xml names it). */
async function unzipScore(b) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Incompatible('This .mxl file is damaged (no zip directory).');
  const files = {};
  for (let p = dv.getUint32(eocd + 16, true), n = dv.getUint16(eocd + 10, true); n-- > 0;) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const nameLen = dv.getUint16(p + 28, true), extra = dv.getUint16(p + 30, true), comment = dv.getUint16(p + 32, true);
    const name = new TextDecoder().decode(b.subarray(p + 46, p + 46 + nameLen));
    files[name] = { method: dv.getUint16(p + 10, true), size: dv.getUint32(p + 20, true), at: dv.getUint32(p + 42, true) };
    p += 46 + nameLen + extra + comment;
  }
  const read = async f => {
    const h = f.at, data = b.subarray(h + 30 + dv.getUint16(h + 26, true) + dv.getUint16(h + 28, true));
    if (f.method === 0) return data.subarray(0, f.size);
    if (f.method !== 8) throw new Incompatible('This .mxl file uses an unsupported compression method.');
    const out = new Response(new Blob([data.subarray(0, f.size)]).stream().pipeThrough(new DecompressionStream('deflate-raw')));
    return new Uint8Array(await out.arrayBuffer());
  };
  let path = null;
  if (files['META-INF/container.xml']) {
    const c = parseXml(decodeText(await read(files['META-INF/container.xml'])));
    path = [...walk(c)].find(n => n.name === 'rootfile')?.attrs['full-path'];
  }
  path ||= Object.keys(files).find(n => !n.startsWith('META-INF/') && /\.(musicxml|xml)$/i.test(n));
  if (!path || !files[path]) throw new Incompatible('No score was found inside this .mxl file.');
  return read(files[path]);
}

/**
 * Parse MusicXML text. Returns { tune, lost: [{what, count}], changes: [string], title }
 * or { error } with a message that says which part of the file can't be imported.
 */
export function fromMusicXML(text) {
  try { return importScore(text); } catch (e) {
    if (e instanceof Incompatible) return { error: e.message };
    if (/^Not valid XML/.test(e.message)) return { error: `This file isn't readable MusicXML (${e.message.replace('Not valid XML: ', '')}).` };
    throw e;
  }
}

/** Change a ticks-per-measure grid's time to the closest supported one, or null. */
function fitTime(beats, beatType) {
  const name = `${beats}/${beatType}`, len = (beats * 16) / beatType;
  if (TICKS_PER_MEASURE[name]) return name;
  if (!Number.isInteger(len)) return null;
  const rank = t => (t.endsWith(`/${beatType}`) ? 0 : 1);
  const pick = ok => TIMES.filter(t => ok(TICKS_PER_MEASURE[t])).sort((a, b) => rank(a) - rank(b))[0];
  return pick(L => L === len) || pick(L => len % L === 0) || pick(L => L % len === 0) || null;
}

function pitchOf(p) {
  let step = LETTERS.indexOf(textOf(p, 'step')), oct = +textOf(p, 'octave'), alter = Math.round(+(textOf(p, 'alter') || 0));
  if (step < 0 || !Number.isFinite(oct)) return null;
  while (Math.abs(alter) > 1) {                              // double sharp/flat → the next letter
    const dir = Math.sign(alter), d = oct * 7 + step + dir, ns = ((d % 7) + 7) % 7, no = Math.floor(d / 7);
    alter -= (no * 12 + SEMITONES[ns]) - (oct * 12 + SEMITONES[step]);
    step = ns; oct = no;
  }
  const d = Math.max(0, Math.min(MAX_DIATONIC, oct * 7 + step));
  return { step: d % 7, oct: Math.floor(d / 7), alter };
}

const pitchKey = p => `${p.oct * 7 + p.step}:${p.alter}`;
const sameChord = (a, b) => a.length === b.length && a.map(pitchKey).sort().join() === b.map(pitchKey).sort().join();

function partList(score) {
  const parts = kids(score, 'part');
  if (score.name === 'score-timewise') {                     // regroup measures by part
    const byId = {};
    for (const m of kids(score, 'measure')) for (const p of kids(m, 'part')) {
      (byId[p.attrs.id] ||= { name: 'part', attrs: { id: p.attrs.id }, kids: [], text: '' }).kids.push({ ...p, name: 'measure', attrs: { ...m.attrs } });
    }
    return Object.values(byId);
  }
  return parts;
}

function importScore(text) {
  const doc = parseXml(text);
  const score = doc.kids.find(k => k.name === 'score-partwise' || k.name === 'score-timewise');
  if (!score) throw new Incompatible("This file isn't a MusicXML score (no <score-partwise> found).");

  const lostCounts = {}, changes = [];
  const lose = (what, n = 1) => { lostCounts[what] = (lostCounts[what] || 0) + n; };
  for (const n of walk(score)) if (LOST[n.name]) lose(LOST[n.name]);

  const info = {};
  for (const sp of kids(kid(score, 'part-list'), 'score-part')) {
    info[sp.attrs.id] = { name: textOf(sp, 'part-name') || sp.attrs.id, prog: +textOf(kid(sp, 'midi-instrument'), 'midi-program') || 0 };
  }
  const parts = partList(score);
  if (!parts.length) throw new Incompatible('This score has no parts.');

  let time = null, tpm = 0, key = null, bpm = null, measureCount = 0;
  const slots = [], dropped = [];                                          // chosen staves: { part, staff, label, clefs, notes }

  parts.forEach((part, pi) => {
    const pname = info[part.attrs.id]?.name || `Part ${pi + 1}`;
    const local = {};                                        // staff number → slot (or null if dropped)
    const slotFor = n => {
      if (n in local) return local[n];
      if (slots.length < 2) slots.push(local[n] = { label: `${pname}${n > 1 ? ` (staff ${n})` : ''}`, part: pi, clef: null, notes: [] });
      else { local[n] = null; dropped.push(`${pname}${n > 1 ? ` (staff ${n})` : ''}`); }
      return local[n];
    };
    let div = 1, start = 0, pos = 0, last = {}, partEnd = 0, curLen = null;
    const measures = kids(part, 'measure');
    measures.forEach((m, mi) => {
      pos = 0;
      let maxPos = 0;
      const toTicks = d => {
        const t = (d * DIV) / div;
        if (!Number.isInteger(t)) roundedNote.flag = true;
        return Math.round(t);
      };
      const roundedNote = { flag: false };
      for (const el of m.kids) {
        if (el.name === 'attributes') {
          if (textOf(el, 'divisions')) div = +textOf(el, 'divisions') || 1;
          const k = kid(el, 'key');
          if (k && textOf(k, 'fifths') != null) {
            const f = Math.max(-7, Math.min(7, +textOf(k, 'fifths') || 0));
            if (key === null) key = f; else if (f !== key) lose('key changes (pitches are kept)');
          }
          const ts = kid(el, 'time');
          if (ts) {
            if (kid(ts, 'senza-misura')) throw new Incompatible(`${pname} has no time signature (senza misura) in measure ${m.attrs.number ?? mi + 1}. Add a time signature and try again.`);
            const beats = textOf(ts, 'beats'), bt = +textOf(ts, 'beat-type');
            const b = beats && /^\d+$/.test(beats) ? +beats : null;
            const where = `measure ${m.attrs.number ?? mi + 1}`;
            if (!b || !bt) throw new Incompatible(`The time signature ${beats}/${bt || '?'} in ${where} isn't supported. TuneShare supports ${TIME_LIST()}.`);
            const measureLen = (b * 16) / bt;
            curLen = measureLen;
            if (time === null) {
              const fit = fitTime(b, bt);
              if (!fit) throw new Incompatible(`The time signature ${b}/${bt} in ${where} can't be shown in TuneShare, which supports ${TIME_LIST()}. Change it in your notation program and import again.`);
              if (fit !== `${b}/${bt}`) changes.push(`Time signature ${b}/${bt} is written as ${fit}${TICKS_PER_MEASURE[fit] !== measureLen ? ', so bar lines fall in different places' : ''}.`);
              time = fit; tpm = TICKS_PER_MEASURE[fit];
            } else if (pi === 0 && measureLen !== tpm) {
              if (measureLen % tpm && tpm % measureLen) throw new Incompatible(`The time signature changes to ${b}/${bt} in ${where}. TuneShare uses one time signature (${time}) for the whole tune, and this change doesn't line up with it.`);
              lose('time signature changes');
            }
          }
          for (const c of kids(el, 'clef')) {
            const s = slotFor(+(c.attrs.number || 1));
            if (!s) continue;
            const sign = textOf(c, 'sign'), line = +textOf(c, 'line'), oc = +textOf(c, 'clef-octave-change') || 0;
            if (sign === 'percussion') throw new Incompatible(`${s.label} uses a percussion clef. TuneShare only writes pitched notes, so drop that staff and import again.`);
            const exact = Object.keys(CLEF).find(n => CLEF[n][0] === sign && CLEF[n][1] === line && !oc);
            if (s.clef === null) s.clef = exact || { sign, line, oc };
            else if ((exact || null) !== (typeof s.clef === 'string' ? s.clef : null)) lose('clef changes');
          }
        } else if (el.name === 'backup') pos -= +textOf(el, 'duration') || 0;
        else if (el.name === 'forward') pos += +textOf(el, 'duration') || 0;
        else if (el.name === 'sound' || el.name === 'direction') {
          const snd = el.name === 'sound' ? el : kid(el, 'sound');
          let t = snd?.attrs.tempo ? +snd.attrs.tempo : null;
          if (t == null && el.name === 'direction') {
            const mt = [...walk(el)].find(n => n.name === 'metronome'), pm = mt && +textOf(mt, 'per-minute');
            if (pm) t = pm * ({ half: 2, eighth: 0.5, whole: 4 }[textOf(mt, 'beat-unit')] || 1) * (kid(mt, 'beat-unit-dot') ? 1.5 : 1);
          }
          if (t) { if (bpm === null) bpm = t; else if (Math.round(t) !== Math.round(bpm)) lose('tempo changes'); }
        } else if (el.name === 'note') {
          const dur = +textOf(el, 'duration') || 0;
          if (kid(el, 'grace') || kid(el, 'cue')) continue;        // counted in LOST already
          const chord = !!kid(el, 'chord');
          const staffNo = +(textOf(el, 'staff') || 1), voice = textOf(el, 'voice') || '1';
          const s = slotFor(staffNo);
          if (chord) {                                         // same onset as the previous note in this voice
            const prev = last[`${staffNo}:${voice}`];
            if (s && prev && kid(el, 'pitch')) { const p = pitchOf(kid(el, 'pitch')); if (p) prev.pitches.push(p); }
            continue;
          }
          roundedNote.flag = false;
          const on = start + toTicks(pos), off = start + toTicks(pos + dur);
          pos += dur; maxPos = Math.max(maxPos, pos);
          if (!s) continue;
          if (kid(el, 'unpitched')) throw new Incompatible(`${s.label} has unpitched (percussion) notes in measure ${m.attrs.number ?? mi + 1}. TuneShare only writes pitched notes.`);
          const ties = kids(el, 'tie').map(t => t.attrs.type);
          const p = kid(el, 'pitch') && pitchOf(kid(el, 'pitch'));
          const n = { on, len: off - on, rest: !p, pitches: p ? [p] : [], voice, tieStart: ties.includes('start'), tieStop: ties.includes('stop'), rounded: roundedNote.flag };
          s.notes.push(n);
          last[`${staffNo}:${voice}`] = n;
        }
        maxPos = Math.max(maxPos, pos);
      }
      // Pickup measure: right-align it so later bar lines land on the grid.
      const bar = curLen || tpm || 16, content = toTicks(maxPos);
      let len = bar;
      if (m.attrs.implicit === 'yes' && content < bar) {
        if (mi === 0) {
          for (const s of slots) if (s.part === pi) for (const n of s.notes) n.on += bar - content;
          if (pi === 0) changes.push('The pickup (anacrusis) measure is filled out with rests at the start.');
        } else len = content;
      }
      start += len;
      partEnd = start;
    });
    if (pi === 0) measureCount = Math.ceil(partEnd / (tpm || 16));
  });

  if (!slots.length || !slots.some(s => s.notes.length)) throw new Incompatible('No notes were found in this score.');
  if (!time) { time = '4/4'; tpm = 16; changes.push('The score has no time signature, so 4/4 is used.'); }

  // Clefs: exact matches keep theirs; anything else becomes treble or bass by where the notes sit.
  for (const s of slots) {
    if (typeof s.clef === 'string') continue;
    const ds = s.notes.flatMap(n => n.pitches.map(p => p.oct * 7 + p.step)).sort((a, b) => a - b);
    const mid = ds.length ? ds[ds.length >> 1] : 34;
    const pick = mid >= 28 ? 'treble' : 'bass';
    if (s.clef) {
      const { sign, line, oc } = s.clef;
      const nm = { 'C3': 'alto', 'C4': 'tenor', 'C1': 'soprano', 'C2': 'mezzo-soprano', 'C5': 'baritone', 'F3': 'baritone', 'F5': 'sub-bass', 'G1': 'French violin', 'TAB5': 'tab', 'TAB6': 'tab' }[`${sign}${line}`];
      changes.push(`${s.label}: the ${nm || sign} clef${oc ? ` with an octave change` : ''} is shown as a ${pick} clef (the notes keep their pitch).`);
    }
    s.clef = pick;
  }

  // Build each staff's event list.
  const counts = { voices: 0, split: 0, chords: 0, rounded: 0, ties: 0 };
  const staves = slots.map(s => buildEvents(s, tpm, counts));
  if (dropped.length) lose(`staves after the first two (${dropped.join(', ')})`);
  if (counts.voices) lose('extra voices on a staff (overlapping notes)', counts.voices);
  if (counts.rounded) changes.push(`${counts.rounded} note${counts.rounded > 1 ? 's were' : ' was'} rounded to the nearest 16th.`);
  if (counts.split) changes.push(`${counts.split} note${counts.split > 1 ? 's' : ''} with lengths TuneShare can't write ${counts.split > 1 ? 'were' : 'was'} split into shorter notes.`);
  if (counts.ties) changes.push(`${counts.ties} tie${counts.ties > 1 ? 's' : ''} couldn't be kept and became repeated notes.`);
  if (counts.chords) changes.push(`${counts.chords} chord${counts.chords > 1 ? 's' : ''} with more than ${MAX_CHORD_NOTES} notes kept the top ${MAX_CHORD_NOTES}.`);

  // Measure count and the cap.
  const used = Math.max(...staves.map(ev => ev.reduce((a, e) => a + DUR_TICKS[e.dur], 0)));
  const needed = Math.max(1, measureCount, Math.ceil(used / tpm));
  let measures = needed, truncated = 0;
  if (needed > MAX_MEASURES) {
    measures = MAX_MEASURES; truncated = needed;
    for (let i = 0; i < staves.length; i++) staves[i] = cut(staves[i], MAX_MEASURES * tpm);
  }

  const first = info[parts[0].attrs.id] || {};
  let instrument = first.prog ? instrumentFromGm(first.prog - 1) : nameGuess(first.name);
  const tune = {
    title: (textOf(kid(score, 'work'), 'work-title') || textOf(score, 'movement-title') || '').slice(0, 60),
    bpm: Math.max(40, Math.min(240, Math.round(bpm || 100))),
    key: key ?? 0, clef: slots[0].clef, time, measures, events: staves[0],
  };
  const arranger = kids(kid(score, 'identification'), 'creator').find(c => c.attrs.type === 'arranger')?.text.trim();
  if (arranger) tune.arranger = arranger.slice(0, 60);
  if (instrument && instrument !== DEFAULT_INSTRUMENT) tune.instrument = instrument;
  if (slots[1]) tune.staff2 = { clef: slots[1].clef, events: staves[1] };
  if (bpm && (bpm < 40 || bpm > 240)) changes.push(`Tempo ${Math.round(bpm)} is outside 40–240 and was set to ${tune.bpm}.`);
  const lost = Object.entries(lostCounts).map(([what, count]) => ({ what, count })).sort((a, b) => b.count - a.count);
  return { tune, lost, changes, truncated, staffLabels: slots.map(s => s.label) };
}

function nameGuess(name = '') {
  const n = name.toLowerCase();
  const hit = [['cello', 'cello'], ['violin', 'violin'], ['viola', 'violin'], ['trumpet', 'trumpet'], ['flute', 'flute'], ['sax', 'sax'],
    ['electric guitar', 'eguitar'], ['guitar', 'guitar'], ['electric piano', 'epiano'], ['choir', 'choir'], ['voice', 'choir'],
    ['soprano', 'choir'], ['alto', 'choir'], ['tenor', 'choir'], ['synth', 'synth']].find(([k]) => n.includes(k));
  return hit ? hit[1] : DEFAULT_INSTRUMENT;
}

/** Rests filling [from, to), split at bar lines and aligned to the beat grid. */
function restsBetween(from, to, tpm) {
  const out = [];
  for (let t = from; t < to;) {
    const end = Math.min(to, (Math.floor(t / tpm) + 1) * tpm);
    for (const [, v] of spellAligned(t % tpm, end - t)) out.push({ rest: true, dur: TICKS_TO_DUR[v] });
    t = end;
  }
  return out;
}

/** Legal lengths summing to len, longest first. */
function lengths(len) {
  const out = [];
  for (const v of [16, 12, 8, 6, 4, 3, 2, 1]) while (len >= v) { out.push(v); len -= v; }
  return out;
}

function buildEvents(slot, tpm, counts) {
  // One voice per staff: the first voice that appears. Other voices merge into chords when they line up.
  const main = slot.notes.find(n => !n.rest)?.voice ?? slot.notes[0]?.voice;
  const primary = slot.notes.filter(n => n.voice === main).sort((a, b) => a.on - b.on);
  for (const n of slot.notes) {
    if (n.voice === main || n.rest) continue;
    const host = primary.find(p => p.on === n.on && p.len === n.len);
    if (host && !host.rest) host.pitches.push(...n.pitches);
    else if (host && host.rest) { host.rest = false; host.pitches = [...n.pitches]; host.tieStart = n.tieStart; host.tieStop = n.tieStop; }
    else if (!primary.some(p => !p.rest && p.on < n.on + n.len && n.on < p.on + p.len)) primary.push(n);
    else counts.voices++;
  }
  primary.sort((a, b) => a.on - b.on || a.rest - b.rest);

  const out = [];
  let t = 0, prev = null;                                    // prev: last note event, with its end tick
  for (const n of primary) {
    if (n.len <= 0) continue;
    if (n.on < t) { if (!n.rest) counts.voices++; continue; }
    if (n.on > t) { out.push(...restsBetween(t, n.on, tpm)); t = n.on; prev = null; }
    if (n.rounded) counts.rounded++;
    if (n.rest) { out.push(...restsBetween(t, t + n.len, tpm)); t += n.len; prev = null; continue; }
    // Dedupe, then keep the top MAX_CHORD_NOTES pitches.
    let ps = [...new Map(n.pitches.map(p => [pitchKey(p), p])).values()].sort((a, b) => (b.oct * 7 + b.step) - (a.oct * 7 + a.step));
    if (ps.length > MAX_CHORD_NOTES) { counts.chords++; ps = ps.slice(0, MAX_CHORD_NOTES); }
    ps.reverse();                                            // lowest first, like notes added on the staff
    if (n.tieStop && prev && prev.end === t && sameChord(prev.ps, ps)) {
      const total = DUR_TICKS[prev.ev.dur] + n.len;
      if (LEGAL.has(total)) { prev.ev.dur = TICKS_TO_DUR[total]; prev.end += n.len; t += n.len; continue; }
      counts.ties++;
    }
    const pieces = lengths(n.len);
    if (pieces.length > 1) counts.split++;
    for (const v of pieces) {
      const ev = withPitches({ dur: TICKS_TO_DUR[v] }, ps);
      out.push(ev);
      t += v;
      prev = { ev, ps, end: t };
    }
  }
  return out;
}

/** Events cut to cap ticks; a note crossing the cap is shortened. */
function cut(events, cap) {
  const out = [];
  let t = 0;
  for (const e of events) {
    const len = DUR_TICKS[e.dur];
    if (t + len <= cap) { out.push(e); t += len; continue; }
    for (const v of lengths(cap - t)) out.push({ ...e, dur: TICKS_TO_DUR[v] });
    break;
  }
  return out;
}

/** Plain-language summary lines for the confirm dialog. */
export function describeImport(r) {
  const lines = [];
  if (r.truncated) lines.push(`The score has ${r.truncated} measures; only the first ${MAX_MEASURES} fit, so the rest is cut off.`);
  return lines.concat(r.changes);
}

export const COMMON_LOSSES = ['lyrics', 'dynamics', 'slurs', 'articulations', 'repeats', 'chord symbols', 'more than two staves'];
export const instrumentLabel = id => INSTRUMENTS.find(x => x.id === id)?.name;
