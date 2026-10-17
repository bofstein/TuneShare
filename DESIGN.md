# TuneShare design

This file holds the principles, the core design and the development guide.
It is the long-lived reference: update it when a decision changes.
Working notes and drafts go in `context/`, which is gitignored and local only.

## Principles

1. **The link is the document.** All tune state lives in the URL fragment.
   There is no backend, no account and no storage that a link depends on.
2. **Old links never break.** The URL format only grows. Changes add new
   fields, and existing fields keep their meaning (see [URL format](#url-format-v1)).
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
| Up to 20 measures | Lyrics; independent rhythms within one staff |
| Chords: up to 5 notes of the same length (an app limit, not a format limit) | Chords whose notes have different lengths |
| A second staff (planned: [#4](https://github.com/bofstein/TuneShare/issues/4)) | More than two staves |
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
- **Pitch is stored as the sounding pitch**: letter + octave + alteration
  (−1/0/+1). Written accidentals are worked out per measure when drawing.
  This means a note keeps its pitch when edits move it to another measure,
  and changing the key keeps the melody sounding the same.
- The key signature still guides entry: typing a letter, or moving a note
  with ↑/↓, uses the key's alteration for that letter.

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
  the time signature adds measures automatically if needed (up to 20).
- All edits are pure functions in `src/model.js` that return `{tune}` or
  `{error}`. The UI keeps undo history as snapshots.

## URL format (v1)

```
https://bofstein.github.io/TuneShare/#1.<base64url payload>
```

- State lives in the **hash fragment**. It is never sent to the server, and
  the app updates it with `history.replaceState` (never `pushState`, so Back
  leaves the app instead of stepping through edits).
- The leading `1.` is the container version. The payload is a
  **protobuf `Tune` message** (schema: `src/tune.proto`), encoded by a small
  hand-written codec in `src/codec.js`.
- Header fields are ordinary protobuf fields, left out when they are at their
  default. Readers skip unknown fields, so new features can be added as new
  field numbers without breaking links in either direction.
- **Notes are packed** into one `bytes` field at **12 bits per event**:
  3 bits of duration code and 9 bits of pitch code. That is 2 URL characters
  per note. A typical tune's link is about 100 characters, and the largest
  possible tune's is about 520.
- Pitch code: `0` = rest, otherwise `1 + (octave × 7 + step) × 3 + (alter + 1)`.
  Codes 211–511 are reserved.
- Duration codes: 0 = 16th, 1 = 8th, 2 = quarter, 3 = half, 4 = whole,
  5 = dotted 8th, 6 = dotted quarter, 7 = dotted half.
- **Chords** are field 8: `repeated Chord { uint32 index = 1; bytes tones = 2; }`.
  `index` is the event's position in the note list, and `tones` holds its
  extra pitches as 12-bit pitch codes (packed like the notes, duration bits
  zero). There is no limit on tones per chord. A reader that doesn't know
  field 8 skips it and shows each chord's main pitch, so the note list
  (field 7) never changes meaning.
- **Link length:** the app warns once when a link passes 2,000 characters,
  roughly what chat apps, email and QR codes handle reliably.
- **The decoder is lenient.** A damaged or truncated link still opens, keeping
  every complete note, and the app shows a "this link was damaged" toast.

**Rules for changing the format:**
- Never renumber a duration code, a pitch code or a field.
- Add new data as new fields, or in the reserved code space.
- Add every new format feature to the fixture tests in
  `tests/codec.test.js`. Fixture links must decode the same forever.
- Bump the `1.` prefix only if the container itself changes, and keep the old
  decoder when you do.

Why protobuf: it was the smallest of the encodings we measured that still
has a real schema. Ode to Joy is 92 characters, against 238 for compressed
JSON. Compression was left out because it doesn't shrink short tunes and it
breaks lenient decoding of truncated links.

## Rendering and audio

- **Notation is a custom SVG renderer**, not VexFlow or abcjs. The editor needs
  exact geometry for hit-testing and dragging, and the notation it draws is
  deliberately narrow.
  - `src/layout.js` (pure) turns a tune into positioned shapes plus hit-test
    geometry: splitting at bar lines, ties, beams, accidentals and spacing.
  - `src/render.js` turns that into SVG markup.
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
- **Sound** is synthesised with the Web Audio API: two oscillators, an envelope
  and a low-pass filter. There are no samples. Each note of a chord plays at
  1/√n volume, so chords don't clip. Playback is scheduled against
  the audio clock, and highlighting follows that same clock.

## UI principles

- **One toolbar, two jobs.** With nothing selected, the note toolbar sets the
  next note's length. With a note selected, the same buttons edit that note.
- **One mode.** A ghost note shows exactly where a click will insert. Click a
  note to select it; click empty staff to add a note.
- **Every action has a keyboard shortcut**, shown on the button or in its
  tooltip, and listed in the shortcut sheet (`?`). Letters are pitches,
  `1`–`5` are lengths (whole → 16th), and arrows move or change pitch.
  `Shift`+letter adds a note to the selected chord, and `Tab` moves between
  its notes.
- **Colours have fixed meanings:** the selection is indigo, the note playing
  is amber, and warnings are amber with a ⚠ icon. Colour is never the only
  signal. Light and dark themes follow the system setting.
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
src/codec.js, tune.proto   URL encode/decode
src/debug.js               Ctrl+D dump of the URL protobuf (pure)
src/layout.js, render.js   notation layout (pure) and SVG output
src/audio.js               synth voice and playback scheduler
src/store.js               current tune, cursor, undo, URL writes
src/main.js                controller: input, toolbar, toasts, wiring
tests/                     unit tests for codec, debug, model and layout
```

- State flows one way: input → model op → store → (URL, re-render).
- Keep modules that make decisions (`theory`, `model`, `codec`, `layout`) pure,
  with no DOM access, so they stay unit-testable.
- CI (`.github/workflows/test.yml`) runs `npm test` on every push and pull
  request.
- **Deployment:** GitHub Pages serves `main` from the repository root. The
  `.nojekyll` file stops Pages from running Jekyll.
