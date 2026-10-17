import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildIcons } from '../scripts/build-icons.mjs';

// The PNG/ICO icons are generated from assets/logo.svg; run `npm run icons` after changing it.
test('generated icons match the master logo', () => {
  for (const [path, data] of Object.entries(buildIcons())) {
    assert.ok(readFileSync(new URL('../' + path, import.meta.url)).equals(data), `${path} is out of sync with assets/logo.svg: run npm run icons`);
  }
});

test('master logo is a single tight-cropped path', () => {
  const svg = readFileSync(new URL('../assets/logo.svg', import.meta.url), 'utf8');
  assert.equal((svg.match(/<path/g) || []).length, 1);
  assert.doesNotMatch(svg, /inkscape|sodipodi/);
});
