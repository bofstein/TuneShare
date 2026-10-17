// Web Audio synth voice and scheduler. See DESIGN.md.
import { freqOf, midiOf, ticksOf } from './theory.js';
import { pitchesOf, staffList, used } from './model.js';

let ctx = null, master = null;

function ensure() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    ctx = new AC();
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch {}
    master = ctx.createGain(); master.gain.value = 0.25;
    master.connect(ctx.destination);
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

let instrument = 'synth';
/** Pick the sound for preview and playback (an id from src/instruments.js). */
export function setInstrument(id) { instrument = id; }

const waves = {};
/** A periodic wave from harmonic amplitudes [h1, h2, ...], cached per context. */
function wave(name, amps) {
  if (!waves[name]) {
    const re = new Float32Array(amps.length + 1), im = new Float32Array(amps.length + 1);
    amps.forEach((a, k) => { im[k + 1] = a; });
    waves[name] = ctx.createPeriodicWave(re, im);
  }
  return waves[name];
}

const plucks = new Map();
/** Karplus-Strong plucked string, rendered once per pitch and cached. */
function pluck(f, bright, sec) {
  const k = `${f.toFixed(2)}:${bright}`;
  if (plucks.has(k)) return plucks.get(k);
  const sr = ctx.sampleRate, n = Math.floor(sr * sec), p = Math.max(2, Math.round(sr / f));
  const buf = ctx.createBuffer(1, n, sr), d = buf.getChannelData(0);
  const ring = new Float32Array(p);
  let seed = 12345;
  for (let i = 0; i < p; i++) { seed = (seed * 16807) % 2147483647; ring[i] = seed / 1073741824 - 1; }
  for (let i = 0, j = 0; i < n; i++, j = (j + 1) % p) {
    const nx = ring[(j + 1) % p];
    d[i] = ring[j];
    ring[j] = (bright * ring[j] + (1 - bright) * nx) * 0.996;
  }
  plucks.set(k, buf);
  return buf;
}

