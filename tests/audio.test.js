import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INSTRUMENTS } from '../src/instruments.js';
import {
  SYNTH_SR, pickString, unselectedSympatheticGain, unselectedStringModes,
  harmonicAmps, synthesizeNote, phraseSustainTicks, setCustomProfile, Player,
  sampleNoteName, sampleUrl, isHdSamplesEnabled, setHdSamplesEnabled, clearSampleCache,
  tunePlaybackOrder, warmTune, ensure, onSampleProgress, getSampleLoadingProgress,
  HD_LOUDNESS_TARGET, kLoudness, sampleNormGain,
} from '../src/audio.js';
import { tune, parse } from './helpers.js';

test('all instruments synthesize finite, non-silent buffers across registers', () => {
  for (const { id } of INSTRUMENTS) {
    for (const midi of [48, 60, 72]) { // C3, C4, C5
      const res = synthesizeNote(id, midi, SYNTH_SR);
      assert.ok(res.data instanceof Float32Array, `${id} midi ${midi}`);
      assert.ok(res.data.length > SYNTH_SR, `${id} duration`);
      let max = 0, hasNaN = false;
      for (let i = 0; i < res.data.length; i++) {
        if (!Number.isFinite(res.data[i])) hasNaN = true;
        const a = Math.abs(res.data[i]);
        if (a > max) max = a;
      }
      assert.equal(hasNaN, false, `${id} midi ${midi} finite`);
      assert.ok(max > 0.05 && max < 4.0, `${id} midi ${midi} peak=${max}`);
      if (res.sustained) {
        assert.ok(res.loopStart > 0.5 && res.loopEnd > res.loopStart + 1.0, `${id} loop points`);
        // Loop seam must be continuous (crossfaded)
        const iStart = Math.floor(res.loopStart * SYNTH_SR);
        const iEnd = Math.floor(res.loopEnd * SYNTH_SR);
        assert.ok(Math.abs(res.data[iEnd - 1] - res.data[iStart - 1]) < 0.02, `${id} loop seam smooth`);
      }
    }
  }
});

test('stringed instruments select physical strings and compute unselected-string sympathetic coupling', () => {
  // Violin: G3 (196), D4 (293.66), A4 (440), E5 (659.25)
  assert.equal(pickString('violin', 220)[0], 0); // A3 played on G3 string
  assert.equal(pickString('violin', 330)[0], 1); // E4 played on D4 string
  assert.equal(pickString('violin', 523)[0], 2); // C5 played on A4 string
  assert.equal(pickString('violin', 784)[0], 3); // G5 played on E5 string

  // Playing A3 (220Hz) on violin G3 string (idx 0): H2=440Hz aligns with open A4 string, H4=880Hz aligns with 2*A4 & 3*D4
  const symp440 = unselectedSympatheticGain('violin', 0, 440);
  const sympNonAligned = unselectedSympatheticGain('violin', 0, 370);
  assert.ok(symp440 > sympNonAligned + 0.5, `sympathetic boost at 440Hz (${symp440}) > 370Hz (${sympNonAligned})`);

  // Unselected strings produce free-mode vibrations
  for (const inst of ['violin', 'cello', 'guitar', 'eguitar']) {
    const modes = unselectedStringModes(inst, 220);
    assert.ok(modes.length >= 6, `${inst} unselected string modes`);
    assert.ok(modes.every(([f, a, d]) => f > 50 && a > 0 && d > 0.5));
  }
});

