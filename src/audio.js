// Web Audio synth voice and scheduler. See context/05-rendering-audio-architecture.md.
import { freqOf, midiOf, ticksOf } from './theory.js';
import { used } from './model.js';

let ctx = null, master = null;

function ensure() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    ctx = new AC();
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch {}
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 3200;
    master = ctx.createGain(); master.gain.value = 0.25;
    lp.connect(master); master.connect(ctx.destination);
    master.input = lp;
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

/** Schedule one note; returns a handle that can be cut short. */
function voice(midi, start, dur) {
  const f = freqOf(midi);
  const env = ctx.createGain();
  env.gain.setValueAtTime(0, start);
  env.gain.linearRampToValueAtTime(1, start + 0.005);
  env.gain.linearRampToValueAtTime(0.6, start + 0.125);
  const end = start + Math.max(dur, 0.06);
  env.gain.setValueAtTime(0.6, end);
  env.gain.linearRampToValueAtTime(0, end + 0.08);
  env.connect(master.input);
  const oscs = [['triangle', f, 1], ['sine', f * 2, 0.15]].map(([type, freq, gain]) => {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type; o.frequency.value = freq; g.gain.value = gain;
    o.connect(g); g.connect(env);
    o.start(start); o.stop(end + 0.1);
    return o;
  });
  return {
    cut(at) {
      env.gain.cancelScheduledValues(at);
      env.gain.setValueAtTime(env.gain.value, at);
      env.gain.linearRampToValueAtTime(0, at + 0.02);
      oscs.forEach(o => { try { o.stop(at + 0.03); } catch {} });
    },
  };
}

export function preview(pitch) {
  try { const c = ensure(); voice(midiOf(pitch), c.currentTime + 0.01, 0.35); } catch {}
}

export class Player {
  constructor() { this.playing = false; this.voices = []; }

  /**
   * @param tune
   * @param from event index to start at
   * @param opts {{loop:boolean, onEvent:(i:number)=>void, onEnd:()=>void}}
   */
  play(tune, from, { loop, onEvent, onEnd }) {
    this.stop();
    const c = ensure();
    const secPerTick = 60 / tune.bpm / 4;
    const mt = { '2/4': 8, '3/4': 12, '4/4': 16, '6/8': 12 }[tune.time];
    const contentEnd = used(tune.events);
    if (!contentEnd) { onEnd(); return; }
    const loopTicks = Math.ceil(contentEnd / mt) * mt;
    this.playing = true;
    const schedule = [];   // [{i, t0, t1}] in seconds (context time)
    const pass = (startTime, fromIdx) => {
      let t = 0;
      tune.events.forEach((e, i) => {
        const len = ticksOf(e);
        if (i >= fromIdx) {
          const t0 = startTime + t * secPerTick, d = len * secPerTick;
          if (!e.rest) this.voices.push(voice(midiOf(e), t0, d * 0.92));
          schedule.push({ i, t0, t1: t0 + d });
        }
        if (i >= fromIdx) t += len;
      });
      return startTime + (fromIdx === 0 ? loopTicks : t) * secPerTick;
    };
    let passEnd = pass(c.currentTime + 0.05, from);
    const tickLoop = () => {
      if (!this.playing) return;
      const now = c.currentTime;
      if (loop() && now > passEnd - 0.25) passEnd = pass(passEnd, 0);
      const cur = schedule.find(s => now >= s.t0 && now < s.t1);
      onEvent(cur ? cur.i : -1);
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
