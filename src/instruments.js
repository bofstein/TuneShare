// Playback instruments. Every sound is synthesized with Web Audio at play time,
// so there are no sample files to license, download or wait for.
// The list order is the share-link enum (Tune field 11): only append, never reorder.

export const INSTRUMENTS = [
  { id: 'synth',   name: 'Soft synth', gm: 80 },   // index 0 in the share-link enum
  { id: 'piano',   name: 'Piano (Kawai KG-2A)', gm: 0 },
  { id: 'epiano',  name: 'Electric piano', gm: 4 },
  { id: 'guitar',  name: 'Acoustic guitar', gm: 24 },
  { id: 'eguitar', name: 'Electric guitar', gm: 27 },
  { id: 'violin',  name: 'Violin', gm: 40 },
  { id: 'trumpet', name: 'Trumpet', gm: 56 },
  { id: 'flute',   name: 'Flute', gm: 73 },
  { id: 'sax',     name: 'Saxophone', gm: 65 },
  { id: 'choir',   name: 'Choir', gm: 52 },
  { id: 'cello',   name: 'Cello', gm: 42 },
];

// General MIDI program (0-based) → instrument, for MusicXML import: [first program of a range, id].
// Each instrument's own `gm` above is what MusicXML export writes.
const GM_RANGES = [[0, 'piano'], [4, 'epiano'], [8, 'piano'], [16, 'synth'], [24, 'guitar'], [26, 'eguitar'],
  [40, 'violin'], [42, 'cello'], [44, 'violin'], [46, 'guitar'], [47, 'piano'], [48, 'violin'], [52, 'choir'],
  [56, 'trumpet'], [64, 'sax'], [72, 'flute'], [80, 'synth'], [104, 'guitar'], [112, 'piano']];
export const instrumentFromGm = prog => GM_RANGES.filter(([p]) => p <= prog).pop()?.[1] || 'piano';

export const DEFAULT_INSTRUMENT = 'piano';
export const instrumentIndex = id => Math.max(0, INSTRUMENTS.findIndex(x => x.id === id));
export const instrumentName = id => INSTRUMENTS[instrumentIndex(id)].name;
