# TuneShare
Web app to create and share simple, short melodies through URLs.

Write up to 20 measures on a staff, play them back, and share the whole tune
as a link. The link *is* the document: everything is encoded in the URL
fragment, and there is no server.

## Using it

- Type `A`–`G` to add notes, `1`–`5` to pick a length (whole … 16th), `.` for a
  dot, `R` for a rest. `↑`/`↓` move the selected note a half step (`Ctrl`+`↑`/`↓` along the key's
  scale, `Shift` an octave); `←`/`→` move the selection.
- `Shift`+`A`–`G` stacks a note onto the selected one to make a chord (up to
  5 notes); `Tab` moves between a chord's notes.
- Or click the staff, or drag a note from the toolbar onto it.
- **Staves: 2** in the settings adds a second staff (bass clef by default) that
  plays along with the first. Click either staff, or press `Alt`+`↑`/`↓`, to
  write on it.
- **Copy link** shares the tune. Press `?` in the app for every shortcut.

## Development

Plain HTML, CSS and ES modules: no build step and no dependencies.

```sh
python3 -m http.server     # then open http://localhost:8000
npm test                   # unit tests
```

See [DESIGN.md](DESIGN.md) for the design principles, the URL format, the
code layout and the development guide.

Music glyphs: a subset of [Bravura](https://github.com/steinbergmedia/bravura)
(SIL Open Font License 1.1), renamed "TuneShare Glyphs" as the licence
requires. See `assets/fonts/OFL-Bravura.txt`.
