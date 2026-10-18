// Web Audio physical/spectral synth, per-pitch buffer cache, and lookahead scheduler. See DESIGN.md.
import { freqOf, midiOf, ticksOf } from './theory.js';
import { pitchesOf, staffList, used } from './model.js';

export const SYNTH_SR = 32000;
const SUSTAINED = new Set(['violin', 'cello', 'trumpet', 'flute', 'sax', 'choir', 'synth']);

// Physical open-string tables: [fOpen, maxFreqOnString, beta0, stopDamp, woundFactor]
export const OPEN_STRINGS = {
  violin: [
    [196.00, 285, 0.148, 0.55, 0.35], // G3 silver-wound (beta0=0.148 places Helmholtz bow node at H6 on A3, H5 on C4)
    [293.66, 430, 0.115, 0.45, 0.12], // D4 gut/synthetic
    [440.00, 645, 0.095, 0.30, 0.00], // A4 aluminum/steel
    [659.25, 4e3, 0.085, 0.20, 0.00], // E5 plain steel
  ],
  cello: [
    [65.41,   95, 0.120, 0.35, 0.40], // C2 tungsten-wound
    [98.00,  142, 0.110, 0.35, 0.25], // G2 wound
    [146.83, 215, 0.095, 0.28, 0.10], // D3
    [220.00, 2e3, 0.085, 0.22, 0.00], // A3 steel
  ],
  guitar: [
    [82.41,  108, 0.13, 0.18, 0.35],  // E2 bronze-wound
    [110.00, 144, 0.13, 0.18, 0.30],  // A2 bronze-wound
    [146.83, 193, 0.14, 0.20, 0.20],  // D3 wound
    [196.00, 243, 0.18, 0.25, 0.00],  // G3 plain
    [246.94, 325, 0.23, 0.22, 0.00],  // B3 plain
    [329.63, 2e3, 0.29, 0.18, 0.00],  // E4 plain
  ],
  eguitar: [
    [82.41,  108, 0.14, 0.15, 0.25],  // E2 nickel-wound
    [110.00, 144, 0.14, 0.15, 0.22],  // A2 nickel-wound
    [146.83, 193, 0.15, 0.16, 0.15],  // D3 wound
    [196.00, 243, 0.17, 0.18, 0.00],  // G3 plain
    [246.94, 325, 0.18, 0.18, 0.00],  // B3 plain
    [329.63, 2e3, 0.22, 0.22, 0.00],  // E4 plain
  ],
};

const gaussOct = (f, c, w) => Math.exp(-((Math.log2(Math.max(f, 20) / c)) ** 2) / (w * w));

/** Select which physical string plays frequency f0: returns [stringIndex, spec]. */
export function pickString(inst, f0) {
  const list = OPEN_STRINGS[inst];
  if (!list) return [-1, null];
  const idx = list.findIndex(s => f0 <= s[1]);
  return idx >= 0 ? [idx, list[idx]] : [list.length - 1, list[list.length - 1]];
}

/** Sympathetic boost from UNSELECTED open strings when harmonic fk aligns with m * fOpen. */
export function unselectedSympatheticGain(inst, playedIdx, fk) {
  const list = OPEN_STRINGS[inst];
  if (!list) return 1;
  let boost = 0;
  for (let i = 0; i < list.length; i++) {
    if (i === playedIdx) continue;
    const fOpen = list[i][0];
    for (let m = 1; m <= 6; m++) {
      const cents = Math.abs(1200 * Math.log2(Math.max(fk, 20) / (fOpen * m)));
      if (cents < 42) boost += (0.85 / (m ** 0.35)) / (1 + (cents / 18) ** 2);
    }
  }
  return 1 + boost;
}

/** Free-mode vibrations [freq, amp, decaySec] excited on UNSELECTED open strings via the bridge. */
export function unselectedStringModes(inst, f0) {
  const list = OPEN_STRINGS[inst];
  if (!list) return [];
  const [playedIdx] = pickString(inst, f0);
  const modes = [];
  for (let i = 0; i < list.length; i++) {
    if (i === playedIdx) continue;
    const fOpen = list[i][0];
    let coupling = 0.006;
    for (let k = 1; k <= 8; k++) {
      for (let n = 1; n <= 5; n++) {
        const cents = Math.abs(1200 * Math.log2(Math.max(k * f0, 20) / (n * fOpen)));
        if (cents < 45) coupling += 0.022 / ((k ** 0.6) * (n ** 0.5) * (1 + (cents / 18) ** 2));
      }
    }
    const c = Math.min(0.065, coupling);
    modes.push([fOpen, c, 1.1], [fOpen * 2, c * 0.45, 0.78]);
  }
  return modes;
}

function stringHarmonicWeight(inst, k, f0) {
  const fk = k * f0;
  const [idx, [fOpen, , beta0, stopDamp, wound]] = pickString(inst, f0);
  const ratio = Math.max(1, f0 / fOpen);
  const betaEff = Math.min(0.48, beta0 * (ratio ** 0.9));
  const comb = Math.abs(Math.sin(k * Math.PI * betaEff)) / Math.max(0.18, Math.abs(Math.sin(Math.PI * betaEff)));
  const symp = unselectedSympatheticGain(inst, idx, fk);

  if (inst === 'guitar') {
    // Finger-plucked acoustic: fingertip flesh pad (~14mm) gently rolls off upper partials above k >= 4
    let sk = (1 / (k ** 1.12)) * (0.06 + 0.94 * comb) * Math.exp(-0.08 * Math.max(0, k - 3));
    if (wound > 0 && (k === 2 || k === 9 || k === 10 || k === 12)) sk *= k === 2 ? 1.15 : 1.25;
    const body = (0.68 + 0.68 * gaussOct(fk, 195, 0.55) + 0.28 * gaussOct(fk, 540, 0.5) + 1.05 * gaussOct(fk, 1550, 0.55)) / (1 + (fk / 2750) ** 2.4);
    return sk * body * Math.exp(-stopDamp * (ratio - 1) * Math.max(0, k - 2) * 0.25) * (1 + 0.22 * (symp - 1));
  }
  if (inst === 'eguitar') {
    // Picked electric + tube amp overdrive: plectrum excites upper harmonics strongly + asymmetric tube 2nd/3rd harmonic bite
    const pComb = Math.abs(Math.cos(k * Math.PI * 0.11 * (ratio ** 0.7)));
    let sk = (1 / (k ** 0.86)) * (0.18 + 0.82 * comb * pComb);
    if (wound > 0 && (k === 2 || k === 3)) sk *= 1.18;
    const body = (0.42 + 0.95 * gaussOct(fk, 310, 0.65) + 0.72 * gaussOct(fk, 1450, 0.50) + 0.38 * gaussOct(fk, 2450, 0.45)) / (1 + (fk / 2250) ** 2.6);
    return sk * body * Math.exp(-stopDamp * (ratio - 1) * Math.max(0, k - 2) * 0.32) * (1 + 0.15 * (symp - 1));
  }
  if (inst === 'violin') {
    let sk = (1 / (k ** (wound > 0.2 ? 0.68 : 1.38))) * (0.08 + 0.92 * Math.min(1.5, comb));
    if (wound > 0.2 && (k === 7 || k === 9 || k === 11)) sk *= 2.4;
    const stop = Math.exp(-stopDamp * ((ratio - 1) ** 1.4) * Math.max(0, k - 2) * 2.2);
    const bridgeRing = 0.35 * gaussOct(fk, 2380, 0.22) + 0.35 * gaussOct(fk, 3850, 0.3);
    const body = (0.85 * gaussOct(fk, 260, 0.42) + 1.25 * gaussOct(fk, 500, 0.4) + 0.55 * gaussOct(fk, 980, 0.42)
      + (f0 < 240 ? 1.45 : 0.35) * gaussOct(fk, 1540, 0.26) + 1.35 * gaussOct(fk, 2050, 0.35)) / (1 + (fk / 3800) ** 2.6);
    return sk * (body * stop + bridgeRing * (ratio > 1.15 ? 0.35 : 0.1)) * (1 + 0.45 * (symp - 1));
  }
  // Cello: A0 (122Hz) f-hole air mode, B1 (215Hz) main wood mode, 785Hz A-string formant, and 2100Hz Bridge Hill
  const cBeta = Math.min(0.14, beta0 * (ratio ** 0.25));
  const cComb = Math.abs(Math.sin(k * Math.PI * cBeta)) / Math.max(0.22, Math.abs(Math.sin(Math.PI * cBeta)));
  const lobe = wound < 0.25 && (k === 10 || k === 11) ? 2.2 : (wound >= 0.25 && k >= 7 ? 0.28 : 1);
  const sk = (1 / (k ** 0.82)) * (0.35 + 0.65 * Math.min(1.8, cComb)) * lobe;
  const stop = Math.exp(-stopDamp * ((ratio - 1) ** 1.1) * Math.max(0, k - 2) * 0.45);
  const lowRad = (fk / 102) ** 4.2 / (0.08 + (fk / 102) ** 4.2);
  const aForm = (f0 > 215 ? 3.8 : f0 < 90 ? 0.20 : 0.65) * gaussOct(fk, 785, 0.17);
  const body = lowRad * (0.08 + 0.95 * gaussOct(fk, 122, 0.22) + 1.85 * gaussOct(fk, 215, 0.32)
    + 0.55 * gaussOct(fk, 385, 0.24) + aForm + 1.15 * gaussOct(fk, 2100, 0.5)) / (1 + (fk / 2950) ** 2.6);
  return sk * body * stop * (1 + 0.3 * (symp - 1));
}

const customProfiles = {};
/** Override or tune an instrument's harmonic/decay profile (used by Sound Lab custom fitting). */
export function setCustomProfile(inst, profile) {
  if (profile) customProfiles[inst] = profile; else delete customProfiles[inst];
  noteCache.clear();
}

