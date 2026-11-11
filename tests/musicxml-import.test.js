import test from 'node:test';
import assert from 'node:assert/strict';
import { toMusicXML } from '../src/musicxml.js';
import { fromMusicXML, readMusicXmlFile } from '../src/musicxml-import.js';
import { parseXml } from '../src/xml.js';
import { INSTRUMENTS } from '../src/instruments.js';
import { tune, parse, ODE } from './helpers.js';

// Round trip: whatever export writes, import must read back unchanged. A feature added to the
// tune model and the exporter but not the importer fails here.
const roundTrip = t => fromMusicXML(toMusicXML(t));
const strip = t => JSON.parse(JSON.stringify(t));

test('Ode round-trips', () => {
  const t = tune(ODE, { measures: 8, title: 'Ode & <Joy>', bpm: 120, key: 1 });
  const r = roundTrip(t);
  assert.deepEqual(strip(r.tune), strip(t));
  assert.deepEqual(r.lost, []);
  assert.deepEqual(r.changes, []);
});

let seed = 7;
const rnd = n => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
function randomEvents(cap) {
  const out = [];
  let used = 0;
  while (used < cap) {
    const dur = rnd(8), len = [1, 2, 4, 8, 16, 3, 6, 12][dur];
    if (used + len > cap) break;
    used += len;
    if (rnd(5) === 0) { out.push({ rest: true, dur }); continue; }
    const n = 1 + (rnd(4) === 0 ? rnd(5) : 0), ds = new Set();
    while (ds.size < n) ds.add(24 + rnd(20));
    const ps = [...ds].sort((a, b) => a - b).map(d => ({ step: d % 7, oct: Math.floor(d / 7), alter: rnd(3) - 1 }));
    const [main, ...rest] = ps;
    out.push({ dur, ...main, ...(rest.length && { tones: rest }) });
  }
  // Trailing rests are not kept by export as events (a whole empty measure becomes one rest); drop them.
  while (out.length && out[out.length - 1].rest) out.pop();
  return out;
}

for (let i = 0; i < 40; i++) test(`random tune ${i} round-trips`, () => {
  const time = ['4/4', '3/4', '2/4', '6/8'][rnd(4)], measures = 1 + rnd(6);
  const cap = measures * { '4/4': 16, '3/4': 12, '2/4': 8, '6/8': 12 }[time];
  const t = tune('', { time, measures, key: rnd(15) - 7, bpm: 40 + rnd(200), clef: rnd(2) ? 'treble' : 'bass', events: randomEvents(cap) });
  if (rnd(2)) t.staff2 = { clef: 'bass', events: randomEvents(cap) };
  if (rnd(2)) t.instrument = INSTRUMENTS[rnd(INSTRUMENTS.length)].id;
  if (t.instrument === 'piano') delete t.instrument;
  if (rnd(2)) t.arranger = 'Arr. Someone';
  const r = roundTrip(t);
  assert.equal(r.error, undefined);
  assert.deepEqual(strip(normalize(r.tune)), strip(normalize(t)));
});

// Rests are re-spelled on import (beat-aligned), so compare rest runs by total length.
function normalize(t) {
  const fix = evs => {
    const out = [];
    for (const e of evs) {
      const len = [1, 2, 4, 8, 16, 3, 6, 12][e.dur];
      const p = out[out.length - 1];
      if (e.rest && p?.rest) p.len += len; else out.push(e.rest ? { rest: true, len } : { ...e, tones: e.tones && [...e.tones] });
    }
    while (out.length && out[out.length - 1].rest) out.pop();
    for (const e of out) if (!e.rest) {
      const all = [{ step: e.step, oct: e.oct, alter: e.alter }, ...(e.tones || [])].sort((a, b) => a.oct * 7 + a.step - b.oct * 7 - b.step);
      Object.assign(e, all[0]); if (all.length > 1) e.tones = all.slice(1); else delete e.tones;
    }
    return out;
  };
  return { ...t, events: fix(t.events), ...(t.staff2 && { staff2: { ...t.staff2, events: fix(t.staff2.events) } }) };
}

const score = (body, { time = '<time><beats>4</beats><beat-type>4</beat-type></time>', clef = '<clef><sign>G</sign><line>2</line></clef>', extra = '', parts } = {}) => `<?xml version="1.0"?>
<!DOCTYPE score-partwise PUBLIC "x" "y">
<score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Flute</part-name></score-part>${extra}</part-list>
${parts ?? `<part id="P1">${body}</part>`}</score-partwise>`;
const attrs = (o = {}) => `<attributes><divisions>${o.div ?? 1}</divisions><key><fifths>0</fifths></key>${o.time ?? '<time><beats>4</beats><beat-type>4</beat-type></time>'}${o.clef ?? '<clef><sign>G</sign><line>2</line></clef>'}</attributes>`;
const note = (p, d, x = '') => `<note>${x}<pitch><step>${p[0]}</step><octave>${p[1]}</octave></pitch><duration>${d}</duration><voice>1</voice></note>`;

test('lists what will be lost', () => {
  const r = fromMusicXML(score(`<measure number="1">${attrs()}<direction><direction-type><dynamics><f/></dynamics></direction-type></direction>${note('C4', 4, '').replace('</note>', '<notations><slur type="start"/></notations><lyric><text>la</text></lyric></note>')}</measure>`));
  const what = r.lost.map(l => l.what);
  assert.ok(what.includes('lyrics') && what.includes('slurs') && what.includes('dynamics'));
  assert.equal(r.tune.instrument, 'flute');                  // guessed from the part name
});

