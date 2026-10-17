// Generates the raster icons from the master logo (assets/logo.svg). Never edit the outputs by hand.
//   node scripts/build-icons.mjs          write the files
//   import { buildIcons }                 used by tests/icons.test.js to check they are in sync
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { flatten, fill, png } from './svgpath.mjs';

const root = new URL('../', import.meta.url);
const TILE = [244, 243, 255];   // light tile so the dark logo reads on dark browser chrome too
const INK = [0x23, 0x1e, 0x56];

function render(svg, size) {
  const [vx, vy, vw, vh] = svg.match(/viewBox="([^"]+)"/)[1].split(/\s+/).map(Number);
  const d = svg.match(/\sd="([^"]+)"/)[1];
  const buf = new Uint8ClampedArray(size * size * 4);
  const r = size * 0.22, pad = size * 0.2, s = (size - 2 * pad) / Math.max(vw, vh);
  fill(buf, size, [roundRect(size, r)], p => p, TILE);
  const ox = pad + ((size - 2 * pad) - vw * s) / 2, oy = pad + ((size - 2 * pad) - vh * s) / 2;
  fill(buf, size, flatten(d), ([x, y]) => [(x - vx) * s + ox, (y - vy) * s + oy], INK);
  return png(buf, size);
}

function roundRect(s, r) {
  const pts = [];
  for (const [cx, cy, a0] of [[s - r, r, -90], [s - r, s - r, 0], [r, s - r, 90], [r, r, 180]])
    for (let k = 0; k <= 8; k++) { const a = (a0 + k * 90 / 8) * Math.PI / 180; pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]); }
  return pts;
}

function ico(images) {   // PNG-in-ICO
  const head = Buffer.alloc(6 + 16 * images.length);
  head.writeUInt16LE(1, 2); head.writeUInt16LE(images.length, 4);
  let off = head.length;
  images.forEach(([size, data], i) => {
    const o = 6 + 16 * i;
    head[o] = head[o + 1] = size; head.writeUInt16LE(1, o + 4); head.writeUInt16LE(32, o + 6);
    head.writeUInt32LE(data.length, o + 8); head.writeUInt32LE(off, o + 12); off += data.length;
  });
  return Buffer.concat([head, ...images.map(i => i[1])]);
}

export function buildIcons(svg = readFileSync(new URL('assets/logo.svg', root), 'utf8')) {
  return {
    'assets/apple-touch-icon.png': render(svg, 180),
    'favicon.ico': ico([16, 32, 48].map(n => [n, render(svg, n)])),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const [path, data] of Object.entries(buildIcons())) writeFileSync(new URL(path, root), data);
  console.log('icons written');
}