function rawHarmonicWeight(inst, k, f0) {
  if (customProfiles[inst]?.harms) return customProfiles[inst].harms[k - 1] ?? (1 / (k * k));
  if (OPEN_STRINGS[inst]) return stringHarmonicWeight(inst, k, f0);
  const fk = k * f0;
  if (inst === 'piano') {
    // Broad spruce soundboard plateau (125Hz..3800Hz) so upper harmonics H4-H12 ring across all registers.
    // Supports 3 voicings: 'kawai' (Kawai RX/GX Warm Grand default), 'kg2a' / 'local' (calibrated Kawai KG-2A 5'10" grand), and 'yamaha' (bright C5).
    const v = customProfiles.piano?.voicing ?? 'kawai', yamaha = v === 'yamaha', local = v === 'kg2a' || v === 'local';
    if (local) {
      // 3-anchor logarithmic register interpolation calibrated directly to the user's Kawai KG-2A recordings:
      // Bass (C2/C3, 65.7Hz/131.4Hz): rich wound-string chorus [0.013, 0.616, 0.482, 0.067, 0.231, 0.273, 0.232, 0.034, 0.100, 0.392, 0.166, 0.097]
      // Middle (E4, 328.8Hz): warm woody fundamental [0.975, 0.211, 0.062, 0.008, 0.015, 0.003, 0.005, 0.001, 0, 0, 0, 0]
      // Treble (G5/G6, 786.9Hz/1573.8Hz): bell-like singing tone [0.999, 0.007, 0.044, 0.002, 0.006, 0.002, 0.001, 0.002, 0.001, 0.001, 0, 0]
      const bVec = [0.42, 0.616, 0.482, 0.067, 0.231, 0.273, 0.232, 0.034, 0.100, 0.392, 0.166, 0.097];
      const mVec = [0.975, 0.211, 0.062, 0.008, 0.015, 0.003, 0.005, 0.001, 0.0004, 0.0002, 0.0001, 0.0001];
      const tVec = [0.999, 0.028, 0.044, 0.004, 0.006, 0.002, 0.001, 0.002, 0.001, 0.001, 0.0003, 0.0001];
      const u = Math.log2(Math.max(55, Math.min(2000, f0)) / 328.8);
      if (u <= 0) {
        const a = Math.min(1, Math.max(0, -u / 1.85));
        return bVec[k - 1] * a + mVec[k - 1] * (1 - a);
      }
      const a = Math.min(1, Math.max(0, u / 1.26));
      return mVec[k - 1] * (1 - a) + tVec[k - 1] * a;
    }
    const bassMix = Math.min(1, Math.max(0, (115 - f0) / 45)); // 0 at C3 (130.8Hz), 1 at C2 (65.4Hz)
    const bassSk = [1.0, 1.35, 0.58, 0.45, 0.16, 0.045, 0.22, 0.03, 0.14, 0.09, 0.065, 0.05];
    const midSk = yamaha
      ? [1.0, 0.54, 0.18, 0.21, 0.12, 0.068, 0.062, 0.135, 0.058, 0.024, 0.018, 0.011]
      : [1.0, 0.56, 0.19, 0.185, 0.098, 0.054, 0.050, 0.105, 0.045, 0.019, 0.014, 0.008];
    const sk = bassSk[k - 1] * bassMix + midSk[k - 1] * (1 - bassMix);
    const lowRad = (fk / 92) ** 2.2 / (0.10 + (fk / 92) ** 2.2);
    const cutoff = yamaha ? 4300 : 3500;
    let body = lowRad * (0.68 + 0.36 * gaussOct(fk, 320, 0.95) + (yamaha ? 0.38 : 0.25) * gaussOct(fk, 1950, 0.85)) / (1 + (fk / cutoff) ** 2.8);
    if (k === 1 && f0 > 180) body *= Math.min(1.55, (f0 / 220) ** 0.35);
    return sk * body;
  }
  if (inst === 'epiano') {
    const sk = [1, 0.55, 0.35, 0.1, 0.08, 0.015, 0.04, 0.01, 0.005, 0.002, 0, 0][k - 1];
    const body = (0.35 + 1.1 * gaussOct(fk, 380, 0.85)) / (1 + (fk / 620) ** 2.6) + (k === 7 ? 0.035 * gaussOct(fk, 2200, 0.9) : 0);
    return sk * body;
  }
  if (inst === 'trumpet') {
    const slope = 0.25 + 0.95 * ((f0 / 340) ** 1.1);
    return (1 / (k ** slope)) * (0.12 + 0.7 * gaussOct(fk, 480, 0.65) + 1.25 * gaussOct(fk, 1150, 0.58)) / (1 + (fk / 2100) ** 3.0);
  }
  if (inst === 'flute') {
    const sk = [1.0, 1.05, 0.88, 0.22, 0.16, 0.10, 0.07, 0.025, 0.012, 0.008, 0.004, 0.002][k - 1];
    return sk * (0.72 + 0.75 * gaussOct(fk, 1450, 0.52)) / (1 + (fk / 1850) ** 2.6);
  }
  if (inst === 'sax') {
    const sk = [1, 0.85, 0.42, 0.38, 0.16, 0.28, 0.32, 0.26, 0.14, 0.18, 0.22, 0.20][k - 1];
    return sk * (1.05 * gaussOct(fk, 260, 0.52) + 1.15 * gaussOct(fk, 540, 0.48) + 0.55 * gaussOct(fk, 1100, 0.5) + 1.15 * gaussOct(fk, 2150, 0.58)) / (1 + (fk / 3600) ** 3);
  }
  if (inst === 'choir') {
    // Mixed choir (SATB octave doubling reinforces even harmonics H2, H4, H6) + open "ahhh" formants (F1 ~ 730Hz, F2 ~ 1120Hz, F3 ~ 2800Hz)
    const sk = [0.32, 1.0, 0.24, 0.65, 0.16, 0.44, 0.06, 0.09, 0.045, 0.04, 0.025, 0.025][k - 1];
    return sk * (0.45 * gaussOct(fk, 220, 0.45) + 1.25 * gaussOct(fk, 540, 0.36) + 1.45 * gaussOct(fk, 760, 0.32)
      + 1.35 * gaussOct(fk, 1140, 0.28) + 0.90 * gaussOct(fk, 1380, 0.25) + 0.28 * gaussOct(fk, 2800, 0.5)) / (1 + (fk / 3400) ** 3);
  }
  // Soft synth: warm triangle-like rolloff with gentle octave presence
  return (k === 1 ? 1 : k === 2 ? 0.22 : (k % 2 ? 1 / (k * k) : 0.04 / (k * k))) / (1 + (fk / 2800) ** 2);
}

/** Normalized 12-harmonic amplitude vector for (inst, f0). */
export function harmonicAmps(inst, f0) {
  const w = Array.from({ length: 12 }, (_, i) => rawHarmonicWeight(inst, i + 1, f0));
  const norm = Math.sqrt(w.reduce((a, x) => a + x * x, 0)) || 1;
  return w.map(x => x / norm);
}

function addBandpassNoise(out, sr, freq, q, atkAmp, atkTau, susAmp, atkTauEnv) {
  const w0 = 2 * Math.PI * Math.max(40, Math.min(freq, sr * 0.45)) / sr;
  const alpha = Math.sin(w0) / (2 * q), cosW = Math.cos(w0);
  const b0 = alpha / (1 + alpha), a1 = (-2 * cosW) / (1 + alpha), a2 = (1 - alpha) / (1 + alpha);
  let seed = (54321 + Math.round(freq * 13)) | 0, x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  let eAtk = atkAmp, eEnv = 1;
  const dAtk = Math.exp(-1 / (sr * atkTau)), dEnv = Math.exp(-1 / (sr * atkTauEnv));
  // Stop loop early if sustain is 0 and attack burst has decayed below -100dB (avoids IEEE-754 denormal CPU penalty)
  const nLim = susAmp === 0 ? Math.min(out.length, Math.floor(sr * atkTau * 11)) : out.length;
  for (let i = 0; i < nLim; i++) {
    seed = (seed * 16807) % 2147483647;
    const x0 = seed / 1073741824 - 1;
    const y0 = b0 * (x0 - x2) - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x0; y2 = y1; y1 = y0;
    out[i] += (eAtk + susAmp * (1 - eEnv)) * y0;
    eAtk = eAtk * dAtk + 1e-24;
    eEnv = eEnv * dEnv + 1e-24;
  }
}

function addPianoHammerHit(out, sr, f0, yamaha, local) {
  // 1. Deterministic half-sine felt-compression impulse (tau_c ~ 2.4ms on bass -> 0.8ms on high treble)
  const reg = Math.min(1.6, Math.max(0.35, f0 / 261.63));
  const tauC = (local ? 0.0022 : 0.0018) / (reg ** 0.55), nPulse = Math.min(out.length, Math.floor(tauC * 3.2 * sr));
  const pulseAmp = (local ? 0.085 : yamaha ? 0.14 : 0.105) * (reg ** 0.25);
  for (let i = 0; i < nPulse; i++) {
    const t = i / sr, u = Math.min(1, t / tauC);
    out[i] += pulseAmp * (Math.sin(Math.PI * u) ** 2.2) * Math.exp(-t / (tauC * 0.85));
  }
  // 2. Three damped wooden-action/soundboard bridge knock modes (keybed 118Hz, bridge/rim 340Hz, felt/string 920-2400Hz)
  const knocks = [
    [yamaha ? 132 : 116, local ? 0.090 : 0.075, 0.016],
    [yamaha ? 370 : 325, local ? 0.072 : 0.062, 0.011],
    [Math.min(2800, Math.max(680, f0 * (yamaha ? 2.8 : 2.2))), (local ? 0.028 : yamaha ? 0.058 : 0.042) * (reg ** 0.3), 0.0065],
  ];
  for (const [kf, ka, ktau] of knocks) {
    const w = 2 * Math.PI * kf / sr, cw = Math.cos(w), sw = Math.sin(w), d = Math.exp(-1 / (sr * ktau));
    const nK = Math.min(out.length, Math.floor(ktau * 7 * sr));
    let re = 1, im = 0, env = ka;
    for (let i = 0; i < nK; i++) {
      out[i] += env * (i / (i + 18)) * im;
      env *= d;
      const nr = re * cw - im * sw; im = re * sw + im * cw; re = nr;
    }
  }
  // 3. Brief broadband felt-to-wire graze burst (decays in ~7ms)
  addBandpassNoise(out, sr, Math.min(f0 * (yamaha ? 3.2 : 2.4), yamaha ? 2600 : 1850), 1.8, local ? 0.020 : yamaha ? 0.042 : 0.028, 0.0065, 0, 0.008);
}