test('piano harmonic profile reflects Kawai RX/GX Warm Grand default plus Kawai KG-2A and Yamaha C5 voicings across registers', () => {
  // Default piano voicing is the Kawai RX/GX Warm Grand
  const c2Default = harmonicAmps('piano', 65.41);
  const c3Default = harmonicAmps('piano', 130.81);
  const c4Default = harmonicAmps('piano', 261.63);
  const a4Default = harmonicAmps('piano', 440.0);
  const c6Default = harmonicAmps('piano', 1046.50);
  assert.ok(c2Default[1] > c2Default[0], `piano default C2 H2 (${c2Default[1]}) > H1 (${c2Default[0]})`);
  assert.ok(c3Default[0] > c3Default[1], `piano default C3 H1 (${c3Default[0]}) > H2 (${c3Default[1]})`);
  assert.ok(c4Default[0] > c4Default[1] && c6Default[0] > c6Default[1] * 2);
  assert.ok(c4Default[7] > 0.04 && a4Default[4] > 0.04, `C4 H8 (${c4Default[7]}) and A4 H5 (${a4Default[4]}) audible`);

  // Calibrated Kawai KG-2A voicing (C2, E4, G5)
  setCustomProfile('piano', { voicing: 'kg2a' });
  const c2Kg2a = harmonicAmps('piano', 65.7);
  const e4Kg2a = harmonicAmps('piano', 328.8);
  const g5Kg2a = harmonicAmps('piano', 786.9);
  assert.ok(c2Kg2a[1] > c2Kg2a[0] && c2Kg2a[9] > 0.25, 'KG-2A bass C2 has rich H2/H3/H10 wound-string chorus');
  assert.ok(Math.abs(e4Kg2a[0] - 0.975) < 0.01 && Math.abs(e4Kg2a[1] - 0.211) < 0.01, 'KG-2A middle E4 matches calibrated spectrum');
  assert.ok(g5Kg2a[0] > 0.99 && g5Kg2a[2] > g5Kg2a[1], 'KG-2A treble G5 has pure singing fundamental with 3rd harmonic ring');

  // Yamaha C5 voicing is brighter than Kawai RX/GX
  setCustomProfile('piano', { voicing: 'yamaha' });
  const c3Yamaha = harmonicAmps('piano', 130.81);
  const c4Yamaha = harmonicAmps('piano', 261.63);
  setCustomProfile('piano', null);
  assert.ok(c3Yamaha[0] > c3Yamaha[1], `Yamaha C3 H1 (${c3Yamaha[0]}) > H2 (${c3Yamaha[1]})`);
  const upperKawai = c4Default.slice(4, 10).reduce((a, x) => a + x, 0);
  const upperYamaha = c4Yamaha.slice(4, 10).reduce((a, x) => a + x, 0);
  assert.ok(upperKawai < upperYamaha, `Kawai upper partials (${upperKawai}) warmer/softer than Yamaha (${upperYamaha})`);
});

test('phraseSustainTicks pedals chordal arpeggios for piano only and stops at rests, repeats, or scale steps', () => {
  // Arpeggio C4 - E4 - G4 - C5 in 4/4 (16 ticks): piano C4 and E4 ring across the first half-bar (8 ticks)
  const arp = tune('C4:e E4:e G4:e C5:e').events;
  assert.equal(phraseSustainTicks(arp, 0, 0, 16, 'piano'), 8);
  assert.equal(phraseSustainTicks(arp, 1, 2, 16, 'piano'), 6);
  // Other percussive instruments (guitar, epiano, eguitar) do not apply piano phrase pedaling
  assert.ok(phraseSustainTicks(arp, 0, 0, 16, 'guitar') < 2, 'guitar does not sustain across phrase like piano pedal');
  assert.ok(phraseSustainTicks(arp, 0, 0, 16, 'epiano') < 2, 'epiano does not sustain across phrase like piano pedal');

  // Adjacent scale steps C4 - D4 - E4: C4 does not blur across D4/E4
  const scale = tune('C4:q D4:q E4:q F4:q').events;
  const scaleRing = phraseSustainTicks(scale, 0, 0, 16, 'piano');
  assert.ok(scaleRing < 5, `scale step damps early (${scaleRing} ticks)`);

  // Repeated note C4 - C4 detaches slightly to re-articulate
  const rep = tune('C4:q C4:q').events;
  assert.ok(phraseSustainTicks(rep, 0, 0, 16, 'piano') < 4);

  // Bass note C3 pedals across internal rests within the measure
  const bassRest = tune('C3:q r:q E3:q r:q').events;
  assert.equal(phraseSustainTicks(bassRest, 0, 0, 16, 'piano'), 16, 'bass note pedals across measure despite internal rest');
});

test('choir synthesizes a multi-singer ensemble with active chorus modulation and zero H1 dropout', () => {
  const res = synthesizeNote('choir', 60, SYNTH_SR);
  const iStart = Math.floor(res.loopStart * SYNTH_SR), iEnd = Math.floor(res.loopEnd * SYNTH_SR);
  const win = Math.floor(0.05 * SYNTH_SR);
  const rmsList = [];
  for (let i = iStart; i + win <= iEnd; i += win) {
    let s = 0;
    for (let j = 0; j < win; j++) s += res.data[i + j] * res.data[i + j];
    rmsList.push(Math.sqrt(s / win));
  }
  const minR = Math.min(...rmsList), maxR = Math.max(...rmsList);
  // Multi-singer chorus modulates the envelope (>5% variation) without ever cancelling out (>55% floor)
  assert.ok(maxR > minR * 1.05, `choir ensemble has active multi-voice chorus movement (${minR}..${maxR})`);
  assert.ok(minR > maxR * 0.55, `choir ensemble avoids destructive H1 phase cancellation (${minR} vs ${maxR})`);
});

