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

test('events and chords are unpacked into 12-bit codes', () => {
  const t = tune('C4:q r:h');
  t.events[0].tones = [{ step: 2, oct: 4, alter: 1 }];
  const d = dumpFragment('#' + encode(t));
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
