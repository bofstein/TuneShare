// Ctrl+D debug view: a field-by-field dump of the protobuf in a URL fragment.
// Walks the raw wire format (like `protoc --decode_raw`), so unknown or
// malformed fields show up too, then names known fields from src/tune.proto.
// Pure, no DOM.
import { fromB64, unpack12, codeEvent } from './codec.js';
import { parseVoice, resolveVoice } from './voice.js';
import { DUR_NAME, LETTERS, TIMES } from './theory.js';

const WIRE = ['varint', 'i64', 'len', 'sgroup', 'egroup', 'i32'];
const FIELDS = {
  1: 'title', 2: 'bpm', 3: 'key', 4: 'clef', 5: 'time', 6: 'measures', 7: 'events', 8: 'chord', 9: 'staff2',
};
const CHORD_FIELDS = { 1: 'index', 2: 'tones' };
const STAFF_FIELDS = { 1: 'clef', 2: 'events', 3: 'chord' };
// v2 links: the note data is one bit-stream "voice" per staff (src/voice.js).
const FIELDS_V2 = { 1: 'title', 2: 'bpm', 3: 'key', 4: 'clef', 5: 'time', 6: 'measures', 9: 'staff2', 10: 'voice' };
const STAFF_FIELDS_V2 = { 1: 'clef', 4: 'voice' };

const hex = bytes => bytes.map(b => b.toString(16).padStart(2, '0')).join(' ');
const pitchName = p => LETTERS[p.step] + (['♭', '', '♯'][p.alter + 1]) + p.oct;

/** Describe one 12-bit event code, or a chord tone code (pitch only, no duration). */
export function describeCode(c, tone = false) {
  const e = codeEvent(c);
  const code = '0x' + c.toString(16).padStart(3, '0');
  if (!e) return `${code}  invalid`;
  if (tone) return `${code}  ${e.rest ? 'invalid (no pitch)' : pitchName(e)}`;
  return `${code}  ${DUR_NAME[e.dur] ?? `dur ${e.dur}`} ${e.rest ? 'rest' : pitchName(e)}`;
}

const sign = n => (n > 0 ? '+' : '') + n;
const describeEvent = e => `${DUR_NAME[e.dur]} ${e.rest ? 'rest' : [e, ...(e.tones || [])].map(pitchName).join(' + ')}`;
const ALT_SYMBOL = ['♭', '♮', '♯'];

/** Dump one v2 voice: header flags, then each op with the events it resolves to. */
export function voiceLines(bytes, key, clef, history, indent) {
  const parsed = parseVoice(bytes);
  const { events, spans, repaired } = resolveVoice(parsed, key, clef, history);
  const f = parsed.flags;
  const lines = [`${indent}${parsed.count} events; flags: rests ${f.rest ? 'yes' : 'no'}, accidentals ${f.alt ? 'yes' : 'no'}, chords ${f.chords ? 'yes' : 'no'}`];
  for (const { op, from, to } of spans) {
    const bits = `bits ${op.bit}–${op.end - 1}`;
    if (op.op === 'copy') lines.push(`${indent}${bits}  copy: ${op.dist} back, length ${op.len}, shift ${sign(op.shift)} steps`);
    else {
      const dur = op.dur === undefined ? 'same length' : DUR_NAME[op.dur];
      const chord = !op.chord ? '' : op.chord.hit !== undefined ? `, chord shape #${op.chord.hit} reused` : ', chord shape new';
      const shape = op.chord ? ` [${op.chord.tones.map(t => sign(t.delta)).join(' ')}]` : '';
      const alter = events[from]?.alter;
      const accidental = op.alt === 0 ? 'per key' : alter === undefined ? 'outside key' : `${ALT_SYMBOL[alter + 1]} (outside key)`;
      lines.push(op.rest
        ? `${indent}${bits}  rest: ${dur}`
        : `${indent}${bits}  note: ${dur}, pitch ${sign(op.delta)} steps, accidental ${accidental}${chord}${shape}`);
    }
    events.slice(from, to).forEach((e, k) => lines.push(`${indent}    [${from + k}] ${describeEvent(e)}`));
  }
  if (repaired || events.length < parsed.count) lines.push(`${indent}!! damaged: ${events.length} of ${parsed.count} events decoded (read ${parsed.bits} of ${bytes.length * 8} bits)`);
  return { lines, events };
}

/** Split bytes into [{field, wire, value | bytes, offset}]; stops with an error entry on bad input. */
export function walk(bytes) {
  const out = [];
  let i = 0;
  const varint = () => {
    let v = 0, shift = 0;
    while (i < bytes.length) {
      const b = bytes[i++];
      v += (b & 127) * 2 ** shift; shift += 7;
      if (!(b & 128)) return v;
      if (shift > 63) break;
    }
    throw new Error('truncated varint');
  };
  while (i < bytes.length) {
    const offset = i;
    try {
      const key = varint(), field = Math.floor(key / 8), wire = key & 7;
      if (wire === 0) out.push({ offset, field, wire, value: varint() });
      else if (wire === 1 || wire === 5 || wire === 2) {
        const len = wire === 1 ? 8 : wire === 5 ? 4 : varint();
        const chunk = bytes.slice(i, i + len);
        i += len;
        out.push({ offset, field, wire, bytes: chunk, ...(chunk.length < len && { error: `truncated: ${chunk.length}/${len} bytes` }) });
      } else throw new Error(`unsupported wire type ${wire}`);
    } catch (err) {
      out.push({ offset, error: `${err.message} at byte ${offset}; ${bytes.length - offset} bytes left: ${hex(bytes.slice(offset))}` });
      break;
    }
  }
  return out;
}