test('note buffers shape beginning and end amplitudes smoothly without clicks', () => {
  for (const { id } of INSTRUMENTS) {
    const res = synthesizeNote(id, 60, SYNTH_SR);
    // Beginning of every note starts at zero and ramps in smoothly
    assert.equal(res.data[0], 0, `${id} starts at exactly 0 amplitude`);
    assert.ok(Math.abs(res.data[1]) < 0.005, `${id} smooth initial sample`);
    if (!res.sustained) {
      // Percussive buffers taper smoothly to zero at the end of the buffer
      assert.equal(res.data[res.data.length - 1], 0, `${id} ends at 0 amplitude`);
      assert.ok(Math.abs(res.data[res.data.length - 8]) < 0.002, `${id} smooth tail taper`);
    }
  }
});

test('guitar models warm finger-pluck attack while eguitar models sharp plectrum pick and tube overdrive', () => {
  const ac = synthesizeNote('guitar', 60, SYNTH_SR).data;
  const el = synthesizeNote('eguitar', 60, SYNTH_SR).data;
  // Measure high-frequency transient brightness (mean squared sample-to-sample diff in first 12ms) vs RMS
  const nAtk = Math.floor(0.012 * SYNTH_SR);
  const hfRatio = buf => {
    let diffSq = 0, sigSq = 1e-9;
    for (let i = 1; i < nAtk; i++) {
      const d = buf[i] - buf[i - 1];
      diffSq += d * d;
      sigSq += buf[i] * buf[i];
    }
    return Math.sqrt(diffSq / sigSq);
  };
  const acBrightness = hfRatio(ac), elBrightness = hfRatio(el);
  assert.ok(elBrightness > acBrightness * 1.15, `electric pick + overdrive attack (${elBrightness.toFixed(3)}) is brighter/snappier than acoustic finger pluck (${acBrightness.toFixed(3)})`);
});

test('violin and cello model initial bow-grab transient and organic bow-pressure variation across the sustain', () => {
  for (const id of ['violin', 'cello']) {
    const res = synthesizeNote(id, id === 'cello' ? 48 : 69, SYNTH_SR);
    const d = res.data;
    // Measure high-frequency stick-slip edge in the initial bow grab (8..45ms) vs settled sustain (500..700ms)
    const edgeRatio = (t0, t1) => {
      const i0 = Math.floor(t0 * SYNTH_SR), i1 = Math.floor(t1 * SYNTH_SR);
      let diffSq = 0, sigSq = 1e-9;
      for (let i = i0 + 1; i < i1; i++) {
        const df = d[i] - d[i - 1];
        diffSq += df * df;
        sigSq += d[i] * d[i];
      }
      return Math.sqrt(diffSq / sigSq);
    };
    const grabEdge = edgeRatio(0.008, 0.045), susEdge = edgeRatio(0.50, 0.70);
    assert.ok(grabEdge > susEdge * 1.08, `${id} initial bow grab (${grabEdge.toFixed(3)}) has stronger stick-slip edge than settled sustain (${susEdge.toFixed(3)})`);
  }
});

test('Player instantiates ticker and manages playback lifecycle cleanly', () => {
  const p = new Player();
  assert.equal(p.playing, false);
  assert.ok(p.ticker && typeof p.ticker.start === 'function' && typeof p.ticker.stop === 'function');
  assert.equal(typeof p.rescheduleFuture, 'function');
  assert.doesNotThrow(() => p.rescheduleFuture());
  p.stop();
  assert.equal(p.playing, false);
});

test('HD sample engine maps MIDI pitches and instruments to standard CDN soundfont URLs and manages toggle state', () => {
  // MIDI note name conversions: C4 = 60, Db4 = 61, A0 = 21, C8 = 108
  assert.equal(sampleNoteName(60), 'C4');
  assert.equal(sampleNoteName(61), 'Db4');
  assert.equal(sampleNoteName(21), 'A0');
  assert.equal(sampleNoteName(108), 'C8');
  assert.equal(sampleNoteName(69), 'A4');
  assert.equal(sampleNoteName(70), 'Bb4');

  // CDN URLs for instruments
  const pianoC4 = sampleUrl('piano', 60);
  assert.ok(pianoC4.includes('/acoustic_grand_piano-mp3/C4.mp3'));
  assert.ok(pianoC4.startsWith('https://cdn.jsdelivr.net/gh/gleitz/midi-js-soundfonts'));

  const celloC3 = sampleUrl('cello', 48);
  assert.ok(celloC3.includes('/cello-mp3/C3.mp3'));

  const fluteG5 = sampleUrl('flute', 79);
  assert.ok(fluteG5.includes('/flute-mp3/G5.mp3'));

  // Toggle state and cache management
  const prev = isHdSamplesEnabled();
  setHdSamplesEnabled(true);
  assert.equal(isHdSamplesEnabled(), true);
  setHdSamplesEnabled(false);
  assert.equal(isHdSamplesEnabled(), false);
  setHdSamplesEnabled(prev);
  clearSampleCache();
});