function addGuitarPluck(out, sr, f0, isElectric) {
  if (!isElectric) {
    // Acoustic Finger Pluck: wide fingertip flesh pad (~14mm contact) releases into warm spruce/rosewood body modes
    // 1. Soft fingertip release displacement pulse (tau ~ 2.4ms)
    const tauP = 0.0024, nP = Math.min(out.length, Math.floor(tauP * 3.0 * sr));
    for (let i = 0; i < nP; i++) {
      const t = i / sr, u = Math.min(1, t / tauP);
      out[i] += 0.072 * (Math.sin(Math.PI * u) ** 2.4) * Math.exp(-t / 0.0022);
    }
    // 2. Helmholtz soundhole air thump (98Hz) + spruce top plate tap (205Hz) + warm flesh-nail release (520Hz)
    const taps = [[98, 0.078, 0.022], [205, 0.064, 0.015], [Math.min(950, f0 * 2.1), 0.032, 0.008]];
    for (const [tf, ta, ttau] of taps) {
      const w = 2 * Math.PI * tf / sr, cw = Math.cos(w), sw = Math.sin(w), d = Math.exp(-1 / (sr * ttau));
      const nT = Math.min(out.length, Math.floor(ttau * 6.5 * sr));
      let re = 1, im = 0, env = ta;
      for (let i = 0; i < nT; i++) {
        out[i] += env * (i / (i + 16)) * im;
        env *= d;
        const nr = re * cw - im * sw; im = re * sw + im * cw; re = nr;
      }
    }
    // 3. Gentle flesh-on-bronze-winding release brush
    addBandpassNoise(out, sr, Math.min(f0 * 2.4, 1550), 1.7, 0.036, 0.0075, 0, 0.009);
  } else {
    // Electric Picked Pluck: rigid plectrum (~1.5mm tip) snaps off nickel-wound string with bright pick click
    // 1. Fast, snappy plectrum release impulse (tau ~ 0.75ms)
    const tauP = 0.00075, nP = Math.min(out.length, Math.floor(tauP * 3.5 * sr));
    for (let i = 0; i < nP; i++) {
      const t = i / sr, u = Math.min(1, t / tauP);
      out[i] += 0.135 * Math.sin(Math.PI * u) * Math.exp(-t / 0.0007);
    }
    // 2. Metallic fret/bridge transient (420Hz) + plectrum-edge chirp (2350Hz)
    const clicks = [[420, 0.055, 0.007], [Math.min(2950, Math.max(1850, f0 * 6.0)), 0.095, 0.0048]];
    for (const [cf, ca, ctau] of clicks) {
      const w = 2 * Math.PI * cf / sr, cw = Math.cos(w), sw = Math.sin(w), d = Math.exp(-1 / (sr * ctau));
      const nC = Math.min(out.length, Math.floor(ctau * 6.5 * sr));
      let re = 1, im = 0, env = ca;
      for (let i = 0; i < nC; i++) {
        out[i] += env * (i / (i + 6)) * im;
        env *= d;
        const nr = re * cw - im * sw; im = re * sw + im * cw; re = nr;
      }
    }
    // 3. Crisp plectrum scrape across nickel winding
    addBandpassNoise(out, sr, Math.min(f0 * 6.2, 3200), 2.2, 0.088, 0.0052, 0, 0.006);
  }
}

function renderPercussive(inst, f0, sr, amps) {
  const dur = inst === 'piano' ? 5.2 : 2.4, n = Math.floor(sr * dur), out = new Float32Array(n);
  const prof = customProfiles[inst], v = prof?.voicing ?? 'kawai', yamaha = v === 'yamaha', local = v === 'kg2a' || v === 'local';
  // Piano inharmonicity curve: rises in deep wound bass and short treble, minimal in mid register (Fletcher & Rossing)
  const octOffset = Math.log2(f0 / 261.63);
  const bPianoCurve = 0.000095 * (1 + 0.36 * (octOffset < 0 ? octOffset * octOffset : octOffset * 1.35));
  const B = prof?.B ?? (inst === 'piano' ? bPianoCurve : inst === 'epiano' ? 0 : 0.00007);
  // Kawai RX/GX Warm Grand default: warm singing decay with authentic grand piano string resonance
  const tSlowExp = inst === 'epiano' ? 0.25 : (inst === 'piano' && local ? 0.62 : 0.46);
  const tSlowBase = Math.max(0.35, (prof?.tSlow ?? { piano: yamaha ? 1.85 : 2.2, epiano: 1.75, guitar: 0.78, eguitar: 1.25 }[inst]) * ((261.63 / f0) ** tSlowExp));
  const tFastBase = prof?.tFast ?? { piano: local ? 0.22 : yamaha ? 0.14 : 0.16, epiano: 0.20, guitar: 0.095, eguitar: 0.14 }[inst];
  const wFastBase = { piano: local ? 0.30 : yamaha ? 0.36 : 0.30, epiano: 0.38, guitar: 0.48, eguitar: 0.44 }[inst];

  for (let k = 1; k <= 12; k++) {
    const fk = f0 * k * Math.sqrt(1 + B * k * k);
    if (fk >= sr * 0.46) break;
    const amp = amps[k - 1];
    // Finger-plucked acoustic guitar has a rounder ~5.2ms flesh release; picked electric guitar snaps in ~0.9ms
    const tauAtk = inst === 'piano'
      ? Math.max(0.0009, (yamaha ? 0.0046 : 0.0056) * ((261.63 / Math.max(90, f0)) ** 0.25) / (k ** 0.58))
      : inst === 'guitar' ? 0.0052 * (1 + 0.12 * (k - 1))
      : inst === 'eguitar' ? 0.0009 / (k ** 0.65)
      : 0.0030 / (k ** 0.35);
    const dAtk = Math.exp(-1 / (sr * tauAtk));
    // Upper-partial transient flash: hammer compression (piano), plectrum snap (eguitar), or gentle finger bloom (guitar)
    const wTransient = k >= 3
      ? (inst === 'piano' ? (local ? 0.28 : yamaha ? 0.58 : 0.40) * Math.min(1.6, ((k - 2) / 4) ** 0.65)
        : inst === 'eguitar' ? 0.85 * Math.min(1.9, ((k - 2) / 3.0) ** 0.65)
        : inst === 'guitar' ? 0.08 * Math.exp(-0.45 * (k - 3)) : 0)
      : 0;
    const wf = (k > 1 ? wFastBase : wFastBase * 0.48) + wTransient;
    const tauF = Math.max(0.014, (tFastBase * (wTransient ? 0.45 : 1)) / (k ** (inst === 'guitar' ? 0.92 : 0.72)));
    const tauS = Math.max(0.04, tSlowBase / (k ** (inst === 'guitar' ? 0.85 : inst === 'eguitar' ? 0.58 : 0.72)));
    const df = Math.exp(-1 / (sr * tauF)), ds = Math.exp(-1 / (sr * tauS));
    const df32 = df ** 32, ds32 = ds ** 32;
    // Register-scaled beating rate: slow unisons on bass (0.2Hz), active trichord bloom on mid/treble (0.4-0.8Hz)
    const wbRate = inst === 'piano'
      ? (0.20 + 0.14 * Math.sqrt(Math.max(40, f0) / 261.63) + 0.06 * (k - 1))
      : (0.32 + 0.15 * k);
    const wb32 = 2 * Math.PI * wbRate * 32 / sr, cwb32 = Math.cos(wb32), swb32 = Math.sin(wb32);
    const w = 2 * Math.PI * fk / sr, cw = Math.cos(w), sw = Math.sin(w);
    let re = Math.cos(k * 0.4), im = Math.sin(k * 0.4), rb = 1, ib = 0;
    // Coupled unison detuning for acoustic piano trichords on fundamental and octave (authentic prompt-to-aftersound interference)
    const coupledUnison = inst === 'piano' && k <= 2;
    let re2 = Math.cos(k * 0.4 + 0.5), im2 = Math.sin(k * 0.4 + 0.5);
    const w2 = coupledUnison ? 2 * Math.PI * (fk + (k === 1 ? 0.28 : -0.32)) / sr : w;
    const cw2 = Math.cos(w2), sw2 = Math.sin(w2);
    let ef = wf, es = 1 - (k > 1 ? wFastBase : wFastBase * 0.48), ea = 1;
    const nAtkEnd = Math.min(n, Math.floor(sr * tauAtk * 8));
    const nActive = Math.min(n, Math.floor(sr * Math.max(0.35, tauS * 4.5)));
    // Phase 1: fast per-sample attack & transient window (first ~10–40ms)
    for (let i = 0; i < nAtkEnd; i++) {
      const atk = (1 - ea) * (1 - 0.35 * ea);
      const osc = coupledUnison ? (0.68 * im + 0.32 * im2) : im;
      out[i] += amp * atk * (ef + es) * osc;
      ef *= df; es *= ds; ea *= dAtk;
      const nr = re * cw - im * sw; im = re * sw + im * cw; re = nr;
      if (coupledUnison) { const nr2 = re2 * cw2 - im2 * sw2; im2 = re2 * sw2 + im2 * cw2; re2 = nr2; }
    }
    // Phase 2: 1 kHz control-rate block envelope + unison string-beating interpolation (zero subnormals, ~3x fewer ops)
    let curEnv = amp * (ef + es) * (inst === 'epiano' ? 1 : 0.86 + 0.14 * rb), dEnv = 0;
    for (let i = nAtkEnd; i < nActive; i++) {
      if (((i - nAtkEnd) & 31) === 0) {
        ef = ef * df32 + 1e-24; es = es * ds32 + 1e-24;
        const nrb = rb * cwb32 - ib * swb32; ib = rb * swb32 + ib * cwb32; rb = nrb;
        const nextEnv = amp * (ef + es) * (inst === 'epiano' ? 1 : 0.86 + 0.14 * rb);
        dEnv = (nextEnv - curEnv) * 0.03125;
      }
      curEnv += dEnv;
      const osc = coupledUnison ? (0.68 * im + 0.32 * im2) : im;
      out[i] += curEnv * osc;
      const nr = re * cw - im * sw; im = re * sw + im * cw; re = nr;
      if (coupledUnison) { const nr2 = re2 * cw2 - im2 * sw2; im2 = re2 * sw2 + im2 * cw2; re2 = nr2; }
    }
  }
  const rawSymp = OPEN_STRINGS[inst]
    ? unselectedStringModes(inst, f0).filter(([sf]) => Math.abs(sf - Math.round(sf / f0) * f0) >= 6).sort((a, b) => b[1] - a[1]).slice(0, 4)
    : inst === 'piano' ? [[f0 * 2.0005, 0.022, 1.65], [f0 * 3.001, 0.012, 1.35]] : [];
  for (const [sf, sa, sdec] of rawSymp) {
    if (sf >= sr * 0.46) continue;
    const w = 2 * Math.PI * sf / sr, cw = Math.cos(w), sw = Math.sin(w);
    const ds = Math.exp(-1 / (sr * sdec)), da = Math.exp(-1 / (sr * 0.045));
    let re = 1, im = 0, es = sa * 0.5, ea = 1;
    const nSymp = Math.min(n, Math.floor(sr * sdec * 3.2));
    for (let i = 0; i < nSymp; i++) {
      out[i] += (1 - ea) * es * im;
      es = es * ds + 1e-24; ea = ea * da + 1e-24;
      const nr = re * cw - im * sw; im = re * sw + im * cw; re = nr;
    }
  }
  if (inst === 'epiano') {
    const wt = 2 * Math.PI * 4.5 / sr, ct = Math.cos(wt), st = Math.sin(wt);
    let rt = 1, it = 0;
    for (let i = 0; i < n; i++) { out[i] *= 1 + 0.08 * it; const nr = rt * ct - it * st; it = rt * st + it * ct; rt = nr; }
  } else if (inst === 'piano') {
    addPianoHammerHit(out, sr, f0, yamaha, local);
  } else if (inst === 'guitar' || inst === 'eguitar') {
    addGuitarPluck(out, sr, f0, inst === 'eguitar');
    if (inst === 'guitar') {
      // Warm fingertip-pad low-pass smoothing (~1.4kHz during the initial 22ms flesh contact, opening to 3.4kHz)
      let fLp = 0, fEnv = 1;
      const dFEnv = Math.exp(-1 / (sr * 0.022));
      for (let i = 0; i < n; i++) {
        const aLp = 0.38 - 0.20 * fEnv;
        fEnv = fEnv * dFEnv + 1e-24;
        fLp += aLp * (out[i] - fLp);
        out[i] = 0.30 * out[i] + 0.70 * fLp;
      }
    } else {
      // Dynamic asymmetric tube-amp overdrive (crunchier on initial pick attack, singing warm compression in sustain)
      // followed by a 12" guitar speaker cabinet presence filter (~4.1kHz) for unmistakable electric guitar bite
      let cabLp = 0, dc = 0, driveEnv = 1;
      const dDrive = Math.exp(-1 / (sr * 0.24)), aCab = Math.exp(-2 * Math.PI * 4100 / sr);
      for (let i = 0; i < n; i++) {
        const g = 2.35 + 1.55 * driveEnv;
        driveEnv = driveEnv * dDrive + 1e-24;
        const x = out[i] * g + 0.095;
        const sat = (x / (1 + 0.62 * Math.abs(x))) - 0.088;
        dc = 0.995 * dc + 0.005 * sat;
        cabLp = (1 - aCab) * (sat - dc) + aCab * cabLp;
        out[i] = 0.32 * out[i] + 0.68 * cabLp;
      }
    }
  }
  // Shape beginning (1.2ms anti-click cosine rise) and end (180ms or 350ms smooth tail fade-out) of the buffer
  const nIn = Math.floor(0.0012 * sr), nOut = Math.floor((inst === 'piano' ? 0.35 : 0.18) * sr);
  for (let i = 0; i < nIn; i++) out[i] = out[i] * (0.5 - 0.5 * Math.cos(Math.PI * i / nIn)) + 0;
  for (let i = 0; i < nOut; i++) out[n - 1 - i] = out[n - 1 - i] * (0.5 - 0.5 * Math.cos(Math.PI * i / nOut)) + 0;
  return { data: out, loopStart: 0, loopEnd: 0, sustained: false };
}

