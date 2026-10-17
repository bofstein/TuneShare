import test from 'node:test';
import assert from 'node:assert/strict';
import { toMusicXML, fileName } from '../src/musicxml.js';
import { tune, parse, ODE } from './helpers.js';

// Minimal well-formedness check: every tag closes in order.
function wellFormed(xml) {
  const body = xml.replace(/<\?xml[^>]*\?>/, '').replace(/<!DOCTYPE[^>]*>/, '');
  const stack = [];
  for (const [, close, name, self] of body.matchAll(/<(\/?)([\w-]+)[^>]*?(\/?)>/g)) {
    if (self) continue;
    if (close) assert.equal(stack.pop(), name); else stack.push(name);
  }
  assert.equal(stack.length, 0);
}
const count = (xml, s) => xml.split(s).length - 1;

test('Ode exports well-formed with 8 measures', () => {
  const x = toMusicXML(tune(ODE, { measures: 8, title: 'Ode & <Joy>' }));
  wellFormed(x);
  assert.equal(count(x, '<measure '), 8);
  assert.match(x, /<work-title>Ode &amp; &lt;Joy&gt;<\/work-title>/);
  assert.match(x, /<type>quarter<\/type><dot\/>/);
});

for (const key of [-7, -3, 0, 2, 7]) test(`key ${key}`, () => {
  const x = toMusicXML(tune('C4:w', { key }));
  wellFormed(x);
  assert.match(x, new RegExp(`<fifths>${key}</fifths>`));
});

test('accidentals follow key and measure state', () => {
  const x = toMusicXML(tune('F4:q F#4:q F#4:q Fb4:q', { key: 0 }));   // natural, sharp shown, no repeat, flat
  assert.equal(count(x, '<accidental>sharp</accidental>'), 1);
  assert.equal(count(x, '<accidental>flat</accidental>'), 1);
  const g = toMusicXML(tune('F#4:q F4:q F#4:q', { key: 1 }));          // G major: F# none, F natural, F# again
  assert.equal(count(g, '<accidental>natural</accidental>'), 1);
  assert.equal(count(g, '<accidental>sharp</accidental>'), 1);
});

test('notes over a bar line are tied', () => {
  const x = toMusicXML(tune('C4:h. D4:h', { measures: 2 }));
  wellFormed(x);
  assert.equal(count(x, '<tie type="start"/>'), 1);
  assert.equal(count(x, '<tied type="stop"/>'), 1);
});

test('chords, empty measures and 6/8', () => {
  const [e] = parse('C4:q.');
  e.tones = [{ step: 2, oct: 4, alter: 0 }, { step: 4, oct: 4, alter: 0 }];
  const x = toMusicXML(tune('', { time: '6/8', measures: 2, events: [e] }));
  wellFormed(x);
  assert.equal(count(x, '<chord/>'), 2);
  assert.match(x, /<beats>6<\/beats><beat-type>8<\/beat-type>/);
  assert.match(x, /<rest measure="yes"\/>/);
});

test('two staves with separate clefs', () => {
  const x = toMusicXML(tune('C5:w', { staff2: { clef: 'bass', events: parse('C3:h G2:h') } }));
  wellFormed(x);
  assert.match(x, /<staves>2<\/staves>/);
  assert.match(x, /<clef number="1"><sign>G<\/sign><line>2<\/line><\/clef><clef number="2"><sign>F<\/sign><line>4<\/line>/);
  assert.equal(count(x, '<backup><duration>16</duration></backup>'), 4);
  assert.match(x, /<staff>2<\/staff>/);
});

test('file name', () => {
  assert.equal(fileName({ title: 'A/B: c?' }), 'AB c.musicxml');
  assert.equal(fileName({ title: '' }), 'tune.musicxml');
});
