// Playback instruments. Every sound is synthesized with Web Audio at play time,
// so there are no sample files to license, download or wait for.
// The list order is the share-link enum (Tune field 11): only append, never reorder.

export const INSTRUMENTS = [
  { id: 'synth',   name: 'Soft synth' },   // index 0 in the share-link enum
  { id: 'piano',   name: 'Piano (Kawai KG-2A)' },
  { id: 'epiano',  name: 'Electric piano' },
  { id: 'guitar',  name: 'Acoustic guitar' },
  { id: 'eguitar', name: 'Electric guitar' },
  { id: 'violin',  name: 'Violin' },
  { id: 'trumpet', name: 'Trumpet' },
  { id: 'flute',   name: 'Flute' },
  { id: 'sax',     name: 'Saxophone' },
  { id: 'choir',   name: 'Choir' },
  { id: 'cello',   name: 'Cello' },
];

export const DEFAULT_INSTRUMENT = 'piano';
export const instrumentIndex = id => Math.max(0, INSTRUMENTS.findIndex(x => x.id === id));
export const instrumentName = id => INSTRUMENTS[instrumentIndex(id)].name;
