import test from 'node:test';
import assert from 'node:assert/strict';
import { encode } from '../src/codec.js';
import { dumpFragment, walk } from '../src/debug.js';
import { tune } from './helpers.js';

test('empty tune dumps as an empty message', () => {
  const d = dumpFragment('#1.');
  assert.match(d, /Payload: 0 bytes/);
  assert.match(d, /every field at its default/);
});

test('header fields are named and decoded', () => {
  const d = dumpFragment('#' + encode(tune('', { title: 'Hi', bpm: 120, key: -3, clef: 'bass', time: '6/8', measures: 8 })));
  assert.match(d, /1 title \(len\) @0: 2 bytes {2}48 69\n +"Hi"/);
  assert.match(d, /2 bpm \(varint\) @\d+: 120 {2}120 bpm/);
  assert.match(d, /3 key \(varint\) @\d+: 5 {2}zigzag → -3/);
  assert.match(d, /4 clef \(varint\) @\d+: 1 {2}BASS/);
  assert.match(d, /5 time \(varint\) @\d+: 3 {2}6\/8/);
  assert.match(d, /6 measures \(varint\) @\d+: 8 {2}8 measures/);
});

test('v1: events and chords are unpacked into 12-bit codes', () => {
  // v1 link for "C4:q r:h" with an E♯4 tone on the first note
  const d = dumpFragment('#1.OgNFZgBCBBICBdA');
  assert.match(d, /7 events \(len\)/);
  assert.match(d, /\[0\] 0x\w{3} {2}quarter C4/);
  assert.match(d, /\[1\] 0x600 {2}half rest/);
  assert.match(d, /8 chord \(len\)/);
  assert.match(d, /2 tones \(len\)[^\n]*\n\s+\[0\] 0x\w{3} {2}E♯4/);
});

test('unknown fields and garbage are shown, not hidden', () => {
  const bytes = [0x50, 0x05, 0x3a, 0x09, 0x01];       // field 10 varint 5, then a truncated field 7
  const d = dumpFragment('#1.' + Buffer.from(bytes).toString('base64url'));
  assert.match(d, /10 unknown \(varint\) @0: 5/);
  assert.match(d, /!! truncated: 1\/9 bytes/);
  assert.equal(walk([0x80]).at(-1).error.startsWith('truncated varint'), true);
  assert.match(dumpFragment('#nope'), /not a "<version>/);
});

test('the second staff is dumped field by field', () => {
  const d = dumpFragment('#1.OgNGhGhKBwgBEgNEFEE');
  assert.match(d, /9 staff2 \(len\)/);
  assert.match(d, /1 clef \(varint\)[^\n]*: 1  BASS/);
  assert.match(d, /2 events \(len\)[^\n]*\n\s+\[0\] 0x\w{3} {2}quarter C3/);
});

test('v2: the voice is dumped as ops with the notes each one resolves to', () => {
  const t = tune('C4:q D4:q E4:q C4:q D4:q E4:q r:h');
  t.events[0].tones = [{ step: 2, oct: 4, alter: 1 }];
  const d = dumpFragment('#' + encode(t));
  assert.match(d, /Version: 2/);
  assert.match(d, /10 voice \(len\) @\d+: \d+ bytes/);
  assert.match(d, /7 events; flags: rests yes, accidentals yes, chords yes/);
  assert.match(d, /bits \d+–\d+ {2}note: same length, pitch -?\d+ steps, accidental per key, chord shape new \[\+2\]\n +\[0\] quarter C4 \+ E♯4/);
  assert.match(d, /\[6\] half rest/);
});

test('v2: a copy is shown with the shifted notes it expands to', () => {
  const t = tune('C4:e E4:e G4:e E4:e C4:e E4:e G4:e E4:e D4:e F4:e A4:e F4:e');
  const d = dumpFragment('#' + encode(t));
  assert.match(d, /copy: 4 back, length 3, shift 0 steps\n +\[5\] eighth E4\n +\[6\] eighth G4/);
  assert.match(d, /copy: 4 back, length 4, shift \+1 steps\n +\[8\] eighth D4/);
});

test('v2: the second staff is resolved with the first staff as history', () => {
  const t = { ...tune('C5:q D5:q E5:q F5:q'), staff2: { clef: 'bass', events: tune('C4:q D4:q E4:q F4:q').events } };
  const d = dumpFragment('#' + encode(t));
  assert.match(d, /9 staff2 \(len\)/);
  assert.match(d, /1 clef \(varint\)[^\n]*: 1 {2}BASS/);
  assert.match(d, /4 voice \(len\)[^\n]*\n +4 events;[^]*copy: \d+ back, length 4, shift -7 steps\n +\[0\] quarter C4/);
});

test('v2: a damaged voice says how much was decoded', () => {
  const full = encode(tune('C4:q D4:q E4:q F4:q G4:q A4:q B4:q C5:q'));
  const d = dumpFragment('#' + full.slice(0, -3));
  assert.match(d, /!! damaged: \d of 8 events decoded/);
});

test('v2: an accidental outside the key is named', () => {
  const d = dumpFragment('#' + encode(tune('F#4:q')));
  assert.match(d, /accidental ♯ \(outside key\)\n +\[0\] quarter F♯4/);
});

test('instrument field is named and decoded', () => {
  const d = dumpFragment('#' + encode({ ...tune(''), instrument: 'choir' }));
  assert.match(d, /11 instrument \(varint\) @\d+: 9  Choir/);
});