function renderSustained(inst, f0, sr, amps) {
  const loopStart = 0.80, loopSpan = Math.round(1.60 * f0) / f0, loopEnd = loopStart + loopSpan;
  const dur = loopEnd + 0.15, n = Math.floor(sr * dur), out = new Float32Array(n);
  const bowed = inst === 'violin' || inst === 'cello';
  const atkTau = { violin: 0.048, cello: 0.058, trumpet: 0.022, flute: 0.045, sax: 0.022, synth: 0.010 }[inst] ?? 0.02;
  const vibCents = { violin: 26, cello: 24, trumpet: 8.5, flute: 11, sax: 13, synth: 4 }[inst] ?? 6;
  // Exact integer vibrato cycles per loopSpan (9 cycles ~ 5.625Hz for strings, 8 cycles ~ 5.0Hz for winds)
  const vibCycles = bowed ? 9 : 8;
  const dBase = 2 * Math.PI * f0 / sr, baseC = Math.cos(dBase), baseS = Math.sin(dBase);
  const dt = 32 / sr;
  const wVib32 = 2 * Math.PI * (vibCycles / loopSpan) * dt, cv32 = Math.cos(wVib32), sv32 = Math.sin(wVib32);
  // Secondary slow bow-pressure / speed drift LFO (2 cycles per loopSpan ~ 1.25Hz) so the tone is never sterile
  const wBow32 = 2 * Math.PI * (2 / loopSpan) * dt, cb32 = Math.cos(wBow32), sb32 = Math.sin(wBow32);
  const vibScale = (vibCents / 1200) * Math.LN2, bowDriftScale = ((bowed ? 4.2 : 1.5) / 1200) * Math.LN2;
  const dAtk32 = Math.exp(-dt / atkTau), dBloom32 = Math.exp(-dt / (bowed ? 0.034 : 0.022));
  // Initial bow "grab" state: during the first ~48ms of stick-slip capture, pitch scoops slightly flat (-18 cents -> 0)
  // while odd/upper partials surge briefly before locking into the Helmholtz sawtooth corner
  const dGrab32 = Math.exp(-dt / (inst === 'cello' ? 0.032 : 0.026));
  let maxK = 12;
  while (maxK > 1 && f0 * maxK >= sr * 0.46) maxK--;
  const modR = new Float32Array(12), modI = new Float32Array(12);
  const dModR = new Float32Array(12), dModI = new Float32Array(12);
  const phR = new Float32Array(12), phI = new Float32Array(12);
  for (let k = 0; k < maxK; k++) { phR[k] = Math.cos((k + 1) * 0.4); phI[k] = Math.sin((k + 1) * 0.4); }

  let c1 = 1, s1 = 0, vc = 1, vs = 0, bc = 1, bs = 0, eAtk = 1, eBloom = 1, eGrab = bowed ? 1 : 0;
  let stepC = baseC, stepS = baseS;

  const evalSustainedBlock = (sampleIdx, init) => {
    const t = sampleIdx / sr;
    const vibEnv = bowed ? (t < 0.04 ? 0 : t < 0.18 ? (t - 0.04) / 0.14 : 1) : (t < 0.12 ? 0 : t < 0.34 ? (t - 0.12) / 0.22 : 1);
    const grabPitch = bowed ? -0.011 * eGrab * (1 - 2.2 * eGrab * eGrab) : 0;
    const d = dBase * (vibEnv * (vibScale * vc + bowDriftScale * bs) + grabPitch);
    stepC = baseC - d * baseS; stepS = baseS + d * baseC;

    const u = 1 - eAtk;
    const grabBite = bowed ? 1 + 0.38 * eGrab * u : 1;
    const bowBreath = bowed ? 1 + 0.075 * vibEnv * vs + 0.055 * bc : 1 + 0.03 * vibEnv * vs;
    const atk = u * u * (3 - 2 * u) * grabBite * bowBreath;
    for (let k = 0; k < maxK; k++) {
      const bl = bowed
        ? (k >= 2 ? 1 + 0.95 * eGrab * Math.min(1.6, k * 0.32) : 1 - 0.22 * eGrab)
        : 1 - (k > 1 ? 0.48 : 0.12) * eBloom;
      const shimmer = bowed && k > 0
        ? 1 + vibEnv * ((k & 1) ? 0.18 * vc + 0.09 * bc : -0.15 * vs - 0.08 * bs)
        : 1;
      const a = amps[k] * atk * bl * shimmer;
      const nr = a * phR[k], ni = a * phI[k];
      if (init) { modR[k] = nr; modI[k] = ni; }
      else { dModR[k] = (nr - modR[k]) * 0.03125; dModI[k] = (ni - modI[k]) * 0.03125; }
    }
    const nvc = vc * cv32 - vs * sv32; vs = vc * sv32 + vs * cv32; vc = nvc;
    const nbc = bc * cb32 - bs * sb32; bs = bc * sb32 + bs * cb32; bc = nbc;
    eAtk = eAtk * dAtk32 + 1e-24; eBloom = eBloom * dBloom32 + 1e-24; eGrab = eGrab * dGrab32 + 1e-24;
  };

  evalSustainedBlock(0, true);
  for (let i = 0; i < n; i++) {
    if ((i & 31) === 0) {
      evalSustainedBlock(i + 32, false);
      const g = 1.5 - 0.5 * (c1 * c1 + s1 * s1); c1 *= g; s1 *= g;
    }
    const nc1 = c1 * stepC - s1 * stepS; s1 = c1 * stepS + s1 * stepC; c1 = nc1;
    let rk = c1, ik = s1, sum = 0;
    for (let k = 0; k < maxK; k++) {
      modR[k] += dModR[k]; modI[k] += dModI[k];
      sum += ik * modR[k] + rk * modI[k];
      const nr = rk * c1 - ik * s1; ik = rk * s1 + ik * c1; rk = nr;
    }
    out[i] = sum;
  }
  if (OPEN_STRINGS[inst]) {
    const topSymp = unselectedStringModes(inst, f0)
      .filter(([sf]) => sf < sr * 0.46 && Math.abs(sf - Math.round(sf / f0) * f0) >= 6)
      .sort((a, b) => b[1] - a[1]).slice(0, 4);
    for (const [sf, sa] of topSymp) {
      const w = 2 * Math.PI * sf / sr, cw = Math.cos(w), sw = Math.sin(w), da = Math.exp(-1 / (sr * 0.08));
      let re = 1, im = 0, ea = 1;
      for (let i = 0; i < n; i++) { out[i] += sa * 0.35 * (1 - ea) * im; ea = ea * da + 1e-24; const nr = re * cw - im * sw; im = re * sw + im * cw; re = nr; }
    }
  }
  if (bowed) {
    // 1. Initial bow-hair "grab" crunch (low-mid bridge/wood thump + crisp rosin stick-slip burst during first 35ms)
    addBandpassNoise(out, sr, Math.min(f0 * 1.6, 680), 1.4, inst === 'cello' ? 0.085 : 0.068, 0.022, 0.004, atkTau);
    addBandpassNoise(out, sr, inst === 'cello' ? 1450 : 2650, 1.8, inst === 'cello' ? 0.062 : 0.072, 0.026, 0.011, atkTau);
    // 2. Continuous bow-hair rosin friction modulated by the waveform & bow-pressure cycle so tone has organic grit
    const hair = new Float32Array(n);
    addBandpassNoise(hair, sr, Math.min(f0 * 3.5, inst === 'cello' ? 1850 : 3100), 2.1, 0.025, 0.04, 0.016, atkTau);
    for (let i = 0; i < n; i++) out[i] += hair[i] * (0.65 + 0.55 * Math.abs(out[i]));
  } else {
    const nCfg = {
      trumpet: [1250, 2.0, 0.028, 0.018, 0.003], flute: [Math.min(f0 * 2.4, 2400), 2.5, 0.038, 0.035, 0.01],
      sax: [1600, 1.8, 0.032, 0.02, 0.007],
    }[inst];
    if (nCfg) addBandpassNoise(out, sr, nCfg[0], nCfg[1], nCfg[2], nCfg[3], nCfg[4], atkTau);
  }
  const nIn = Math.floor(0.003 * sr);
  for (let i = 0; i < nIn; i++) out[i] = out[i] * (0.5 - 0.5 * Math.cos(Math.PI * i / nIn)) + 0;

  // Smooth 30ms raised-cosine crossfade at loopEnd so looping [loopStart, loopEnd) matches value and slope
  const iStart = Math.floor(loopStart * sr), iEnd = Math.floor(loopEnd * sr), xf = Math.floor(0.03 * sr);
  for (let i = 0; i < xf; i++) {
    const a = 0.5 - 0.5 * Math.cos(Math.PI * (i + 1) / xf);
    out[iEnd - xf + i] = out[iEnd - xf + i] * (1 - a) + out[iStart - xf + i] * a;
  }
  return { data: out, loopStart, loopEnd, sustained: true };
}

