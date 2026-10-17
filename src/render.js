// Layout → SVG markup. Pure string building (no DOM), plus the overlay layer.
import { G } from './layout.js';

const f = n => (Math.round(n * 10) / 10).toString();

function item(it, fs) {
  switch (it.t) {
    case 'glyph': return `<text class="${it.cls}" x="${f(it.x)}" y="${f(it.y)}" font-size="${fs}">${it.g}</text>`;
    case 'line': return `<line class="${it.cls}" x1="${f(it.x1)}" y1="${f(it.y1)}" x2="${f(it.x2)}" y2="${f(it.y2)}"/>`;
    case 'rect': return `<rect class="${it.cls}" x="${f(it.x)}" y="${f(it.y)}" width="${f(it.w)}" height="${f(it.h)}"/>`;
    case 'halo': return `<rect class="halo" data-tone="${it.tone}" x="${f(it.x)}" y="${f(it.y)}" width="${f(it.w)}" height="${f(it.h)}" rx="${f(it.h / 2)}"/>`;
    case 'poly': return `<polygon class="${it.cls}" points="${it.pts.map(([x, y]) => `${f(x)},${f(y)}`).join(' ')}"/>`;
    case 'path': return `<path class="${it.cls}" d="${it.d}"/>`;
    case 'text': return `<text class="${it.cls}" x="${f(it.x)}" y="${f(it.y)}">${it.text}</text>`;
    default: return '';
  }
}

export function renderStaff(lay) {
  const fs = 4 * lay.sp;
  let out = lay.staff.map(i => item(i, fs)).join('');
  lay.events.forEach((evs, s) => {
    for (const [i, items] of evs) out += `<g class="ev" data-s="${s}" data-i="${i}">${items.map(it => item(it, fs)).join('')}</g>`;
  });
  out += `<g>${lay.implicit.map(i => item(i, fs)).join('')}</g><g>${lay.beams.map(i => item(i, fs)).join('')}</g>`;
  out += '<g class="overlay"></g>';
  return `<svg class="staff" viewBox="0 0 ${f(lay.width)} ${f(lay.height)}" width="${f(lay.width)}" height="${f(lay.height)}" aria-hidden="true">${out}</svg>`;
}

/**
 * Overlay: insert marker (or blinking caret), ghost note and optional tooltip.
 * @param o {{marker?:{k,s?,x,caret?}, ghost?:{k,s?,x,pos,ticks}, tip?:{text,sub}}}  s = staff (default 0)
 */
export function renderOverlay(lay, o) {
  const { sp, geo } = lay, fs = 4 * sp;
  let out = '';
  if (o.marker) {
    const yb = geo.yB(o.marker.k, o.marker.s || 0), x = o.marker.x;
    out += `<g class="${o.marker.caret ? 'caret' : ''}"><line class="marker" x1="${f(x)}" y1="${f(yb - 5.4 * sp)}" x2="${f(x)}" y2="${f(yb + 1.4 * sp)}"/>`
      + `<path class="marker-cap" d="M${f(x - 4)},${f(yb - 5.6 * sp)} h8 l-4,5z"/></g>`;
  }
  if (o.ghost) {
    const { k, x, pos, ticks } = o.ghost, st = o.ghost.s || 0, Y = (kk, q) => geo.Y(kk, q, st), y = Y(k, pos), hw = 1.18 * sp, up = pos < 4;
    const sx = up ? x + hw - 0.06 * sp : x + 0.06 * sp;
    let s = '';
    for (let q = -2; q >= pos; q -= 2) s += `<line class="ledger" x1="${f(x - 0.4 * sp)}" y1="${f(Y(k, q))}" x2="${f(x + hw + 0.4 * sp)}" y2="${f(Y(k, q))}"/>`;
    for (let q = 10; q <= pos; q += 2) s += `<line class="ledger" x1="${f(x - 0.4 * sp)}" y1="${f(Y(k, q))}" x2="${f(x + hw + 0.4 * sp)}" y2="${f(Y(k, q))}"/>`;
    if (o.ghost.rest) s += `<text x="${f(x)}" y="${f(Y(k, 4))}" font-size="${fs}">${G.rQ}</text>`;
    else {
      s += `<text x="${f(x)}" y="${f(y)}" font-size="${fs}">${ticks >= 16 ? G.nhW : ticks >= 8 ? G.nhH : G.nhB}</text>`;
      if (ticks < 16) {
        const tip = up ? y - 3.5 * sp : y + 3.5 * sp;
        s += `<line class="stem" x1="${f(sx)}" y1="${f(y)}" x2="${f(sx)}" y2="${f(tip)}"/>`;
        if (ticks <= 3) s += `<text x="${f(sx - 0.06 * sp)}" y="${f(tip)}" font-size="${fs}">${ticks === 1 ? (up ? G.f16u : G.f16d) : up ? G.f8u : G.f8d}</text>`;
      }
      if ([3, 6, 12].includes(ticks)) s += `<text x="${f(x + hw + 0.35 * sp)}" y="${f(pos % 2 === 0 ? y - sp / 2 : y)}" font-size="${fs}">${G.dot}</text>`;
    }
    out += `<g class="ghost">${s}</g>`;
    if (o.tip) {
      const w = Math.max(120, 7.2 * Math.max(o.tip.text.length, o.tip.sub.length) + 20);
      const bx = Math.max(2, x - w / 2 + hw / 2), by = geo.yB(k, st) - 8.4 * sp;
      out += `<g class="tip"><rect class="tipbox" x="${f(bx)}" y="${f(by)}" width="${f(w)}" height="${f(3.2 * sp)}" rx="7"/>`
        + `<text class="tiptext" x="${f(bx + 10)}" y="${f(by + 1.35 * sp)}">${o.tip.text}</text>`
        + `<text class="tipsub" x="${f(bx + 10)}" y="${f(by + 2.55 * sp)}">${o.tip.sub}</text></g>`;
    }
  }
  return out;
}
