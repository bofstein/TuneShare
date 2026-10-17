// Minimal path flattener and rasteriser (m/l/c/z, absolute or relative) for the logo.
// Enough to turn assets/logo.svg into PNGs without any dependency.
import { deflateSync } from 'node:zlib';

export function flatten(d) {
  const toks = d.match(/[a-zA-Z]|-?\d*\.?\d+(?:e-?\d+)?/g);
  const polys = [];
  let cur = null, x = 0, y = 0, sx = 0, sy = 0, cmd = '', i = 0;
  const num = () => parseFloat(toks[i++]);
  while (i < toks.length) {
    if (/[a-zA-Z]/.test(toks[i])) cmd = toks[i++];
    const rel = cmd === cmd.toLowerCase(), C = cmd.toLowerCase();
    if (C === 'z') { if (cur) polys.push(cur); cur = null; x = sx; y = sy; continue; }
    if (C === 'm') {
      if (cur) polys.push(cur);
      x = num() + (rel ? x : 0); y = num() + (rel ? y : 0); sx = x; sy = y; cur = [[x, y]];
      cmd = rel ? 'l' : 'L';
    } else if (C === 'l') {
      x = num() + (rel ? x : 0); y = num() + (rel ? y : 0); cur.push([x, y]);
    } else if (C === 'c') {
      const o = rel ? [x, y] : [0, 0];
      const p = [[x, y], [num() + o[0], num() + o[1]], [num() + o[0], num() + o[1]], [num() + o[0], num() + o[1]]];
      for (let k = 1; k <= 16; k++) {
        const t = k / 16, u = 1 - t;
        cur.push([0, 1].map(j => u * u * u * p[0][j] + 3 * u * u * t * p[1][j] + 3 * u * t * t * p[2][j] + t * t * t * p[3][j]));
      }
      [x, y] = p[3];
    } else throw new Error('unsupported path command ' + cmd);
  }
  if (cur) polys.push(cur);
  return polys;
}

export function bbox(polys) {
  const pts = polys.flat();
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

// Draws polys (nonzero fill) into an RGBA buffer, 4x4 supersampled. `map` maps svg coords to pixels.
export function fill(buf, size, polys, map, rgb) {
  const SS = 4, n = size * SS, cov = new Float32Array(size * size);
  for (let sy = 0; sy < n; sy++) {
    const yy = (sy + 0.5) / SS, xs = [];
    for (const poly of polys) {
      for (let k = 0; k < poly.length; k++) {
        const a = map(poly[k]), b = map(poly[(k + 1) % poly.length]);
        if ((a[1] <= yy) !== (b[1] <= yy)) xs.push([a[0] + (yy - a[1]) / (b[1] - a[1]) * (b[0] - a[0]), b[1] > a[1] ? 1 : -1]);
      }
    }
    xs.sort((p, q) => p[0] - q[0]);
    let w = 0;
    for (let k = 0; k < xs.length - 1; k++) {
      w += xs[k][1];
      if (!w) continue;
      for (let sx = Math.max(0, Math.ceil(xs[k][0] * SS - 0.5)); sx < Math.min(n, Math.ceil(xs[k + 1][0] * SS - 0.5)); sx++) cov[Math.floor(sy / SS) * size + Math.floor(sx / SS)] += 1 / (SS * SS);
    }
  }
  for (let p = 0; p < size * size; p++) {
    const a = Math.min(1, cov[p]); if (!a) continue;
    for (let c = 0; c < 3; c++) buf[p * 4 + c] = Math.round(rgb[c] * a + buf[p * 4 + c] * (1 - a));
    buf[p * 4 + 3] = Math.round(255 * (a + (buf[p * 4 + 3] / 255) * (1 - a)));
  }
}

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = b => { let c = ~0; for (const v of b) c = crcTable[(c ^ v) & 255] ^ (c >>> 8); return ~c >>> 0; };
export function png(buf, size) {
  const chunk = (t, d) => { const o = Buffer.alloc(12 + d.length); o.writeUInt32BE(d.length, 0); o.write(t, 4); d.copy(o, 8); o.writeUInt32BE(crc(o.subarray(4, 8 + d.length)), 8 + d.length); return o; };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let r = 0; r < size; r++) Buffer.from(buf.buffer, r * size * 4, size * 4).copy(raw, r * (size * 4 + 1) + 1);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