test('tunePlaybackOrder sorts notes in chronological playback order across timeline and staves', () => {
  const t = tune('C4:q D4:q E4:q G4:q');
  const order = tunePlaybackOrder(t);
  assert.deepEqual(order, [60, 62, 64, 67]);

  // Repeated notes deduplicated, preserving earliest playback position
  const rep = tune('C4:q E4:q C4:q G4:q');
  assert.deepEqual(tunePlaybackOrder(rep), [60, 64, 67]);

  // Two staves interleaved by start tick
  const s2 = tune('C4:h E4:h', { staff2: { clef: 'bass', events: parse('G3:q A3:q B3:q C4:q') } });
  // At tick 0: C4 (60) and G3 (55)
  // At tick 4: A3 (57)
  // At tick 8: E4 (64) and B3 (59)
  // At tick 12: C4 (60, already seen)
  const s2Order = tunePlaybackOrder(s2);
  assert.deepEqual(s2Order, [60, 55, 57, 64, 59]);
});

test('ensure returns null safely outside browser and warmTune handles HD preloading without errors', () => {
  assert.equal(ensure(), null);
  const prev = isHdSamplesEnabled();
  setHdSamplesEnabled(true);
  const t = tune('C4:q D4:q E4:q F4:q');
  // warmTune should process tune and invoke HD preloading pipeline without throwing
  assert.doesNotThrow(() => warmTune(t));
  assert.doesNotThrow(() => warmTune(null));
  setHdSamplesEnabled(prev);
});

test('getSampleLoadingProgress calculates note cache completion and onSampleProgress notifies subscribers', () => {
  clearSampleCache();
  // Null or empty tune is 100% ready
  assert.deepEqual(getSampleLoadingProgress(null), { loaded: 0, total: 0, percent: 100, ready: true });
  assert.deepEqual(getSampleLoadingProgress(tune('')), { loaded: 0, total: 0, percent: 100, ready: true });

  const t = tune('C4:q D4:q E4:q G4:q');
  // Initially nothing loaded in cache
  const initial = getSampleLoadingProgress(t);
  assert.equal(initial.loaded, 0);
  assert.equal(initial.total, 4);
  assert.equal(initial.percent, 0);
  assert.equal(initial.ready, false);

  // Subscribe to progress
  const received = [];
  const unsub = onSampleProgress(p => received.push(p));

  // Toggling HD emits progress
  setHdSamplesEnabled(true);
  assert.ok(received.length >= 1);

  // Unsubscribing stops callbacks
  const countBefore = received.length;
  unsub();
  setHdSamplesEnabled(false);
  assert.equal(received.length, countBefore);
});

test('HD samples are loudness-matched to each instrument synth voice', () => {
  for (const { id } of INSTRUMENTS) assert.ok(Number.isFinite(HD_LOUDNESS_TARGET[id]), id);
  // A full-scale 1 kHz sine in both speakers reads about 0 LUFS (K-weighting adds ~0.7 dB at 1 kHz)
  const sr = 48000, sine = new Float32Array(sr).map((_, i) => Math.sin(2 * Math.PI * 1000 * i / sr));
  assert.ok(Math.abs(kLoudness([sine, sine], sr) - kLoudness([sine], sr)) < 1e-9);
  assert.ok(Math.abs(kLoudness([sine], sr)) < 0.3, String(kLoudness([sine], sr)));
  // A quiet sample is boosted onto the target; silence is left alone
  const quiet = sine.map(v => v * 0.1);
  const g = sampleNormGain('violin', [quiet], sr);
  assert.ok(Math.abs(kLoudness([quiet.map(v => v * g)], sr) - HD_LOUDNESS_TARGET.violin) < 0.01);
  assert.equal(sampleNormGain('violin', [new Float32Array(sr)], sr), 1);
});

test('default piano model uses Kawai RX/GX Warm Grand voicing', () => {
  // Clear any custom profile so default is active
  setCustomProfile('piano', null);
  const ampsDefault = harmonicAmps('piano', 261.6); // C4
  assert.ok(ampsDefault.length > 0);
  assert.ok(Number.isFinite(ampsDefault[0]));

  // Test that setting 'kawai' explicitly matches the default profile
  setCustomProfile('piano', { voicing: 'kawai' });
  const ampsKawai = harmonicAmps('piano', 261.6);
  assert.deepEqual(ampsDefault, ampsKawai);

  // Clean up
  setCustomProfile('piano', null);
});