function renderChoir(f0, sr, amps) {
  const loopStart = 0.80, loopSpan = Math.round(1.60 * f0) / f0, loopEnd = loopStart + loopSpan;
  const dur = loopEnd + 0.15, n = Math.floor(sr * dur), out = new Float32Array(n);
  // 16-singer SATB ensemble (4 Sopranos, 4 Altos, 4 Tenors, 4 Basses):
  // [dfCyclesPerLoop, vibCycles, vibCents, driftCycles, driftCents, tractScale, onsetDelaySec, atkTau, ph0]
  // Integer dfCyclesPerLoop & vibCycles/driftCycles guarantee exact loop periodicity across [loopStart, loopEnd)
  const singers = [
    // Sopranos (shorter vocal tract 0.86..0.92 -> brighter open "ahhh" formants, agile vibrato)
    [ 0,  9, 13.5, 1, 3.2, 0.87, 0.000, 0.068, 0.00],
    [-1, 10, 15.0, 2, 4.0, 0.89, 0.014, 0.076, 0.78],
    [ 1,  8, 14.0, 3, 3.6, 0.86, 0.029, 0.082, 1.57],
    [ 2, 11, 12.5, 1, 4.4, 0.91, 0.046, 0.088, 2.35],
    // Altos (warm mezzo vocal tract 0.93..0.98)
    [-2,  8, 15.5, 2, 4.5, 0.94, 0.008, 0.074, 3.14],
    [ 0,  7, 14.5, 3, 3.8, 0.96, 0.022, 0.084, 3.92],
    [ 2,  9, 16.0, 1, 4.8, 0.93, 0.038, 0.092, 4.71],
    [-3,  8, 13.0, 2, 4.2, 0.98, 0.055, 0.098, 5.49],
    // Tenors (rich chest-resonated vocal tract 1.01..1.06)
    [ 1,  8, 16.5, 2, 4.6, 1.02, 0.012, 0.078, 0.42],
    [-1,  7, 15.0, 1, 5.0, 1.04, 0.026, 0.086, 1.89],
    [ 3,  9, 14.0, 3, 3.9, 1.01, 0.042, 0.095, 3.36],
    [-2,  7, 17.0, 2, 5.2, 1.06, 0.060, 0.104, 4.83],
    // Basses (deep resonant vocal tract 1.08..1.14 -> darker "ohhh/ahhh" warmth)
    [ 0,  7, 14.0, 1, 3.6, 1.09, 0.018, 0.085, 1.12],
    [-3,  6, 16.0, 2, 4.8, 1.12, 0.034, 0.096, 2.68],
    [ 2,  8, 13.5, 3, 4.4, 1.08, 0.050, 0.106, 4.15],
    [ 3,  7, 15.5, 1, 5.1, 1.14, 0.068, 0.115, 5.72],
  ];
  const nSingers = singers.length;
  let maxK = 12;
  while (maxK > 1 && f0 * maxK >= sr * 0.46) maxK--;

  // Precompute per-singer harmonic weights and zero-trig 1 kHz control-rate oscillator coefficients
  const dt = 32 / sr;
  const sAmp = new Float32Array(nSingers * 12);
  const cPh = new Float32Array(nSingers), sPh = new Float32Array(nSingers);
  const cVib = new Float32Array(nSingers), sVib = new Float32Array(nSingers), dVibC = new Float32Array(nSingers), dVibS = new Float32Array(nSingers);
  const cDr = new Float32Array(nSingers), sDr = new Float32Array(nSingers), dDrC = new Float32Array(nSingers), dDrS = new Float32Array(nSingers);
  const eAtks = new Float32Array(nSingers), dAtks = new Float32Array(nSingers);
  const dfBaseRad = new Float32Array(nSingers), vibRad = new Float32Array(nSingers), drRad = new Float32Array(nSingers);

  for (let v = 0; v < nSingers; v++) {
    const [dfCyc, vCyc, vCents, dCyc, dCents, tract, , atkTau, ph0] = singers[v];
    for (let k = 0; k < maxK; k++) {
      const fk = (k + 1) * f0 / tract;
      const vShift = 0.80 + 0.22 * (gaussOct(fk, 740, 0.32) + 1.15 * gaussOct(fk, 1140, 0.28) + 0.45 * gaussOct(fk, 2820, 0.42));
      // 16 singers normalized by 1/sqrt(16) with staggered harmonic dominance so H1..H12 never cancel
      sAmp[v * 12 + k] = amps[k] * ((v % 4) === (k % 4) ? 0.28 : 0.12) * vShift;
    }
    const p0 = ph0 * 0.37;
    cPh[v] = Math.cos(p0); sPh[v] = Math.sin(p0);
    cVib[v] = Math.cos(ph0); sVib[v] = Math.sin(ph0);
    const wV = 2 * Math.PI * (vCyc / loopSpan) * dt;
    dVibC[v] = Math.cos(wV); dVibS[v] = Math.sin(wV);
    cDr[v] = Math.cos(ph0 * 1.7); sDr[v] = Math.sin(ph0 * 1.7);
    const wD = 2 * Math.PI * (dCyc / loopSpan) * dt;
    dDrC[v] = Math.cos(wD); dDrS[v] = Math.sin(wD);
    eAtks[v] = 1; dAtks[v] = Math.exp(-dt / atkTau);
    dfBaseRad[v] = 2 * Math.PI * (dfCyc / loopSpan) * dt;
    vibRad[v] = 2 * Math.PI * f0 * ((vCents / 1200) * Math.LN2) * dt;
    drRad[v] = 2 * Math.PI * f0 * ((dCents / 1200) * Math.LN2) * dt;
  }

  const dBase = 2 * Math.PI * f0 / sr, baseC = Math.cos(dBase), baseS = Math.sin(dBase);
  const modR = new Float32Array(12), modI = new Float32Array(12);
  const dModR = new Float32Array(12), dModI = new Float32Array(12);
  const nextR = new Float32Array(12), nextI = new Float32Array(12);
  let c1 = 1, s1 = 0;

  const evalChorusBlock = sampleIdx => {
    nextR.fill(0); nextI.fill(0);
    const tSec = sampleIdx / sr;
    for (let v = 0; v < nSingers; v++) {
      const t = tSec - singers[v][6];
      if (t <= 0) continue;
      eAtks[v] *= dAtks[v];
      const u = 1 - eAtks[v], atk = u * u * (3 - 2 * u);
      const vEnv = t < 0.08 ? 0 : t < 0.32 ? (t - 0.08) * 4.1667 : 1;
      // Advance singer vibrato and vowel-drift LFOs via zero-trig complex rotation
      const nvc = cVib[v] * dVibC[v] - sVib[v] * dVibS[v];
      sVib[v] = cVib[v] * dVibS[v] + sVib[v] * dVibC[v]; cVib[v] = nvc;
      const ndc = cDr[v] * dDrC[v] - sDr[v] * dDrS[v];
      sDr[v] = cDr[v] * dDrS[v] + sDr[v] * dDrC[v]; cDr[v] = ndc;
      // Advance singer detune + vibrato phase via 2nd-order Padé/Taylor rotation (|dTheta| < 0.025 rad)
      const dTheta = dfBaseRad[v] + vEnv * (vibRad[v] * cVib[v] + drRad[v] * sDr[v]);
      const cd = 1 - 0.5 * dTheta * dTheta, sd = dTheta;
      let c1v = cPh[v] * cd - sPh[v] * sd, s1v = cPh[v] * sd + sPh[v] * cd;
      const g = 1.5 - 0.5 * (c1v * c1v + s1v * s1v);
      cPh[v] = (c1v *= g); sPh[v] = (s1v *= g);

      const vowelMod = 1 + 0.16 * vEnv * sDr[v];
      let rkv = c1v, ikv = s1v;
      const baseIdx = v * 12;
      for (let k = 0; k < maxK; k++) {
        const a = sAmp[baseIdx + k] * atk * (k === 0 ? 1 : vowelMod);
        nextR[k] += a * rkv; nextI[k] += a * ikv;
        const nr = rkv * c1v - ikv * s1v; ikv = rkv * s1v + ikv * c1v; rkv = nr;
      }
    }
  };

  evalChorusBlock(0);
  modR.set(nextR); modI.set(nextI);
  for (let i = 0; i < n; i++) {
    if ((i & 31) === 0) {
      evalChorusBlock(i + 32);
      for (let k = 0; k < maxK; k++) {
        dModR[k] = (nextR[k] - modR[k]) * 0.03125;
        dModI[k] = (nextI[k] - modI[k]) * 0.03125;
      }
      const g = 1.5 - 0.5 * (c1 * c1 + s1 * s1); c1 *= g; s1 *= g;
    }
    const nc1 = c1 * baseC - s1 * baseS; s1 = c1 * baseS + s1 * baseC; c1 = nc1;
    let rk = c1, ik = s1, sum = 0;
    for (let k = 0; k < maxK; k++) {
      modR[k] += dModR[k]; modI[k] += dModI[k];
      sum += ik * modR[k] + rk * modI[k];
      const nr = rk * c1 - ik * s1; ik = rk * s1 + ik * c1; rk = nr;
    }
    out[i] = sum;
  }

  // Dual-band SATB formant breathiness ("hahhh" F1 ~ 760Hz + F2 ~ 1150Hz) with warm 2.2kHz low-pass smoothing
  const breath = new Float32Array(n);
  addBandpassNoise(breath, sr, 760, 2.4, 0.024, 0.10, 0.012, 0.10);
  addBandpassNoise(breath, sr, 1160, 2.2, 0.026, 0.09, 0.013, 0.09);
  let lp = 0;
  for (let i = 0; i < n; i++) {
    lp = 0.68 * lp + 0.32 * breath[i];
    out[i] += lp * (0.75 + 0.25 * out[i]);
  }

  // Centered 60ms RMS envelope stabilizer with smooth sample-by-sample interpolation and 160ms onset ramp-in
  const hw = Math.floor(0.030 * sr), iLoop0 = Math.floor(0.18 * sr), rampLen = Math.floor(0.16 * sr);
  const sqPrefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) sqPrefix[i + 1] = sqPrefix[i] + out[i] * out[i];
  const rmsGainAt = idx => {
    if (idx < iLoop0) return 1;
    const a = Math.max(0, idx - hw), b = Math.min(n, idx + hw);
    const locRms = Math.sqrt(Math.max(1e-6, (sqPrefix[b] - sqPrefix[a]) / (b - a)));
    const rawG = Math.min(1.65, Math.max(0.68, (0.28 / locRms) ** 0.74));
    const mix = Math.min(1, (idx - iLoop0) / rampLen);
    return 1 + mix * (rawG - 1);
  };
  let gRms = 1, dGRms = 0;
  for (let i = iLoop0; i < n; i++) {
    if ((i & 15) === 0) {
      const nextG = rmsGainAt(Math.min(n - 1, i + 16));
      dGRms = (nextG - gRms) * 0.0625;
    }
    gRms += dGRms;
    out[i] *= gRms;
  }
  const nIn = Math.floor(0.006 * sr);
  for (let i = 0; i < nIn; i++) out[i] = out[i] * (0.5 - 0.5 * Math.cos(Math.PI * i / nIn)) + 0;
  // Smooth 40ms raised-cosine crossfade at loopEnd so looping [loopStart, loopEnd) matches value and slope
  const iStart = Math.floor(loopStart * sr), iEnd = Math.floor(loopEnd * sr), xf = Math.floor(0.04 * sr);
  for (let i = 0; i < xf; i++) {
    const a = 0.5 - 0.5 * Math.cos(Math.PI * (i + 1) / xf);
    out[iEnd - xf + i] = out[iEnd - xf + i] * (1 - a) + out[iStart - xf + i] * a;
  }
  return { data: out, loopStart, loopEnd, sustained: true };
}

