// Small XML reader for MusicXML import. Pure JS so the same code runs in the browser and in node tests.
// Handles elements, attributes, text, entities, CDATA; skips comments, <?…?> and <!DOCTYPE>.
// Node shape: { name, attrs, kids: [node], text }.

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unescape = s => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) =>
  e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : +e.slice(1)) : ENT[e] ?? m);

export function parseXml(src) {
  const root = { name: '#root', attrs: {}, kids: [], text: '' }, stack = [root];
  let i = 0;
  const fail = msg => { throw new Error(`Not valid XML: ${msg}`); };
  while (i < src.length) {
    const lt = src.indexOf('<', i);
    const top = stack[stack.length - 1];
    if (lt < 0) { top.text += unescape(src.slice(i)); break; }
    if (lt > i) top.text += unescape(src.slice(i, lt));
    if (src.startsWith('<!--', lt)) { const e = src.indexOf('-->', lt); if (e < 0) fail('comment'); i = e + 3; continue; }
    if (src.startsWith('<![CDATA[', lt)) { const e = src.indexOf(']]>', lt); if (e < 0) fail('CDATA'); top.text += src.slice(lt + 9, e); i = e + 3; continue; }
    if (src[lt + 1] === '?') { const e = src.indexOf('?>', lt); if (e < 0) fail('processing instruction'); i = e + 2; continue; }
    if (src[lt + 1] === '!') {                                   // DOCTYPE, possibly with an internal [subset]
      let j = lt + 2, depth = 0;
      for (; j < src.length; j++) { if (src[j] === '[') depth++; else if (src[j] === ']') depth--; else if (src[j] === '>' && depth <= 0) break; }
      i = j + 1; continue;
    }
    const gt = src.indexOf('>', lt);
    if (gt < 0) fail('unclosed tag');
    if (src[lt + 1] === '/') {
      const name = src.slice(lt + 2, gt).trim();
      if (stack.length < 2 || top.name !== name) fail(`unexpected </${name}>`);
      stack.pop(); i = gt + 1; continue;
    }
    // Attribute values may contain '>', so scan the tag properly.
    const m = /^<([\w:.-]+)/.exec(src.slice(lt, lt + 200));
    if (!m) fail('bad tag');
    const node = { name: m[1], attrs: {}, kids: [], text: '' };
    const re = /\s*([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')|\s*(\/?)>/y;
    re.lastIndex = lt + m[0].length;
    let self = false;
    for (;;) {
      const a = re.exec(src);
      if (!a) fail(`bad tag <${node.name}>`);
      if (a[1]) node.attrs[a[1]] = unescape(a[3] ?? a[4]);
      else { self = a[5] === '/'; break; }
    }
    i = re.lastIndex;
    top.kids.push(node);
    if (!self) stack.push(node);
  }
  if (stack.length > 1) fail(`<${stack[stack.length - 1].name}> is never closed`);
  return root;
}

/** First child named `name` (or null). */
export const kid = (n, name) => n?.kids.find(k => k.name === name) || null;
export const kids = (n, name) => (n ? n.kids.filter(k => k.name === name) : []);
export const textOf = (n, name) => { const k = kid(n, name); return k ? k.text.trim() : null; };
/** Every descendant (depth-first). */
export function* walk(n) { for (const k of n.kids) { yield k; yield* walk(k); } }
