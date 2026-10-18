# TuneShare design

This file holds the principles, the core design and the development guide.
It is the long-lived reference: update it when a decision changes.
Working notes and drafts go in `context/`, which is gitignored and local only.

## Principles

1. **The link is the document.** All tune state lives in the URL fragment.
   There is no backend, no account and no storage that a link depends on.
2. **Old links never break.** The URL format only grows. Changes add new
   fields, and existing fields keep their meaning (see [URL format](#url-format-v2)).
3. **Simple over complete.** TuneShare is a tool for sharing short music, not
   a notation suite. When a feature competes with clarity, clarity wins.
   Richer music (chords, a second staff) is welcome as long as a first-time
   user can still enter a plain melody without meeting it.
4. **No build, no dependencies.** Plain HTML, CSS and native ES modules,
   served as-is by GitHub Pages. Tests use Node's built-in `node:test`.
5. **Edits never destroy work silently.** An edit that would lose notes is
   rejected with a toast that explains how to make room.

## Scope

| In | Out (for now) |
| --- | --- |
| Up to 96 measures | Lyrics; independent rhythms within one staff |
| Chords: up to 5 notes of the same length (an app limit, not a format limit) | Chords whose notes have different lengths |
| A second staff, played together with the first, with its own clef | More than two staves |
| Treble and bass clef; all 15 key signatures | Changing key, clef or tempo partway through |
| 2/4, 3/4, 4/4, 6/8 | Other time signatures (they can be added later without breaking links) |
| Whole to 16th notes; dotted half, quarter and 8th; rests | Triplets, 32nds, dotted 16ths, user-entered ties and slurs |
| Sharps, flats, naturals | Double sharps and flats |
| Tempo 40–240 BPM (quarter-note beat), title up to 60 chars | Dynamics, articulations, repeats, instrument choice |
| Playback with loop, undo/redo, copy link | MIDI/MusicXML import or export, server storage |

## Data model

- **Time is counted in ticks**, where 1 tick = one 16th note. Every duration
  is a whole number of ticks.
- **A tune is a flat list of events** (notes and rests). Measures are not
  containers: bar lines are worked out from the time signature. A note that
  crosses a bar line is still one event, and it is *drawn* as tied notes.
- **Capacity** = measures × ticks per measure. The events fill the timeline
  from the start, and anything after them is implicit silence, which is
  drawn as faint rests and never stored.
- **Chords:** a note event may carry extra pitches (`tones`) that share its
  length, so chords don't change any timing rule. The main pitch is the one
  entered first. The limit, `MAX_CHORD_NOTES` in `src/model.js` (5), is an
  editor setting: the URL format allows any number, so the limit can be
  raised without breaking links. Two notes can't share a line or space.
- **Second staff:** `tune.staff2 = {clef, events}`, absent for one staff.
  The first staff stays in `tune.clef` and `tune.events`, so one-staff code
  and links are unchanged. Both staves share every other header field
  (key, time, tempo, measures), so they have the same capacity, and each
  staff's events fill the timeline independently. Edit ops work on one staff
  through a *view* (`staffView`: the tune with that staff's clef and events)
  and `withStaffView` writes the result back. Measure and time changes look
  at both staves. A staff can be removed only if it holds nothing but rests.
- **Pitch is stored as the sounding pitch**: letter + octave + alteration
  (−1/0/+1). Written accidentals are worked out per measure when drawing.
  This means a note keeps its pitch when edits move it to another measure,
  and changing the key keeps the melody sounding the same.
- The key signature still guides entry: typing a letter, or moving a note
  along the scale with `Ctrl`+`↑`/`↓`, uses the key's alteration for that letter.
- `↑`/`↓` move a half step (`halfStep` in `theory.js`). The result is spelled
  as a note of the key's scale if it is one, else as a natural, else as a sharp
  going up or a flat going down; a note is never double-sharped or double-flatted.

### Editing rules

- **Every timing edit ripples.** Insert, delete and changing a length all
  move the events after them. To keep timing and leave a gap, turn a note
  into a rest (`R`).
- **Overflow:** when an edit makes the tune longer than its capacity, the
  excess is trimmed from the end, using implicit silence first and then
  trailing rests (shortening a rest if needed). If a **note** would be pushed
  off the end, the edit is **rejected** and a toast offers "Add measure".
- Clicking past the end of the content pads with rests, so the note lands
  where the ghost note showed it.
- Removing a measure is allowed only if it holds nothing but rests. Changing
  the time signature adds measures automatically if needed (up to `MAX_MEASURES`, 96).
- All edits are pure functions in `src/model.js` that return `{tune}` or
  `{error}`. The UI keeps undo history as snapshots.

## URL format (v2)

```
https://bofstein.github.io/TuneShare/#2.<base64url payload>
```

- State lives in the **hash fragment**. It is never sent to the server, and
  the app updates it with `history.replaceState` (never `pushState`, so Back
  leaves the app instead of stepping through edits).
- The leading `2.` is the container version. The payload is a
  **protobuf `Tune` message** (schema: `src/tune.proto`), encoded by a small
  hand-written codec in `src/codec.js`. The notes of each staff are one
  `bytes` field holding a bit stream, the **voice** (`src/voice.js`, below).
- Header fields are ordinary protobuf fields, left out when they are at their
  default. Readers skip unknown fields, so new features can be added as new
  field numbers without breaking links in either direction.
- Header fields: `title = 1`, `bpm = 2`, `key = 3` (zigzag), `clef = 4`
  (1 = bass), `time = 5` (index into 4/4, 3/4, 2/4, 6/8), `measures = 6`,
  `instrument = 11` (index into `INSTRUMENTS`; absent = Soft synth; an unknown
  index falls back to the default).
  `voice = 10` is the first staff. `staff2 = 9` is
  `Staff { Clef clef = 1; bytes voice = 4; }`; its presence, even with no
  notes, means the tune has two staves.
- **Old links keep working.** `1.` links (12-bit events in field 7, chords in
  field 8, second staff with fields 2 and 3) are still read by the same
  decoder, and the app rewrites them as `2.` links as soon as it loads one
  that isn't damaged. A link with a higher version than the code (a stale
  tab meeting a newer link) makes the app reload once to fetch the new code;
  if the link is still newer, it shows a "newer version" notice with a Reload
  button.
- **Link length:** a typical tune is 40–120 characters, about 3 times shorter
  than the same tune in v1. The app warns once when a link passes 2,000
  characters, roughly what chat apps, email and QR codes handle reliably.
- **Measure limit:** `MAX_MEASURES` (96) is the one place the cap is set; the
  voice's event limit (16 sixteenths per 4/4 measure) follows from it. Why 96:
  a through-composed two-staff tune costs about 6–7 link characters per
  measure (96 measures: about 690), a busy piano piece about 14 (about 1,350),
  a dense non-repeating 16th-note piece with chords on both staves about 33
  (about 3,300, so the long-link warning shows past roughly 56 bars), and only
  deliberately incompressible input (random 16ths with 5-note chords) goes past
  2,000 characters at any length. Typical song forms are 8–32 bars; 96 is three
  32-bar forms and divides into whole systems at 2, 3 and 4 bars per line.
  Editing swaps only the systems whose markup changed (see "Rendering"), which
  keeps an in-place edit of the densest 96-bar tune near 100 ms and a ripple
  edit (one that moves everything after it) under 300 ms. Past about 128 bars
  a dense ripple edit passes 400 ms.
- **The decoder is lenient.** A damaged or truncated link still opens, keeping
  every complete note, and the app shows a "this link was damaged" toast.

### The voice

A voice is an event list (notes and rests, chords as extra tones). It is
written as a bit stream, most significant bit first, padded with zeros.
Numbers are **Exp-Golomb**: `n ≥ 0` is written as `n + 1` in binary, with one
fewer leading zeros than it has bits (0 = `1`, 1 = `010`, 2 = `011`, 3 = `00100`).
A signed number is zigzagged first (0, −1, 1, −2, … → 0, 1, 2, 3, …).

```
count            Exp-Golomb   number of events (≤ 1536: 96 measures of 4/4 in 16ths)
flags            3 bits       the voice uses rests / accidentals outside the key / chords
then items until `count` events are covered, each one of:

literal   1                                   one event
          [rest bit]                          only if the rests flag is set
          0 | 1 + 3-bit duration              0 = same length as the previous event (quarter at the start)
          (a rest ends here)
          signed Exp-Golomb                   scale steps from the previous note (see below)
          [accidental]                        only if the accidentals flag is set
          [chord]                             only if the chords flag is set

copy      0                                   events copied from earlier in the voice
          Exp-Golomb dist - 1                 how far back the first copied event is
          Exp-Golomb len - 2
          signed Exp-Golomb shift             added to every copied pitch, in scale steps
```

- **Pitch** is counted in scale steps from C0 (octave × 7 + letter). A note's
  distance is measured from the previous note's pitch (after a copy, from the
  last copied note), starting at B4 in treble clef and D3 in bass clef. Rests
  don't move it. A pitch outside C0–B9 is invalid.
- **Accidental:** `0` = the key signature's alteration for that letter, else
  `1` followed by one bit choosing between the other two alterations, in the
  order ♭, ♮, ♯ with the key's own left out. So F♯ in G major costs one bit,
  and a tune that never leaves its key costs nothing (flag off).
- **Chord:** one bit, `0` = a single note. `1` is followed by an Exp-Golomb
  number `k`. `k = 0` is a new shape: the tone count − 1, then each tone as a
  signed step distance from the previous tone (the first from the note) plus
  an accidental. `k ≥ 1` reuses shape `k` of the 8 most recently used shapes
  (1 = the latest; a reused or new shape moves to the front). There is no
  limit on tones per chord.
- **Copies** make a repeated bar or a sequence cost a few bits. They may copy
  a rest and may overlap themselves (distance 1 is a run of one note). A copy
  keeps durations, accidentals and chord shape and moves only the pitch, so a
  bar of accompaniment reused over a new chord is one copy with a shift.
- **The second staff may copy from the first**, as if the first staff's events
  came before its own. This makes a canon or an octave doubling nearly free.
- The encoder picks copies greedily (the longest, then the cheapest), only
  where a copy is cheaper than 8 bits per event.
- The codec works in four steps so tools can show each: `planVoice` (events →
  ops), `writeVoice` (ops → bytes), `parseVoice` (bytes → ops, syntax only) and
  `resolveVoice` (ops → events, with every copy and shift worked out). The
  Ctrl+D dump prints the ops with their bit ranges and the notes each one
  becomes.
- Duration codes: 0 = 16th, 1 = 8th, 2 = quarter, 3 = half, 4 = whole,
  5 = dotted 8th, 6 = dotted quarter, 7 = dotted half.

**Rules for changing the format:**
- Never renumber a duration code, a field, or a bit in the voice.
- Add new data as new fields. Keep reading every older version.
- Add every new format feature to the fixture tests in
  `tests/codec.test.js` and `tests/voice.test.js`. Fixture links must decode
  the same forever.
- Bump the `2.` prefix only if the container or the voice itself changes, and
  keep the old decoder when you do.

Why this format: protobuf for the header gives a real schema and free
extension, and the voice drops protobuf's tags where every byte counts. Across
17 sample tunes (well-known melodies and generated accompaniment patterns),
v2 links are 63% shorter than v1 (1,984 characters against 5,339 in total);
a hymn with a chord on every note went from 873 to 80. Deflate was left out
because it doesn't shrink short tunes, makes decoding async, and breaks
lenient decoding of truncated links.

## Rendering and audio

- **Notation is a custom SVG renderer**, not VexFlow or abcjs. The editor needs
  exact geometry for hit-testing and dragging, and the notation it draws is
  deliberately narrow.
  - `src/layout.js` (pure) turns a tune into positioned shapes plus hit-test
    geometry: splitting at bar lines, ties, beams, accidentals and spacing.
  - `src/render.js` turns that into SVG markup.
- **Edits redraw one system at a time.** `renderSystems` returns the staff as
  one markup string per system (one line of 2–4 bars). The app replaces only
  the systems whose string changed, so a note edited in one line leaves the
  rest of the page's elements alone. Building and styling the whole staff is
  what made edits slow in long dense tunes: on a dense 64-bar, two-staff tune
  it took about 300 ms against about 90 ms now. An edit that moves everything
  after it still redraws every later system. An event that crosses a line break
  (a tie) is drawn as one `.ev` group in each system.
- **Two staves** are drawn as a grand staff: a brace, and bar lines through
  both. Spacing is shared, so notes that sound together line up.
- **Chords** stack on one stem. Notes a second apart sit on opposite sides of
  the stem, accidentals stagger into columns (a column holds accidentals at
  least a sixth apart), and a tied chord ties every note.
- **Spacing is time-proportional**, plus a fixed allowance in front of each
  note for every accidental column it needs. Pointer position therefore maps directly to
  ticks, and the layout doesn't jump while you edit.
- **Music glyphs** come from a 34-glyph subset of Bravura (SIL OFL 1.1), about
  9 KB. The OFL reserves the name "Bravura" for the unmodified font, so the
  subset is renamed "TuneShare Glyphs". The licence is in
  `assets/fonts/OFL-Bravura.txt`.
- **Sound** is synthesised with the Web Audio API; there are no external samples,
  so nothing to license, download or wait for. One instrument plays the whole
  tune (`src/instruments.js` lists them, including Cello at index 10; `src/audio.js`
  synthesises and caches each pitch). Every `(instrument, midi)` note is rendered
  once at 32 kHz into a cached `AudioBuffer` (`warmTune` pre-warms the notes of
  the loaded tune on idle ticks, and `Player` schedules via an unthrottled Web
  Worker ticker and a 2.0 s rolling lookahead window so playback continues smoothly
  even when the tab is in the background). Piano (voiced after a warm Kawai grand
  with multi-stage hammer-felt strike physics, two-stage soundboard decay, inharmonicity and
  duplex bloom, calibrated after the user's Kawai KG-2A 5'10" grand as default, plus
  optional Kawai RX/GX and Yamaha C5 voicings)
  and electric piano are percussive additive buffers; violin, cello, acoustic
  guitar (warm fingertip flesh pluck and spruce/rosewood body tap) and electric
  guitar (snappy plectrum pick with dynamic asymmetric tube-amp overdrive and
  speaker cabinet roll-off) model physical string selection (`OPEN_STRINGS`),
  stopping-ratio comb shifting, and sympathetic coupling of unselected open
  strings; sustained voices (violin and cello with initial stick-slip bow "grab",
  expressive ~5.6 Hz vibrato, FM-to-AM body-resonance shimmer and phrase-start
  vs. legato slur articulation, trumpet, flute, sax, a 16-singer SATB choir with
  staggered entrances, open *"ahhh"* vowel formants and glottal breath turbulence,
  and synth) loop seamlessly across a crossfaded window using 1 kHz control-rate
  envelope/phasor factorization. Both the cached buffers and runtime `GainNode`s
  apply smooth S-curve/linear amplitude shaping at note onset and release so
  attacks and damping are completely click-free. Piano also applies phrase-aware
  sustain (`phraseSustainTicks`) so broken chords and bass notes ring across
  harmonic phrases until a rest, bar/half-bar boundary, repeated pitch or
  scale-step clash. Each note of a chord plays at 1/√n volume through a room
  convolver and compressor.

## UI principles

- **One toolbar, two jobs.** With nothing selected, the note toolbar sets the
  next note's length. With a note selected, the same buttons edit that note.
- **One mode.** A ghost note shows exactly where a click will insert. Click a
  note to select it; click empty staff to add a note.
- **Every action has a keyboard shortcut**, shown on the button or in its
  tooltip, and listed in the shortcut sheet (`?`). Letters are pitches,
  `1`–`5` are lengths (whole → 16th), and arrows move or change pitch
  (`↑`/`↓` a half step, `Ctrl`+`↑`/`↓` along the key's scale, `Shift` an octave).
  `Shift`+letter adds a note to the selected chord, and `Tab` moves between
  its notes. `Alt`+`↑`/`↓` moves to the other staff at the same beat.
- **The cursor belongs to one staff** (the active staff). Typing and the
  clef setting apply to it; clicking a staff makes it active.
- **Colours have fixed meanings:** the selection is indigo, the note playing
  is amber, and warnings are amber with a ⚠ icon. Colour is never the only
  signal. Light and dark themes follow the system setting until the user
  picks one with the header toggle; that choice is kept in `localStorage`
  (not in the link, since it is a viewer preference, not part of the tune).
- **Phones** show 2 measures per line, with the note toolbar fixed to the
  bottom in two rows of 44 px buttons.

## Development

```sh
python3 -m http.server     # then open http://localhost:8000
npm test                   # unit tests (node:test, no install needed)
```

```
index.html, styles.css     app shell and styles
src/theory.js              durations, keys, pitch math
src/model.js               pure edit operations and the overflow rule
src/position.js            pure geometric & hit-test calculations for notation layout
src/editor.js              pure note editing actions, cursor math & state querying
src/ui-format.js           pure UI string and accessibility formatting helpers
src/codec.js, tune.proto   URL encode/decode (container, v1 reader)
src/voice.js               the v2 voice bit stream: plan, write, parse, resolve
src/debug.js               Ctrl+D dump of the URL protobuf (pure)
src/layout.js, render.js   notation layout (pure) and SVG output
src/audio.js               synth voice and playback scheduler
src/store.js               current tune, cursor, undo, URL writes
src/toast.js               toast notifications and error handling
src/dialogs.js             modal sheets, popovers, sharing, MusicXML export
src/gestures.js            pointer interactions and drag handlers
src/keyboard.js            keyboard shortcut dispatcher
src/main.js                controller: orchestrator wiring store, DOM, and playback
tests/                     unit tests for codec, voice, debug, model, layout, editor, position, format
```

- State flows one way: input → model op → store → (URL, re-render).
- Keep modules that make decisions (`theory`, `model`, `position`, `editor`, `ui-format`, `codec`, `voice`, `layout`) pure,
  with no DOM access, so they stay unit-testable.
- CI (`.github/workflows/test.yml`) runs `npm test` on every push and pull
  request.
- **Deployment:** GitHub Pages serves `main` from the repository root. The
  `.nojekyll` file stops Pages from running Jekyll.