/** Pure synthesis of one note for (inst, midi) at sample rate sr. */
export function synthesizeNote(inst, midi, sr = SYNTH_SR) {
  const id = inst || 'synth', f0 = freqOf(midi);
  const amps = harmonicAmps(id, f0);
  if (id === 'choir') return renderChoir(f0, sr, amps);
  return SUSTAINED.has(id) ? renderSustained(id, f0, sr, amps) : renderPercussive(id, f0, sr, amps);
}

// ---------- Web Audio runtime, cache & scheduler ----------
let ctx = null, master = null;
const noteCache = new Map();

export function ensure() {
  if (typeof window === 'undefined') return null;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  if (!ctx) {
    ctx = new AC();
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch {}
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14; comp.knee.value = 18; comp.ratio.value = 3;
    comp.connect(ctx.destination);
    master = ctx.createGain(); master.gain.value = 0.34;
    const dry = ctx.createGain(); dry.gain.value = 0.88;
    const wet = ctx.createGain(); wet.gain.value = 0.15;
    const conv = ctx.createConvolver();
    const irLen = Math.floor(ctx.sampleRate * 0.85), ir = ctx.createBuffer(2, irLen, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = ir.getChannelData(ch);
      let seed = 10007 + ch * 9973, lp = 0;
      for (let i = 0; i < irLen; i++) {
        seed = (seed * 16807) % 2147483647;
        lp = 0.72 * lp + 0.28 * (seed / 1073741824 - 1);
        d[i] = (i < ctx.sampleRate * 0.012 ? i / (ctx.sampleRate * 0.012) : 1) * Math.exp(-i / (ctx.sampleRate * 0.22)) * lp;
      }
    }
    conv.buffer = ir;
    master.connect(dry); dry.connect(comp);
    master.connect(conv); conv.connect(wet); wet.connect(comp);
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

export const HD_SAMPLE_GAIN_BOOST = 1.25;

// ---------- HD Audio Sample Engine (On-demand CDN streaming + persistent CacheStorage) ----------
export const SAMPLE_FOLDERS = {
  piano: 'acoustic_grand_piano-mp3',
  epiano: 'electric_piano_1-mp3',
  guitar: 'acoustic_guitar_steel-mp3',
  eguitar: 'electric_guitar_clean-mp3',
  violin: 'violin-mp3',
  cello: 'cello-mp3',
  trumpet: 'trumpet-mp3',
  flute: 'flute-mp3',
  sax: 'tenor_sax-mp3',
  choir: 'choir_aahs-mp3',
  synth: 'lead_1_square-mp3',
};

const NOTE_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
export function sampleNoteName(midi) {
  const step = NOTE_NAMES[((midi % 12) + 12) % 12];
  const oct = Math.floor(midi / 12) - 1;
  return `${step}${oct}`;
}

export function sampleUrl(inst, midi) {
  const folder = SAMPLE_FOLDERS[inst] || SAMPLE_FOLDERS.piano;
  return `https://cdn.jsdelivr.net/gh/gleitz/midi-js-soundfonts@gh-pages/FluidR3_GM/${folder}/${sampleNoteName(midi)}.mp3`;
}

const sampleCache = new Map();
const loadingSamples = new Map();
let hdSamplesEnabled = false;
try {
  hdSamplesEnabled = typeof localStorage !== 'undefined' && localStorage.getItem('tuneshare_hd_samples') === '1';
} catch {}

let currentWarmingTune = null;
const progressListeners = new Set();

export function onSampleProgress(fn) {
  progressListeners.add(fn);
  return () => progressListeners.delete(fn);
}

export function getSampleLoadingProgress(tune = currentWarmingTune) {
  if (!tune) return { loaded: 0, total: 0, percent: 100, ready: true };
  const inst = tune.instrument || instrument || 'piano';
  const ordered = tunePlaybackOrder(tune);
  if (!ordered.length) return { loaded: 0, total: 0, percent: 100, ready: true };
  let loaded = 0;
  for (const m of ordered) {
    if (sampleCache.has(`${inst}:${m}`)) loaded++;
  }
  const percent = Math.round((loaded / ordered.length) * 100);
  return { loaded, total: ordered.length, percent, ready: loaded === ordered.length };
}

function emitSampleProgress(tune = currentWarmingTune) {
  if (progressListeners.size === 0) return;
  const p = getSampleLoadingProgress(tune);
  for (const fn of progressListeners) {
    try { fn(p); } catch {}
  }
}

export function isHdSamplesEnabled() { return hdSamplesEnabled; }
export function setHdSamplesEnabled(enabled) {
  hdSamplesEnabled = Boolean(enabled);
  try {
    if (typeof localStorage !== 'undefined') {
      if (enabled) localStorage.setItem('tuneshare_hd_samples', '1');
      else localStorage.removeItem('tuneshare_hd_samples');
    }
  } catch {}
  emitSampleProgress();
}

export function clearSampleCache() {
  sampleCache.clear();
  loadingSamples.clear();
  emitSampleProgress();
}

export async function loadSample(inst, midi) {
  const key = `${inst}:${midi}`;
  if (sampleCache.has(key)) return sampleCache.get(key);
  if (loadingSamples.has(key)) return loadingSamples.get(key);
  if (!ctx) ensure();
  if (!ctx || typeof fetch === 'undefined') return null;

  const url = sampleUrl(inst, midi);
  const promise = (async () => {
    try {
      let cache = null;
      try {
        if (typeof caches !== 'undefined') cache = await caches.open('tuneshare-samples-v1');
      } catch {}
      let resp = null;
      if (cache) {
        resp = await cache.match(url);
        if (!resp) {
          resp = await fetch(url);
          if (resp && resp.ok) cache.put(url, resp.clone());
        }
      } else {
        resp = await fetch(url);
      }
      if (!resp || !resp.ok) return null;
      const arrayBuf = await resp.arrayBuffer();
      const audioBuf = await ctx.decodeAudioData(arrayBuf);
      let peak = 0;
      for (let ch = 0; ch < audioBuf.numberOfChannels; ch++) {
        const data = audioBuf.getChannelData(ch);
        for (let i = 0; i < data.length; i++) {
          const a = Math.abs(data[i]);
          if (a > peak) peak = a;
        }
      }
      if (peak > 0.02) {
        const scale = Math.min(3.8, 0.96 / peak);
        for (let ch = 0; ch < audioBuf.numberOfChannels; ch++) {
          const data = audioBuf.getChannelData(ch);
          for (let i = 0; i < data.length; i++) data[i] *= scale;
        }
      }
      const isSus = SUSTAINED.has(inst);
      const entry = {
        buf: audioBuf,
        loopStart: isSus ? Math.max(0.4, audioBuf.duration * 0.3) : 0,
        loopEnd: isSus ? Math.max(0.8, audioBuf.duration * 0.8) : 0,
        sustained: isSus,
        isSample: true,
      };
      sampleCache.set(key, entry);
      emitSampleProgress();
      return entry;
    } catch {
      return null;
    } finally {
      loadingSamples.delete(key);
      emitSampleProgress();
    }
  })();

  loadingSamples.set(key, promise);
  return promise;
}

let instrument = 'piano';
/** Pick the sound for preview and playback (an id from src/instruments.js). */
export function setInstrument(id) { instrument = id || 'piano'; }

function getNoteBuffer(inst, midi) {
  const key = `${inst}:${midi}`;
  if (hdSamplesEnabled && sampleCache.has(key)) return sampleCache.get(key);
  if (hdSamplesEnabled && !loadingSamples.has(key)) {
    loadSample(inst, midi).catch(() => {});
  }
  if (noteCache.has(key)) return noteCache.get(key);
  if (noteCache.size > 160) noteCache.delete(noteCache.keys().next().value);
  const spec = synthesizeNote(inst, midi, SYNTH_SR);
  const buf = ctx.createBuffer(1, spec.data.length, SYNTH_SR);
  buf.getChannelData(0).set(spec.data);
  const entry = { buf, loopStart: spec.loopStart, loopEnd: spec.loopEnd, sustained: spec.sustained };
  noteCache.set(key, entry);
  return entry;
}

export function tunePlaybackOrder(tune) {
  if (!tune) return [];
  const timeline = [];
  for (const st of staffList(tune)) {
    let t = 0;
    for (const e of st.events) {
      if (!e.rest) {
        for (const p of pitchesOf(e)) timeline.push({ tick: t, midi: midiOf(p) });
      }
      t += ticksOf(e);
    }
  }
  timeline.sort((a, b) => a.tick - b.tick);
  const ordered = [];
  const seen = new Set();
  for (const item of timeline) {
    if (!seen.has(item.midi)) {
      seen.add(item.midi);
      ordered.push(item.midi);
    }
  }
  return ordered;
}

let sampleQueue = [];
let sampleLoadingCount = 0;
const MAX_CONCURRENT_SAMPLE_FETCHES = 3;

function pumpSampleQueue() {
  while (sampleLoadingCount < MAX_CONCURRENT_SAMPLE_FETCHES && sampleQueue.length > 0) {
    const item = sampleQueue.shift();
    sampleLoadingCount++;
    loadSample(item.inst, item.midi)
      .catch(() => {})
      .finally(() => {
        sampleLoadingCount--;
        pumpSampleQueue();
      });
  }
}

export function preloadSamples(inst, midis) {
  if (!ctx) ensure();
  sampleQueue = midis
    .filter(m => !sampleCache.has(`${inst}:${m}`) && !loadingSamples.has(`${inst}:${m}`))
    .map(m => ({ inst, midi: m }));
  emitSampleProgress();
  pumpSampleQueue();
}

let warmTimer = 0;
/** Pre-render and cache the unique pitches used in `tune` in playback order on idle ticks. */
export function warmTune(tune) {
  if (!tune) return;
  currentWarmingTune = tune;
  clearTimeout(warmTimer);
  const inst = tune.instrument || instrument || 'synth';
  const ordered = tunePlaybackOrder(tune);
  if (hdSamplesEnabled) {
    if (!ctx) ensure();
    preloadSamples(inst, ordered);
  } else {
    emitSampleProgress(tune);
  }
  if (!ctx) return;
  const queue = ordered.filter(m => !noteCache.has(`${inst}:${m}`));
  const step = () => {
    for (let k = 0; k < 2 && queue.length; k++) getNoteBuffer(inst, queue.shift());
    if (queue.length) warmTimer = setTimeout(step, 4);
  };
  if (queue.length) warmTimer = setTimeout(step, 0);
}

function addDamperThump(midi, time, level) {
  if (!ctx || level <= 0.04 || midi > 84) return;
  try {
    const f0 = freqOf(midi);
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.frequency.setValueAtTime(Math.min(240, Math.max(130, f0 * 0.45)), time);
    g.gain.setValueAtTime(0.016 * level, time);
    g.gain.exponentialRampToValueAtTime(0.0001, time + 0.024);
    osc.connect(g);
    g.connect(master);
    osc.start(time);
    osc.stop(time + 0.026);
  } catch {}
}

/** Schedule one cached note with smooth attack and click-free release shaping; returns a handle that can be cut short. */
function voice(midi, start, dur, level = 1, phraseStart = true) {
  const entry = getNoteBuffer(instrument, midi);
  const effLevel = (entry.isSample ? HD_SAMPLE_GAIN_BOOST : 1.0) * level;
  const bowed = instrument === 'violin' || instrument === 'cello';
  const end = start + Math.max(dur, 0.06);
  const atk = Math.min(entry.sustained ? (instrument === 'choir' ? 0.025 : bowed && !phraseStart ? 0.022 : 0.010) : 0.003, dur * 0.35);
  const release = entry.sustained
    ? (instrument === 'choir' ? 0.18 : bowed ? 0.12 : 0.09)
    : (instrument === 'piano' || instrument === 'epiano' ? 0.26 : 0.14);
  const env = ctx.createGain();
  // Pure linear ramps from (start, 0) -> (start + atk, effLevel) -> (end, effLevel) -> (end + release, 0)
  // Avoids the Web Audio setTargetAtTime + linearRampToValueAtTime step discontinuity!
  env.gain.setValueAtTime(0, start);
  env.gain.linearRampToValueAtTime(effLevel * 0.38, start + atk * 0.45);
  // Phrase-start bow grab on violin/cello has a slight initial rosin bite before settling into expressive sustain
  if (bowed && phraseStart && dur > 0.12) {
    env.gain.linearRampToValueAtTime(effLevel * 1.12, start + atk);
    env.gain.linearRampToValueAtTime(effLevel * 0.96, start + Math.min(dur * 0.6, atk + 0.055));
    env.gain.linearRampToValueAtTime(effLevel, end);
  } else {
    env.gain.linearRampToValueAtTime(effLevel * 0.38, start + atk * 0.45);
    env.gain.linearRampToValueAtTime(effLevel, start + atk);
    env.gain.setValueAtTime(effLevel, end);
  }
  env.gain.linearRampToValueAtTime(effLevel * 0.32, end + release * 0.55);
  env.gain.linearRampToValueAtTime(0, end + release);
  env.connect(master);
  if ((instrument === 'piano' || instrument === 'epiano') && midi <= 84) {
    addDamperThump(midi, end, effLevel);
  }
  const src = ctx.createBufferSource();
  src.buffer = entry.buf;
  if (entry.sustained) { src.loop = true; src.loopStart = entry.loopStart; src.loopEnd = entry.loopEnd; }
  src.connect(env);
  // On violin/cello, phrase starts (first note or after a rest) begin at offset 0 to capture the physical bow "grab";
  // connected mid-phrase notes start 38ms in so slurred/legato notes flow smoothly without a harsh scratch on every 16th note
  const bufOffset = bowed && !phraseStart ? 0.038 : 0;
  src.start(start, bufOffset);
  src.stop(end + release + 0.04);
  return {
    cut(at) {
      if (env.gain.cancelAndHoldAtTime) {
        env.gain.cancelAndHoldAtTime(at);
      } else {
        env.gain.cancelScheduledValues(at);
        env.gain.setValueAtTime(env.gain.value, at);
      }
      env.gain.linearRampToValueAtTime(0, at + 0.035);
      try { src.stop(at + 0.045); } catch {}
    },
  };
}

/** Sound one or more pitches together (a note or a chord). */
export function preview(...pitches) {
  try {
    const c = ensure(), level = chordLevel(pitches.length);
    const dur = (instrument === 'piano' || instrument === 'epiano') ? 1.15 : 0.38;
    pitches.forEach(p => voice(midiOf(p), c.currentTime + 0.01, dur, level, true));
  } catch {}
}

const chordLevel = n => 1 / Math.sqrt(n);

/**
 * Estimate how many ticks a note at `events[idx]` (starting at `startTick`) should ring before damping.
 * Phrase-aware sustain pedaling applies only to `piano`: arpeggiated chord tones and bass notes sustain
 * across the harmony phrase until a rest, bar/half-bar pedal change, repeated note, or scale-step clash.
 */
export function phraseSustainTicks(events, idx, startTick, mt, inst = instrument) {
  const e = events[idx], len = ticksOf(e);
  if (e.rest) return len;
  const ps = pitchesOf(e).map(midiOf), minM = Math.min(...ps);
  const next = events[idx + 1];
  const nextM = next && !next.rest ? pitchesOf(next).map(midiOf) : null;
  const repeated = nextM && ps.some(m => nextM.includes(m));
  if (repeated) return len * 0.88;

  if (SUSTAINED.has(inst)) return !next || next.rest ? len * 0.90 : len * 0.96;
  if (inst !== 'piano') return len * 0.92;

  // Pedal window: full measure for bass notes (< C4), half-measure (or measure in 3/4) for upper register
  const windowTicks = minM < 60 || mt === 12 ? mt : Math.max(4, mt >> 1);
  const barLimit = (Math.floor(startTick / windowTicks) + 1) * windowTicks;
  let endTick = startTick + len;
  for (let j = idx + 1; j < events.length && endTick < barLimit; j++) {
    const ej = events[j], jLen = ticksOf(ej);
    if (ej.rest) {
      if (minM < 60 && jLen < 8) {
        endTick = Math.min(barLimit, endTick + jLen);
        continue;
      }
      break;
    }
    const mj = pitchesOf(ej).map(midiOf);
    const samePitch = ps.some(a => mj.some(b => a === b));
    if (samePitch) break;
    // Stop pedaling on melody scale steps (1-2 semitones) or dissonant bass root changes (seconds, tritones, 7ths)
    const clash = ps.some(a => mj.some(b => {
      const diff = Math.abs(a - b);
      return diff <= 2 || (a < 55 && b < 55 && [1, 2, 6, 10, 11].includes(diff % 12));
    }));
    if (clash) { endTick += Math.min(jLen * 0.15, 0.6); break; }
    endTick = Math.min(barLimit, endTick + jLen);
  }
  return Math.max(len * 0.98, endTick - startTick);
}

/**
 * High-resolution background timer using an inline Web Worker.
 * Web Worker timers are not throttled to 1000ms by background tabs in Chrome/Safari/Firefox,
 * ensuring continuous audio scheduling when the user switches tabs or minimizes the window.
 * Gracefully falls back to setInterval in non-Worker environments (e.g. Node test runner).
 */
function createTicker(intervalMs, onTick) {
  try {
    if (typeof Worker !== 'undefined' && typeof Blob !== 'undefined' && typeof URL !== 'undefined' && URL.createObjectURL) {
      const code = `
        let t = null;
        self.onmessage = e => {
          if (e.data === 'start') { if (!t) t = setInterval(() => postMessage('t'), ${intervalMs}); }
          else if (e.data === 'stop') { clearInterval(t); t = null; }
        };
      `;
      const blob = new Blob([code], { type: 'application/javascript' });
      const url = URL.createObjectURL(blob);
      const w = new Worker(url);
      URL.revokeObjectURL(url);
      w.onmessage = () => onTick();
      return {
        start: () => w.postMessage('start'),
        stop: () => w.postMessage('stop'),
      };
    }
  } catch {}
  let t = null;
  return {
    start: () => { if (!t) t = setInterval(onTick, intervalMs); },
    stop: () => { clearInterval(t); t = null; },
  };
}

export class Player {
  constructor() {
    this.playing = false;
    this.voices = [];
    this.ticker = createTicker(35, () => this.tick?.());
    this._reschedule = null;
  }

  /**
   * Cancel and reschedule upcoming notes that haven't sounded yet (t0 > now + cutMargin)
   * so checking/unchecking HD samples transitions immediately on the very next note.
   */
  rescheduleFuture(cutMargin = 0.035) {
    if (this._reschedule) this._reschedule(cutMargin);
  }

  /**
   * Plays every staff together using a rolling lookahead window so CPU stays low.
   * Background playback is sustained via a Web Worker ticker and resilient 2.0s lookahead,
   * while visual note-highlighting is updated smoothly via requestAnimationFrame when visible.
   * @param tune
   * @param from tick to start at
   * @param opts {{loop:()=>boolean, onEvent:(keys:string[])=>void, onEnd:()=>void}}
   */
  play(tune, from, { loop, onEvent, onEnd }) {
    this.stop();
    const c = ensure();
    warmTune(tune);
    const secPerTick = 60 / tune.bpm / 4;
    const mt = { '2/4': 8, '3/4': 12, '4/4': 16, '6/8': 12 }[tune.time];
    const staves = staffList(tune);
    const contentEnd = Math.max(...staves.map(st => used(st.events)));
    if (!contentEnd || from >= contentEnd) { onEnd(); return; }
    const loopTicks = Math.ceil(contentEnd / mt) * mt;
    this.playing = true;
    const schedule = [], pending = [];
    const pass = (startTime, fromTick) => {
      staves.forEach((st, s) => {
        let t = 0;
        st.events.forEach((e, i) => {
          const len = ticksOf(e);
          if (t >= fromTick && !e.rest) {
            const prev = i > 0 ? st.events[i - 1] : null;
            const ps = pitchesOf(e), prevPs = prev && !prev.rest ? pitchesOf(prev) : null;
            // A fresh bow "grab" occurs at the start of a phrase (after a rest, at bar 0, or on a repeated bow stroke)
            const phraseStart = !prev || prev.rest || ps.some(p => prevPs.some(q => midiOf(p) === midiOf(q)));
            const t0 = startTime + (t - fromTick) * secPerTick, d = len * secPerTick;
            const ringDur = phraseSustainTicks(st.events, i, t, mt, tune.instrument || instrument) * secPerTick;
            const level = chordLevel(ps.length);
            ps.forEach(p => pending.push({ midi: midiOf(p), t0, dur: ringDur, level, phraseStart }));
            schedule.push({ key: `${s}:${i}`, t0, t1: t0 + d });
          } else if (t >= fromTick) {
            const t0 = startTime + (t - fromTick) * secPerTick, d = len * secPerTick;
            schedule.push({ key: `${s}:${i}`, t0, t1: t0 + d });
          }
          t += len;
        });
      });
      pending.sort((a, b) => a.t0 - b.t0);
      schedule.sort((x, y) => x.t1 - y.t1);
      return startTime + (fromTick === 0 ? loopTicks : contentEnd - fromTick) * secPerTick;
    };
    const getLookahead = () => (typeof document !== 'undefined' && document.hidden ? 2.0 : 0.25);
    const flushPending = now => {
      const lookahead = getLookahead();
      while (pending.length && pending[0].t0 <= now + lookahead) {
        const n = pending.shift();
        this.voices.push({
          t0: n.t0,
          end: n.t0 + n.dur + 0.3,
          h: voice(n.midi, n.t0, n.dur, n.level, n.phraseStart),
          note: n,
        });
      }
      while (this.voices.length && this.voices[0].end < now) this.voices.shift();
    };
    this._reschedule = (cutMargin = 0.035) => {
      if (!this.playing || !ctx) return;
      const now = c.currentTime;
      const keep = [];
      const toReschedule = [];
      for (const v of this.voices) {
        if (v.t0 <= now + cutMargin) {
          keep.push(v);
        } else {
          try { v.h?.cut(now); } catch {}
          if (v.note) toReschedule.push(v.note);
        }
      }
      this.voices = keep;
      if (toReschedule.length) {
        pending.push(...toReschedule);
        pending.sort((a, b) => a.t0 - b.t0);
      }
      flushPending(now);
    };
    let passEnd = pass(c.currentTime + 0.05, from);
    flushPending(c.currentTime);
    let last = '';

    const scheduleAhead = () => {
      if (!this.playing) return;
      const now = c.currentTime;
      const lookahead = getLookahead();
      if (loop() && now > passEnd - Math.max(0.6, lookahead)) passEnd = pass(passEnd, 0);
      flushPending(now);
      if (now >= passEnd && !loop()) { this.stop(); onEnd(); return; }
      while (schedule.length && schedule[0].t1 < now - 1) schedule.shift();
    };

    const updateUI = () => {
      if (!this.playing) return;
      scheduleAhead();
      const now = c.currentTime;
      const keys = schedule.filter(s => now >= s.t0 && now < s.t1).map(s => s.key);
      if (keys.join() !== last) { last = keys.join(); onEvent(keys); }
      this.raf = requestAnimationFrame(updateUI);
    };

    this.tick = scheduleAhead;
    this.ticker.start();
    this.raf = requestAnimationFrame(updateUI);
  }

  stop() {
    if (!this.playing && !this.voices.length) return;
    this.playing = false;
    this.tick = null;
    this._reschedule = null;
    this.ticker.stop();
    cancelAnimationFrame(this.raf);
    if (ctx) { const now = ctx.currentTime; this.voices.forEach(v => v.h?.cut(now)); }
    this.voices = [];
  }
}