test('too long: truncated to the cap', () => {
  const ms = Array.from({ length: 120 }, (_, i) => `<measure number="${i + 1}">${i ? '' : attrs()}${note('C4', 4)}</measure>`).join('');
  const r = fromMusicXML(score(ms));
  assert.equal(r.tune.measures, 96);
  assert.equal(r.truncated, 120);
  assert.equal(r.tune.events.length, 96);
});

test('2/2 becomes 4/4; 12/8 becomes 6/8; 5/4 is refused with the measure', () => {
  assert.equal(fromMusicXML(score(`<measure number="1">${attrs({ time: '<time><beats>2</beats><beat-type>2</beat-type></time>' })}${note('C4', 4)}</measure>`)).tune.time, '4/4');
  const r = fromMusicXML(score(`<measure number="1">${attrs({ div: 2, time: '<time><beats>12</beats><beat-type>8</beat-type></time>' })}${note('C4', 12)}</measure>`));
  assert.equal(r.tune.time, '6/8'); assert.equal(r.tune.measures, 2);
  const bad = fromMusicXML(score(`<measure number="1">${attrs({ time: '<time><beats>5</beats><beat-type>4</beat-type></time>' })}${note('C4', 4)}</measure>`));
  assert.match(bad.error, /5\/4 in measure 1/);
});

test('alto clef becomes treble or bass by range; percussion is refused', () => {
  const r = fromMusicXML(score(`<measure number="1">${attrs({ clef: '<clef><sign>C</sign><line>3</line></clef>' })}${note('C4', 4)}${note('D4', 4)}</measure>`));
  assert.equal(r.tune.clef, 'treble');
  assert.match(r.changes.join(), /alto clef/);
  assert.match(fromMusicXML(score(`<measure number="1">${attrs({ clef: '<clef><sign>percussion</sign></clef>' })}</measure>`)).error, /percussion/);
});

test('ties across bar lines merge back; pickup measure is right-aligned', () => {
  const r = fromMusicXML(score(`<measure number="0" implicit="yes">${attrs()}${note('G4', 1)}</measure><measure number="1">${note('C5', 3)}${note('D5', 1, '').replace('<voice>', '<tie type="start"/><voice>')}</measure><measure number="2">${note('D5', 1).replace('<voice>', '<tie type="stop"/><voice>')}${note('E5', 3)}</measure>`));
  assert.deepEqual(r.tune.events, [...parse('r:h r:q G4:q C5:h. D5:h E5:h.')]);
});

test('second voice lines up as chord notes; extra staves are reported', () => {
  const p = `<measure number="1">${attrs()}<attributes><staves>3</staves></attributes>${note('E4', 4)}<backup><duration>4</duration></backup>${note('C4', 4).replace('<voice>1', '<voice>2')}<backup><duration>4</duration></backup>${note('C3', 4).replace('</voice>', '</voice><staff>2</staff>')}<backup><duration>4</duration></backup>${note('C2', 4).replace('</voice>', '</voice><staff>3</staff>')}</measure>`;
  const r = fromMusicXML(score(p));
  assert.deepEqual(r.tune.events, [{ dur: 4, step: 0, oct: 4, alter: 0, tones: [{ step: 2, oct: 4, alter: 0 }] }]);
  assert.equal(r.tune.staff2.events.length, 1);
  assert.match(r.lost.map(l => l.what).join(), /staves after the first two/);
});

test('bad XML gives a readable error', () => {
  assert.match(fromMusicXML('<score-partwise><part>').error, /isn't readable/);
  assert.match(fromMusicXML('<html></html>').error, /isn't a MusicXML score/);
});

test('xml parser: entities, attributes with >, CDATA', () => {
  const d = parseXml('<a x="1>2"><b>&amp;&#65;<![CDATA[<c>]]></b><!-- hi --><c/></a>');
  assert.equal(d.kids[0].attrs.x, '1>2');
  assert.equal(d.kids[0].kids[0].text, '&A<c>');
  assert.equal(d.kids[0].kids[1].name, 'c');
});

test('.mxl (zip) is unpacked', async () => {
  const xml = toMusicXML(tune(ODE, { measures: 8 }));
  const zip = await makeZip({ 'META-INF/container.xml': '<container><rootfiles><rootfile full-path="score.xml"/></rootfiles></container>', 'score.xml': xml });
  assert.equal(await readMusicXmlFile(zip), xml);
});

async function makeZip(files) {
  const enc = new TextEncoder(), parts = [], central = [];
  let off = 0;
  for (const [name, text] of Object.entries(files)) {
    const raw = enc.encode(text), nm = enc.encode(name);
    const comp = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer());
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(8, 8, true); lh.setUint32(18, comp.length, true); lh.setUint32(22, raw.length, true); lh.setUint16(26, nm.length, true);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(10, 8, true); ch.setUint32(20, comp.length, true); ch.setUint32(24, raw.length, true); ch.setUint16(28, nm.length, true); ch.setUint32(42, off, true);
    parts.push(new Uint8Array(lh.buffer), nm, comp); central.push(new Uint8Array(ch.buffer), nm);
    off += 30 + nm.length + comp.length;
  }
  const csize = central.reduce((a, b) => a + b.length, 0), eo = new DataView(new ArrayBuffer(22));
  eo.setUint32(0, 0x06054b50, true); eo.setUint16(10, Object.keys(files).length, true); eo.setUint32(12, csize, true); eo.setUint32(16, off, true);
  const all = [...parts, ...central, new Uint8Array(eo.buffer)], out = new Uint8Array(all.reduce((a, b) => a + b.length, 0));
  let p = 0; for (const a of all) { out.set(a, p); p += a.length; }
  return out;
}