function annotate(f) {
  const v = f.value;
  switch (f.field) {
    case 1: return f.bytes && JSON.stringify(new TextDecoder().decode(new Uint8Array(f.bytes)));
    case 2: return f.wire === 0 && `${v} bpm`;
    case 3: return f.wire === 0 && `zigzag → ${(v >>> 1) ^ -(v & 1)}`;
    case 4: return f.wire === 0 && (['TREBLE', 'BASS'][v] ?? 'unknown enum');
    case 5: return f.wire === 0 && (TIMES[v] ?? 'unknown enum');
    case 6: return f.wire === 0 && `${v} measures`;
  }
  return '';
}

function fieldLines(f, names, indent, ctx = {}) {
  const top = names === FIELDS || names === FIELDS_V2, staff = names === STAFF_FIELDS || names === STAFF_FIELDS_V2;
  if (f.field === undefined) return [`${indent}!! ${f.error}`];
  const name = names[f.field] ?? 'unknown';
  const head = `${indent}${f.field} ${name} (${WIRE[f.wire]}) @${f.offset}`;
  const lines = [];
  if (f.wire === 0) {
    const note = top ? annotate(f) : staff && f.field === 1 ? (['TREBLE', 'BASS'][f.value] ?? 'unknown enum') : '';
    lines.push(`${head}: ${f.value}${note ? `  ${note}` : ''}`);
  } else {
    lines.push(`${head}: ${f.bytes.length} bytes  ${hex(f.bytes)}`);
    const sub = indent + '    ';
    if (top && f.field === 1) lines.push(`${sub}${annotate(f)}`);
    if ((names === FIELDS && f.field === 7) || (names === STAFF_FIELDS && f.field === 2) || (names === CHORD_FIELDS && f.field === 2)) {
      unpack12(f.bytes).forEach((c, k) => lines.push(`${sub}[${k}] ${describeCode(c, names === CHORD_FIELDS)}`));
    }
    if (names === FIELDS && f.field === 9) walk(f.bytes).forEach(g => lines.push(...fieldLines(g, STAFF_FIELDS, sub)));
    if (names === FIELDS_V2 && f.field === 9) {
      const staffCtx = { ...ctx, clef: walk(f.bytes).find(g => g.field === 1 && g.wire === 0)?.value === 1 ? 'bass' : 'treble' };
      walk(f.bytes).forEach(g => lines.push(...fieldLines(g, STAFF_FIELDS_V2, sub, staffCtx)));
    }
    if (names === FIELDS_V2 && f.field === 10) lines.push(...voiceLines(f.bytes, ctx.key, ctx.clef, [], sub).lines);
    if (names === STAFF_FIELDS_V2 && f.field === 4) lines.push(...voiceLines(f.bytes, ctx.key, ctx.clef, ctx.history, sub).lines);
    if ((names === FIELDS && f.field === 8) || (names === STAFF_FIELDS && f.field === 3)) {
      const sub8 = walk(f.bytes);
      if (!sub8.some(g => g.field === 1)) lines.push(`${sub}(index absent → 0)`);
      sub8.forEach(g => lines.push(...fieldLines(g, CHORD_FIELDS, sub)));
    }
  }
  if (f.error) lines.push(`${indent}!! ${f.error}`);
  return lines;
}

/** Plain-text dump of the fragment ("#2.xxxx") for the debug overlay. */
export function dumpFragment(fragment) {
  const s = (fragment || '').replace(/^#/, '');
  const m = s.match(/^(\d+)\.(.*)$/s);
  const lines = [`Fragment: #${s}`];
  if (!m) return [...lines, '!! not a "<version>.<base64url>" fragment'].join('\n');
  const { bytes, dropped } = fromB64(m[2]);
  lines.push(`Version: ${m[1]}`, `Payload: ${bytes.length} bytes${dropped ? ' (dropped non-base64 characters)' : ''}`);
  if (bytes.length) lines.push(`  ${hex(bytes)}`);
  lines.push('', 'message Tune {');
  const fields = walk(bytes);
  if (!fields.length) lines.push('  (empty: every field at its default)');
  if (+m[1] === 1) fields.forEach(f => lines.push(...fieldLines(f, FIELDS, '  ')));
  else {
    // Voices are decoded with the key and clef from the header; the second staff may copy from the first.
    const zig = fields.find(f => f.field === 3 && f.wire === 0)?.value ?? 0;
    const key = (zig >>> 1) ^ -(zig & 1);
    const clef = fields.find(f => f.field === 4 && f.wire === 0)?.value === 1 ? 'bass' : 'treble';
    const voice = fields.find(f => f.field === 10 && f.wire === 2);
    const history = voice ? resolveVoice(parseVoice(voice.bytes), key, clef).events : [];
    fields.forEach(f => lines.push(...fieldLines(f, FIELDS_V2, '  ', { key, clef, history })));
  }
  lines.push('}');
  return lines.join('\n');
}
