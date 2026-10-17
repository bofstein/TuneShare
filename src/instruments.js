// Playback instruments. Every sound is synthesized with Web Audio at play time,
// so there are no sample files to license, download or wait for.
// The list order is the share-link enum (Tune field 11): only append, never reorder.

export const INSTRUMENTS = [
  { id: 'synth',   name: 'Soft synth' },   // the original sound, default
  { id: 'piano',   name: 'Piano' },
  { id: 'epiano',  name: 'Electric piano' },
  { id: 'guitar',  name: 'Acoustic guitar' },
  { id: 'eguitar', name: 'Electric guitar' },
  { id: 'violin',  name: 'Violin' },
  { id: 'trumpet', name: 'Trumpet' },
  { id: 'flute',   name: 'Flute' },
  { id: 'sax',     name: 'Saxophone' },
  { id: 'choir',   name: 'Choir' },
];

export const DEFAULT_INSTRUMENT = 'synth';
export const instrumentIndex = id => Math.max(0, INSTRUMENTS.findIndex(x => x.id === id));
export const instrumentName = id => INSTRUMENTS[instrumentIndex(id)].name;
