# wasm-media-encoders 0.7.0 (vendored)

From https://www.npmjs.com/package/wasm-media-encoders (https://github.com/arseneyr/wasm-media-encoders).

- `index.mjs` is `dist/esnext/index.mjs` with the two inlined base64 WASM binaries replaced by `""`,
  so the app loads only `mp3.wasm` (via `createEncoder('audio/mpeg', url)`) and never the Ogg encoder.
- `mp3.wasm` is `wasm/mp3.wasm`, unmodified.

The JavaScript wrapper is MIT licensed (see `LICENSE`). `mp3.wasm` is the LAME MP3 encoder
(https://lame.sourceforge.io), which is licensed under the GNU LGPL 2.0 or later. It is shipped here as a
separate, unmodified file that the page loads at run time, and can be replaced with any compatible build.
Source: https://github.com/arseneyr/wasm-media-encoders/tree/v0.7.0 and https://sourceforge.net/projects/lame/files/lame/3.100/.