let noiseBuf = null;
function noise() {
  if (!noiseBuf) {
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  return noiseBuf;
}

/** Schedule one note; returns a handle that can be cut short. */
function voice(midi, start, dur, level = 1) {
  const f = freqOf(midi);
  const end = start + Math.max(dur, 0.06);
  const env = ctx.createGain();
  const lvl = ctx.createGain();
  lvl.gain.value = level;
  env.connect(lvl); lvl.connect(master);
  const srcs = [];
  const osc = (type, freq, gain, to = env, detune = 0) => {
    const o = ctx.createOscillator(), g = ctx.createGain();
    if (typeof type === 'string') o.type = type; else o.setPeriodicWave(type);
    o.frequency.value = freq; o.detune.value = detune; g.gain.value = gain;
    o.connect(g); g.connect(to);
    srcs.push(o);
    return o;
  };
  const filter = (type, freq, q = 1, to = env) => {
    const b = ctx.createBiquadFilter();
    b.type = type; b.frequency.value = freq; b.Q.value = q; b.connect(to);
    return b;
  };
  const vibrato = (rate, cents, delay, oscs) => {
    const lfo = ctx.createOscillator(), g = ctx.createGain();
    lfo.frequency.value = rate;
    g.gain.setValueAtTime(0, start); g.gain.linearRampToValueAtTime(0, start + delay);
    g.gain.linearRampToValueAtTime(cents, start + delay + 0.25);
    lfo.connect(g); oscs.forEach(o => g.connect(o.detune));
    srcs.push(lfo);
  };
  // Sustained envelope: attack to 1, settle to `sus`, release after the note.
  const adsr = (a, d, sus, r) => {
    env.gain.setValueAtTime(0, start);
    env.gain.linearRampToValueAtTime(1, start + a);
    env.gain.linearRampToValueAtTime(sus, start + a + d);
    env.gain.setValueAtTime(sus, end);
    env.gain.linearRampToValueAtTime(0, end + r);
    return r;
  };
  // Struck or plucked: fast attack, then a natural decay that is cut at the note's end.
  const strike = (decay, r) => {
    env.gain.setValueAtTime(0, start);
    env.gain.linearRampToValueAtTime(1, start + 0.003);
    env.gain.setTargetAtTime(0, start + 0.003, decay);
    env.gain.setTargetAtTime(0, end, r / 3);
    return r;
  };
  let release;
  switch (instrument) {
    case 'piano': {
      // Lower notes ring longer; the tone darkens as it decays.
      release = strike(0.25 + 1.2 * Math.pow(220 / f, 0.5) * 0.6, 0.25);
      const lp = filter('lowpass', 0, 0.7);
      lp.frequency.setValueAtTime(Math.min(f * 12, 9000), start);
      lp.frequency.setTargetAtTime(Math.min(f * 4, 4000), start, 0.3);
      const w = wave('piano', [1, 0.6, 0.35, 0.25, 0.12, 0.1, 0.05, 0.04]);
      osc(w, f, 0.5, lp, -3); osc(w, f, 0.5, lp, 3);
      break;
    }
    case 'epiano': {
      release = strike(0.9, 0.3);
      osc('sine', f, 0.8); osc('sine', f * 2, 0.12);
      const bell = ctx.createGain();
      bell.gain.setValueAtTime(0.25, start); bell.gain.setTargetAtTime(0, start, 0.05); bell.connect(env);
      osc('sine', f * 7, 0.6, bell);
      break;
    }
    case 'guitar':
    case 'eguitar': {
      const electric = instrument === 'eguitar';
      const src = ctx.createBufferSource();
      src.buffer = pluck(f, electric ? 0.6 : 0.5, electric ? 3 : 2);
      release = strike(electric ? 1.2 : 0.7, 0.12);
      if (electric) {
        const shaper = ctx.createWaveShaper(), curve = new Float32Array(256);
        for (let i = 0; i < 256; i++) { const x = i / 127.5 - 1; curve[i] = Math.tanh(2.5 * x); }
        shaper.curve = curve;
        src.connect(shaper); shaper.connect(filter('lowpass', 3500, 0.8));
      } else src.connect(filter('lowpass', 5000, 0.5));
      srcs.push(src);
      break;
    }
    case 'violin': {
      release = adsr(0.08, 0.1, 0.8, 0.15);
      const bp = filter('lowpass', 4000, 0.8);
      const peak = filter('peaking', 2800, 1.5, bp); peak.gain.value = 6;
      vibrato(5.5, 14, 0.15, [osc('sawtooth', f, 0.45, peak), osc('sawtooth', f, 0.25, peak, 6)]);
      break;
    }
    case 'trumpet': {
      release = adsr(0.04, 0.12, 0.75, 0.08);
      const lp = filter('lowpass', 0, 1.2);
      lp.frequency.setValueAtTime(f * 1.5, start);
      lp.frequency.linearRampToValueAtTime(Math.min(f * 8, 6000), start + 0.06);
      lp.frequency.setTargetAtTime(Math.min(f * 5, 4500), start + 0.06, 0.1);
      vibrato(5, 8, 0.3, [osc('sawtooth', f, 0.5, lp)]);
      break;
    }
    case 'flute': {
      release = adsr(0.07, 0.1, 0.8, 0.1);
      vibrato(5, 10, 0.2, [osc('sine', f, 0.8), osc('sine', f * 2, 0.08), osc('sine', f * 3, 0.03)]);
      const n = ctx.createBufferSource(); n.buffer = noise(); n.loop = true;
      const ng = ctx.createGain(); ng.gain.value = 0.05;
      n.connect(ng); ng.connect(filter('bandpass', f * 2, 2)); srcs.push(n);
      break;
    }
    case 'sax': {
      release = adsr(0.03, 0.15, 0.75, 0.08);
      const lp = filter('lowpass', Math.min(f * 6, 4000), 1);
      const peak = filter('peaking', 1500, 1, lp); peak.gain.value = 8;
      const w = wave('sax', [1, 0.15, 0.7, 0.12, 0.45, 0.1, 0.25, 0.06, 0.12]);
      vibrato(4.8, 12, 0.25, [osc(w, f, 0.6, peak), osc('sawtooth', f, 0.12, peak, 4)]);
      break;
    }
    case 'choir': {
      release = adsr(0.18, 0.2, 0.85, 0.3);
      // Detuned voices through the formants of an "ah".
      const mix = ctx.createGain(); mix.gain.value = 1;
      [[700, 0.9], [1220, 0.5], [2600, 0.25]].forEach(([fr, g]) => {
        const b = ctx.createBiquadFilter(); b.type = 'bandpass'; b.frequency.value = fr; b.Q.value = 6;
        const bg = ctx.createGain(); bg.gain.value = g * 3;
        mix.connect(b); b.connect(bg); bg.connect(env);
      });
      vibrato(5, 10, 0.3, [-9, 0, 8].map(c => osc('sawtooth', f, 0.3, mix, c)));
      break;
    }
    default: {
      // Soft synth: triangle plus a quiet octave, softened by a low-pass.
      release = adsr(0.005, 0.12, 0.6, 0.08);
      const lp = filter('lowpass', 3200);
      osc('triangle', f, 1, lp); osc('sine', f * 2, 0.15, lp);
    }
  }
  srcs.forEach(o => { o.start(start); o.stop(end + release + 0.05); });
  return {
    cut(at) {
      env.gain.cancelScheduledValues(at);
      env.gain.setValueAtTime(env.gain.value, at);
      env.gain.linearRampToValueAtTime(0, at + 0.02);
      srcs.forEach(o => { try { o.stop(at + 0.03); } catch {} });
    },
  };
}

/** Sound one or more pitches together (a note or a chord). */
export function preview(...pitches) {
  try {
    const c = ensure(), level = chordLevel(pitches.length);
    pitches.forEach(p => voice(midiOf(p), c.currentTime + 0.01, 0.35, level));
  } catch {}
}

// Keep chords from clipping: total loudness grows slowly with the number of notes.
const chordLevel = n => 1 / Math.sqrt(n);

export class Player {
  constructor() { this.playing = false; this.voices = []; }

  /**
   * Plays every staff together.
   * @param tune
   * @param from tick to start at
   * @param opts {{loop:()=>boolean, onEvent:(keys:string[])=>void, onEnd:()=>void}}
   *   onEvent gets the "staff:index" keys of the events sounding now (empty when none).
   */
  play(tune, from, { loop, onEvent, onEnd }) {
    this.stop();
    const c = ensure();
    const secPerTick = 60 / tune.bpm / 4;
    const mt = { '2/4': 8, '3/4': 12, '4/4': 16, '6/8': 12 }[tune.time];
    const staves = staffList(tune);
    const contentEnd = Math.max(...staves.map(st => used(st.events)));
    if (!contentEnd || from >= contentEnd) { onEnd(); return; }
    const loopTicks = Math.ceil(contentEnd / mt) * mt;
    this.playing = true;
    const schedule = [];   // [{key, t0, t1}] in seconds (context time)
    const pass = (startTime, fromTick) => {
      staves.forEach((st, s) => {
        let t = 0;
        st.events.forEach((e, i) => {
          const len = ticksOf(e);
          // A note already sounding at the start tick is skipped, like a note before it.
          if (t >= fromTick) {
            const t0 = startTime + (t - fromTick) * secPerTick, d = len * secPerTick;
            const ps = pitchesOf(e), level = chordLevel(ps.length);
            ps.forEach(p => this.voices.push(voice(midiOf(p), t0, d * 0.92, level)));
            schedule.push({ key: `${s}:${i}`, t0, t1: t0 + d });
          }
          t += len;
        });
      });
      schedule.sort((x, y) => x.t1 - y.t1);
      return startTime + (fromTick === 0 ? loopTicks : contentEnd - fromTick) * secPerTick;
    };
    let passEnd = pass(c.currentTime + 0.05, from);
    let last = '';
    const tickLoop = () => {
      if (!this.playing) return;
      const now = c.currentTime;
      if (loop() && now > passEnd - 0.25) passEnd = pass(passEnd, 0);
      const keys = schedule.filter(s => now >= s.t0 && now < s.t1).map(s => s.key);
      if (keys.join() !== last) { last = keys.join(); onEvent(keys); }
      if (now >= passEnd && !loop()) { this.stop(); onEnd(); return; }
      while (schedule.length && schedule[0].t1 < now - 1) schedule.shift();
      this.raf = requestAnimationFrame(tickLoop);
    };
    this.raf = requestAnimationFrame(tickLoop);
  }

  stop() {
    if (!this.playing && !this.voices.length) return;
    this.playing = false;
    cancelAnimationFrame(this.raf);
    if (ctx) { const now = ctx.currentTime; this.voices.forEach(v => v.cut(now)); }
    this.voices = [];
  }
}
