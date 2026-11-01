/*
 * Validation suite for the analysis core. Runs in Node (`node tests/tests.js`) and in
 * the browser (open tests/tests.html). Every test synthesises a signal with known
 * frequencies, analyses it, and checks the result.
 */
(function () {
  'use strict';
  const isNode = typeof module === 'object' && module.exports;
  const D = isNode ? require('../js/dsp.js') : self.HDSP;
  const P = isNode ? require('../js/pitch.js') : self.HPitch;
  const M = isNode ? require('../js/music.js') : self.HMusic;
  const X = isNode ? require('../js/dissonance.js') : self.HDiss;
  const S = isNode ? require('../js/synth.js') : self.HSynth;

  const results = [];
  function test(name, fn) {
    try {
      const detail = fn();
      results.push({ name, ok: true, detail: detail || '' });
    } catch (e) {
      results.push({ name, ok: false, detail: e.message });
    }
  }
  function assert(cond, msg) { if (!cond) throw new Error(msg); }
  const cents = (a, b) => 1200 * Math.log2(a / b);
  const near = (a, b, tolCents, what) => assert(Math.abs(cents(a, b)) <= tolCents,
    `${what || ''} ${a.toFixed(3)} vs ${b.toFixed(3)} (${cents(a, b).toFixed(2)}¢, tol ${tolCents}¢)`);

  const SR = 48000;
  const ps = new M.PitchSpace({ a4: 440 });
  const noteF = n => ps.freqOfMidi(n);
  const NOTE = { E2: 40, A2: 45, C3: 48, G3: 55, A3: 57, C4: 60, Cs4: 61, D4: 62, E4: 64, F4: 65, Fs4: 66, G4: 67, A4: 69, C5: 72, E5: 76, A5: 81, C6: 84 };

  // deterministic pseudo random
  let seed = 12345;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };

  /** harmonic tone: amps(h) gives amplitude of harmonic h */
  function tone(f0, amps, nH = 20, gain = 0.2, inharm = 0) {
    const parts = [];
    for (let h = 1; h <= nH; h++) {
      const a = amps(h);
      const f = h * f0 * Math.sqrt(1 + inharm * h * h);
      if (a > 0 && f < SR / 2 - 500) parts.push({ freq: f, amp: gain * a, phase: rnd() * 6.283 });
    }
    return parts;
  }
  const saw = h => 1 / h;
  const square = h => (h % 2 ? 1 / h : 0);

  function analyse(parts, { fftSize = 16384, noise = 0.0005, windowType = 'hann', poly = true } = {}) {
    const an = new D.Analyzer({ sampleRate: SR, fftSize, windowType });
    const x = D.synth(parts, an.samplesNeeded, SR, noise, Math.floor(rnd() * 1e6));
    const r = an.process(x, { minFreq: 25, maxFreq: 12000 });
    const voices = P.detectVoices(r.peaks, { polyphonic: poly });
    return { r, voices };
  }

  function expectVoices(voices, freqs, tol, label) {
    const got = voices.map(v => v.f0.toFixed(2) + 'Hz ' + ps.etNote(v.f0).label).join(', ');
    assert(voices.length === freqs.length, `${label}: expected ${freqs.length} voice(s), got ${voices.length} [${got}]`);
    const sorted = freqs.slice().sort((a, b) => a - b);
    sorted.forEach((f, i) => near(voices[i].f0, f, tol, label));
    return got;
  }

  /* ---------------------------------------------------------- DSP basics */
  test('FFT matches direct DFT (N=64)', () => {
    const n = 64, re = new Float64Array(n), im = new Float64Array(n);
    const x = Array.from({ length: n }, () => rnd() - 0.5);
    x.forEach((v, i) => { re[i] = v; });
    D.fft(re, im);
    let maxErr = 0;
    for (let k = 0; k < n; k++) {
      let sr = 0, si = 0;
      for (let t = 0; t < n; t++) { sr += x[t] * Math.cos(2 * Math.PI * k * t / n); si -= x[t] * Math.sin(2 * Math.PI * k * t / n); }
      maxErr = Math.max(maxErr, Math.abs(sr - re[k]), Math.abs(si - im[k]));
    }
    assert(maxErr < 1e-9, 'max error ' + maxErr);
    return 'max error ' + maxErr.toExponential(1);
  });

  test('Window kernel predicts scalloping loss (Hann 1.42 dB, BH 0.83 dB at ½ bin)', () => {
    const h = -20 * Math.log10(D.windowKernel('hann', 0.5));
    const b = -20 * Math.log10(D.windowKernel('blackmanHarris', 0.5));
    assert(Math.abs(h - 1.42) < 0.02, 'hann ' + h);
    assert(Math.abs(b - 0.83) < 0.03, 'bh ' + b);
    return `Hann ${h.toFixed(3)} dB, BH ${b.toFixed(3)} dB`;
  });

  for (const windowType of ['hann', 'blackmanHarris']) {
    test(`Pure-tone frequency & level accuracy, 300 random tones (${windowType})`, () => {
      const an = new D.Analyzer({ sampleRate: SR, fftSize: 16384, windowType });
      let maxC = 0, maxDb = 0;
      for (let i = 0; i < 300; i++) {
        const f = 40 * Math.pow(2, rnd() * 8), A = 0.02 + rnd() * 0.6;
        const x = D.synth([{ freq: f, amp: A, phase: rnd() * 6.28 }], an.samplesNeeded, SR, 0.0005, i + 7);
        const r = an.process(x, { minFreq: 20, maxFreq: 20000 });
        const p = r.peaks.reduce((a, b) => (a.db > b.db ? a : b));
        maxC = Math.max(maxC, Math.abs(cents(p.freq, f)));
        maxDb = Math.max(maxDb, Math.abs(p.db - 20 * Math.log10(A)));
      }
      assert(maxC < 0.1, 'max cents error ' + maxC);
      assert(maxDb < 0.05, 'max level error ' + maxDb);
      return `worst ${maxC.toFixed(4)}¢, ${maxDb.toFixed(4)} dB`;
    });
  }

  test('No false peaks in noise with a single tone (200 trials)', () => {
    const an = new D.Analyzer({ sampleRate: SR, fftSize: 16384 });
    let extra = 0;
    for (let i = 0; i < 200; i++) {
      const f = 60 * Math.pow(2, rnd() * 7);
      const x = D.synth([{ freq: f, amp: 0.05 + rnd() * 0.5, phase: rnd() * 6 }], an.samplesNeeded, SR, 0.001, i + 99);
      extra += an.process(x, { minFreq: 25, maxFreq: 12000 }).peaks.length - 1;
    }
    assert(extra <= 4, extra + ' spurious peaks');
    return extra + ' spurious peaks in 200 frames';
  });

  test('Resolves all 20 harmonics of A2 sawtooth with correct levels', () => {
    const f0 = noteF(NOTE.A2);
    const { r } = analyse(tone(f0, saw, 20, 0.3));
    for (let h = 1; h <= 20; h++) {
      const p = r.peaks.find(q => Math.abs(cents(q.freq, h * f0)) < 5);
      assert(p, 'harmonic ' + h + ' missing');
      near(p.freq, h * f0, 0.2, 'h' + h);
      const expDb = 20 * Math.log10(0.3 / h);
      assert(Math.abs(p.db - expDb) < 0.1, `h${h} level ${p.db.toFixed(2)} vs ${expDb.toFixed(2)}`);
    }
    return `${r.peaks.length} peaks found`;
  });

  /* --------------------------------------------------- Fundamental detection */
  const singleNotes = ['E2', 'A2', 'C3', 'A3', 'C4', 'A4', 'E5', 'C6'];
  for (const [label, amps, nH] of [['sawtooth', saw, 16], ['square (odd harmonics)', square, 16], ['sine', () => 1, 1],
    ['weak fundamental (-20 dB)', h => (h === 1 ? 0.1 : 1 / h), 12], ['bright (equal harmonics)', () => 0.5, 10]]) {
    test(`Single note, ${label}: ${singleNotes.join(' ')}`, () => {
      const out = [];
      for (const n of singleNotes) {
        const f0 = noteF(NOTE[n]);
        const { voices } = analyse(tone(f0, amps, nH));
        expectVoices(voices, [f0], 0.5, `${n} ${label}`);
        out.push(`${n} ${cents(voices[0].f0, f0).toFixed(3)}¢`);
      }
      return out.join(', ');
    });
  }

  test('Inharmonic string (B=0.0004, piano-like) C3: fundamental + 20 partials tracked', () => {
    const f0 = noteF(NOTE.C3);
    const { voices } = analyse(tone(f0, saw, 20, 0.3, 0.0004));
    assert(voices.length >= 1, 'no voice');
    near(voices[0].f0, f0 * Math.sqrt(1.0004), 0.5, 'f0');
    assert(voices[0].harmonics.length >= 18, 'only ' + voices[0].harmonics.length + ' partials tracked');
    return `${voices[0].harmonics.length} partials, h20 stretched ${voices[0].harmonics.slice(-1)[0].dev.toFixed(1)}¢`;
  });

  test('Singer-style vibrato (±17¢ at 5.5 Hz) on A3 and A4: one note, no ghost notes', () => {
    const out = [];
    for (const f0 of [noteF(NOTE.A3), noteF(NOTE.A4)]) {
      const an = new D.Analyzer({ sampleRate: SR, fftSize: 16384 });
      const len = an.samplesNeeded, x = D.synth([], len, SR, 0.0005, 77);
      for (let h = 1; h <= 12; h++) {
        let ph = h;
        for (let i = 0; i < len; i++) {
          ph += 2 * Math.PI * h * f0 * (1 + 0.01 * Math.sin(2 * Math.PI * 5.5 * i / SR)) / SR;
          x[i] += 0.2 / h * Math.sin(ph);
        }
      }
      const v = P.detectVoices(an.process(x, { minFreq: 25, maxFreq: 12000 }).peaks);
      assert(v.length === 1, `${ps.etNote(f0).label}: ${v.length} notes (${v.map(q => q.f0.toFixed(1)).join(', ')})`);
      near(v[0].f0, f0, 20, 'vibrato centre');
      out.push(`${ps.etNote(f0).label} ${cents(v[0].f0, f0).toFixed(1)}¢ (instantaneous)`);
    }
    return out.join(', ');
  });

  test('Very stiff string A1 (B = 0.001): exactly its 20 partials claimed', () => {
    const f0 = noteF(NOTE.A2) / 2;
    const { voices } = analyse(tone(f0, saw, 20, 0.3, 0.001), { fftSize: 32768 });
    assert(voices.length === 1, voices.length + ' voices');
    const hs = voices[0].harmonics.map(h => h.h);
    assert(hs.length === 20 && Math.max(...hs) === 20, 'claimed ' + hs.join(','));
    return `h20 stretched ${voices[0].harmonics[19].dev.toFixed(0)}¢ and still followed`;
  });

  test('Monophonic mode returns one voice even for a chord', () => {
    const parts = [...tone(noteF(NOTE.C4), saw, 10), ...tone(noteF(NOTE.E4), saw, 10)];
    const { voices } = analyse(parts, { poly: false });
    assert(voices.length === 1, voices.length + ' voices');
  });

  /* ------------------------------------------------------- Chords / intervals */
  const chords = [
    ['Perfect 5th C4+G4 (ET)', [NOTE.C4, NOTE.G4].map(noteF)],
    ['Perfect 5th C4+G4 (just 3/2)', [noteF(NOTE.C4), noteF(NOTE.C4) * 1.5]],
    ['Major 3rd C4+E4', [NOTE.C4, NOTE.E4].map(noteF)],
    ['Perfect 4th C4+F4', [NOTE.C4, NOTE.F4].map(noteF)],
    ['Tritone C4+F♯4', [NOTE.C4, NOTE.Fs4].map(noteF)],
    ['Minor 2nd C4+C♯4', [NOTE.C4, NOTE.Cs4].map(noteF)],
    ['Major 2nd C4+D4', [NOTE.C4, NOTE.D4].map(noteF)],
    ['Wide: A2+G4', [NOTE.A2, NOTE.G4].map(noteF)],
    ['Twelfth A2+E4 (E4 ≈ 3rd harmonic of A2: merges)', [NOTE.A2].map(noteF), [NOTE.A2, NOTE.E4].map(noteF)],
    ['C major triad (ET)', [NOTE.C4, NOTE.E4, NOTE.G4].map(noteF)],
    ['C major triad (just 4:5:6)', [1, 5 / 4, 3 / 2].map(r => noteF(NOTE.C4) * r)],
    ['A minor triad A3 C4 E4', [NOTE.A3, NOTE.C4, NOTE.E4].map(noteF)],
    ['Octave C4+C5 (expected: merges to C4)', [NOTE.C4].map(noteF), [NOTE.C4, NOTE.C5].map(noteF)],
  ];
  for (const [label, expect, play] of chords) {
    for (const amps of [['saw', saw], ['square', square]]) {
      test(`Chord ${label} [${amps[0]}]`, () => {
        const parts = (play || expect).flatMap(f => tone(f, amps[1], 12, 0.15));
        const { voices } = analyse(parts, { fftSize: 32768 });
        const got = expectVoices(voices, expect, 3, label);
        // harmonic tones: no partial may be claimed that is not on the note's own series
        for (const v of voices) for (const h of v.harmonics) {
          assert(Math.abs(h.dev) < 12, `${label}: ${ps.etNote(v.f0).label} claims a partial ${h.dev.toFixed(1)}¢ off harmonic ${h.h}`);
        }
        return got;
      });
    }
  }

  /* ------------------------------------------------------------- Music theory */
  test('Note naming: 440→A4, 261.626→C4, 445→A4 +19.56¢', () => {
    assert(ps.etNote(440).label === 'A4', ps.etNote(440).label);
    assert(ps.etNote(261.6256).label === 'C4', 'C4');
    const n = ps.etNote(445);
    assert(n.label === 'A4' && Math.abs(n.cents - 19.56) < 0.01, n.label + ' ' + n.cents);
  });

  test('Harmonic → ET deviation (5th +1.96¢, maj3 −13.69¢, h7 −31.17¢, h11 −48.68¢)', () => {
    const e = h => M.describeHarmonic(h).etDev;
    assert(Math.abs(e(3) - 1.955) < 0.01, 'h3 ' + e(3));
    assert(Math.abs(e(5) + 13.686) < 0.01, 'h5 ' + e(5));
    assert(Math.abs(e(7) + 31.174) < 0.01, 'h7 ' + e(7));
    assert(Math.abs(Math.abs(e(11)) - 48.68) < 0.02, 'h11 ' + e(11));
    return `h3 ${e(3).toFixed(2)}¢, h5 ${e(5).toFixed(2)}¢, h7 ${e(7).toFixed(2)}¢, h11 ${e(11).toFixed(2)}¢`;
  });

  test('Sargam in key of C (ET): C=Sa, E♭=komal Ga, F♯=tivra Ma, G3=mandra Pa, C5=taar Sa', () => {
    const s = new M.PitchSpace({ a4: 440, tonicPc: 0, tuning: 'et' });
    const t = f => s.tuned(f);
    assert(t(261.6256).text === 'Sa', t(261.6256).text);
    assert(t(noteF(63)).text === 'Ga(k)', t(noteF(63)).text);
    assert(t(noteF(66)).text === 'Ma(t)', t(noteF(66)).text);
    assert(t(noteF(55)).text === '.Pa', t(noteF(55)).text);
    assert(t(noteF(72)).text === "Sa'", t(noteF(72)).text);
    assert(Math.abs(t(noteF(64)).cents) < 1e-6, 'E4 deviation');
  });

  test('Just intonation: ET E4 reads +13.69¢ vs just Ga (5/4) in C; ET G4 −1.96¢ vs Pa', () => {
    const s = new M.PitchSpace({ a4: 440, tonicPc: 0, tuning: 'just' });
    const e = s.tuned(noteF(NOTE.E4)), g = s.tuned(noteF(NOTE.G4));
    assert(e.step === 4 && Math.abs(e.cents - 13.686) < 0.01, e.step + ' ' + e.cents);
    assert(g.step === 7 && Math.abs(g.cents + 1.955) < 0.01, g.step + ' ' + g.cents);
    const pure = s.degreeFreq(4, 0);
    near(pure, s.saFreq() * 1.25, 0.001, 'degreeFreq');
  });

  test('Key of D, Sa = D4: A4 is Pa; Werckmeister keeps A4 = 440', () => {
    const s = new M.PitchSpace({ a4: 440, tonicPc: 2, tuning: 'et' });
    assert(s.tuned(440).text === 'Pa', s.tuned(440).text);
    const w = new M.PitchSpace({ a4: 440, tonicPc: 0, tuning: 'werckmeister' });
    near(w.degreeFreq(9, 0), 440, 0.001, 'Werckmeister A');
    const wD = new M.PitchSpace({ a4: 440, tonicPc: 2, tuning: 'werckmeister' });
    near(wD.degreeFreq(7, 0), 440, 0.001, 'Werckmeister A as Pa of D');
  });

  test('Tuned labels: in C just, 327.03 Hz = E4 ±0; ET E4 = E4 +13.7¢; Werckmeister in D names A4 correctly', () => {
    const s = new M.PitchSpace({ a4: 440, tonicPc: 0, tuning: 'just' });
    const a = s.label(s.saFreq() * 5 / 4), b = s.label(noteF(NOTE.E4));
    assert(a.label === 'E4' && Math.abs(a.cents) < 1e-6, a.label + a.cents);
    assert(b.label === 'E4' && Math.abs(b.cents - 13.686) < 0.01, b.label + b.cents);
    const c = s.label(noteF(NOTE.C5) * 0.999); // just below taar Sa
    assert(c.label === 'C5', 'octave boundary ' + c.label);
    const w = new M.PitchSpace({ a4: 440, tonicPc: 2, tuning: 'werckmeister' });
    assert(w.label(440).label === 'A4' && Math.abs(w.label(440).cents) < 1e-6, w.label(440).label + w.label(440).cents);
  });

  test('Degree note names follow the spelling setting: sharps → C♯/D♯, flats → D♭/G♭', () => {
    const sh = st => M.degreeNoteName(0, st, false), fl = st => M.degreeNoteName(0, st, true);
    assert(sh(1) === 'C♯' && sh(3) === 'D♯' && sh(10) === 'A♯', 'sharps: ' + [sh(1), sh(3), sh(10)]);
    assert(fl(1) === 'D♭' && fl(6) === 'G♭', 'flats: ' + [fl(1), fl(6)]);
    assert(M.degreeNoteName(5, 5, false) === 'A♯', 'F key, sharps: ' + M.degreeNoteName(5, 5, false));
  });

  test('Compound interval names and full ratios: octave 2/1, 12th 3/1, major 10th 5/2', () => {
    const a = M.describeInterval(200, 400), b = M.describeInterval(200, 600), c = M.describeInterval(200, 500);
    assert(a.etName === 'Octave' && M.ratioText(a.justFull) === '2/1', a.etName + ' ' + a.justFull);
    assert(b.etName === 'Perfect 12th' && M.ratioText(b.justFull) === '3/1', b.etName + ' ' + b.justFull);
    assert(c.etName === 'Major 10th' && M.ratioText(c.justFull) === '5/2', c.etName + ' ' + c.justFull);
    const d = M.describeInterval(100, 1200);
    assert(d.etName === 'Perfect 5th + 3 octaves' && M.ratioText(d.justFull) === '12/1', d.etName + ' ' + d.justFull);
  });

  test('Interval description: 3/2 = Perfect 5th, ET major third = 5/4 + 13.69¢', () => {
    const a = M.describeInterval(200, 300);
    assert(a.just.name === 'Perfect 5th' && Math.abs(a.just.dev) < 1e-6, a.just.name);
    const b = M.describeInterval(noteF(60), noteF(64));
    assert(b.just.name === 'Major 3rd' && Math.abs(b.just.dev - 13.686) < 0.01, b.just.name + b.just.dev);
  });

  /* --------------------------------------------------------------- Dissonance */
  if (X) {
    test('Plomp–Levelt: max roughness near 25% of critical band; zero at unison', () => {
      const f = 500;
      let best = 0, bestDf = 0;
      for (let df = 0.5; df < 200; df += 0.5) {
        const d = X.pairRoughness(f, 1, f + df, 1);
        if (d > best) { best = d; bestDf = df; }
      }
      assert(X.pairRoughness(f, 1, f, 1) === 0, 'unison not zero');
      // Sethares' fit puts the maximum at s*df = ln(b2/b1)/(b2-b1) = 0.2125 ... with s = 0.24/(0.0207 f + 18.96)
      const s = 0.24 / (0.0207 * f + 18.96), expected = Math.log(5.75 / 3.51) / (5.75 - 3.51) / s;
      assert(Math.abs(bestDf - expected) < 1, `peak at ${bestDf} Hz, expected ${expected.toFixed(1)}`);
      return `peak roughness at Δf = ${bestDf} Hz for 500 Hz`;
    });

    test('Dissonance curve of a 7-harmonic sawtooth has minima at 6/5, 5/4, 4/3, 3/2, 5/3, 2/1', () => {
      const parts = Array.from({ length: 7 }, (_, i) => ({ freq: (i + 1), amp: 1 / (i + 1) }));
      const curve = X.dissonanceCurve(parts, 261.63, 1, 2.05, 1200);
      const minima = X.localMinima(curve).map(m => m.ratio);
      const want = [6 / 5, 5 / 4, 4 / 3, 3 / 2, 5 / 3, 2];
      for (const w of want) {
        assert(minima.some(m => Math.abs(1200 * Math.log2(m / w)) < 8), `no minimum near ${w.toFixed(4)}; minima ${minima.map(m => m.toFixed(3))}`);
      }
      return 'minima at ' + minima.map(m => m.toFixed(3)).join(', ');
    });

    test('Roughness ordering: m2 > M2 > ET M3 > just M3 > P5 > P8; just 5th smoother than ET 5th', () => {
      const base = noteF(NOTE.C4);
      const d = ratio => X.totalRoughness([...tone(base, saw, 10, 1), ...tone(base * ratio, saw, 10, 1)]);
      const et = s => Math.pow(2, s / 12);
      const v = { m2: d(et(1)), M2: d(et(2)), M3et: d(et(4)), M3just: d(5 / 4), P5et: d(et(7)), P5just: d(1.5), P8: d(2) };
      assert(v.m2 > v.M2 && v.M2 > v.M3et && v.M3et > v.M3just && v.M3just > v.P5et && v.P5et > v.P5just && v.P5just > v.P8, JSON.stringify(v));
      return Object.entries(v).map(([k, x]) => `${k} ${x.toFixed(3)}`).join(', ');
    });
  }


  /* --------------------------------------------------------- Tone Lab synth */
  if (S) {
    /** Render an instrument offline through the same engine the AudioWorklet runs. */
    function play(inst, notes, secs, { vibrato = false, restrike = true, symp } = {}) {
      const e = new S.Engine(SR, 4242);
      e.handle({ t: 'opts', vibrato, restrike });
      if (symp) e.handle({ t: 'symp', freqs: symp });
      notes.forEach((f, id) => e.handle({ t: 'on', id, freq: f, inst, nHarm: 12, inharm: 0 }));
      const n = Math.round(secs * SR), out = new Float32Array(n);
      for (let i = 0; i < n; i += 128) e.render(out.subarray(i, Math.min(n, i + 128)), Math.min(128, n - i));
      return out;
    }
    const analyseAt = (x, t, fftSize = 16384) => {
      const an = new D.Analyzer({ sampleRate: SR, fftSize, windowType: 'hann' });
      const r = an.process(x, { minFreq: 25, maxFreq: 12000, rangeDb: 90 }, Math.round(t * SR));
      return { r, voices: P.detectVoices(r.peaks, { polyphonic: true }) };
    };
    const levelAt = (r, f) => { const p = r.peaks.filter(q => Math.abs(q.freq / f - 1) < 0.012); return p.length ? Math.max(...p.map(q => q.db)) : -150; };

    const scale = [NOTE.G3, NOTE.C4, NOTE.A4].map(noteF);
    test(`Every Tone Lab instrument (${Object.keys(S.INSTRUMENTS).length}) sounds exactly one note at the requested pitch (G3, C4, A4)`, () => {
      const worst = [];
      for (const inst of Object.keys(S.INSTRUMENTS)) {
        for (const f of scale) {
          const x = play(inst, [f], 1.3);
          let pk = 0;
          for (const v of x) { assert(Number.isFinite(v), `${inst}: non-finite sample`); pk = Math.max(pk, Math.abs(v)); }
          assert(pk > 0.02 && pk < 0.95, `${inst} @ ${f.toFixed(1)} Hz: peak ${pk.toFixed(3)}`);
          const { voices } = analyseAt(x, 1.2);
          expectVoices(voices, [f], 1.5, `${inst} @ ${f.toFixed(1)} Hz`);
          worst.push(Math.abs(cents(voices[0].f0, f)));
        }
      }
      return `max error ${Math.max(...worst).toFixed(2)}¢ over ${worst.length} notes`;
    });

    test('Instrument chords: a just C major triad on piano, harmonium, sitar and violin resolves to its three notes', () => {
      const tri = [noteF(NOTE.C4), noteF(NOTE.C4) * 5 / 4, noteF(NOTE.C4) * 3 / 2];
      for (const inst of ['piano', 'harmonium', 'sitar', 'violin']) {
        const { voices } = analyseAt(play(inst, tri, 1.3), 1.2);
        expectVoices(voices, tri, 2, inst);
      }
    });

    test('Piano partials are stretched by stiffness; the fitted inharmonicity matches the model (C3)', () => {
      const f0 = noteF(NOTE.C3), B = S._specs.piano.B(f0); // measured from a recording when calibrated
      const { r } = analyseAt(play('piano', [f0], 1.0), 0.95, 32768);
      const exp = n => n * f0 * Math.sqrt((1 + B * n * n) / (1 + B));
      const n = 12;
      const p = r.peaks.filter(q => Math.abs(cents(q.freq, exp(n))) < 15).sort((a, b) => b.db - a.db)[0];
      assert(p, 'no 12th partial found');
      const stretch = cents(p.freq, n * f0);
      near(p.freq, exp(n), 1.5, 'partial 12');
      assert(stretch > 1.5, `partial 12 only ${stretch.toFixed(1)}¢ sharp`);
      return `partial 12 is ${stretch.toFixed(1)}¢ above 12·f0 (B = ${B.toExponential(1)})`;
    });

    test('Clarinet: odd harmonics dominate the low register (closed cylindrical bore)', () => {
      const f0 = noteF(NOTE.G3);
      const { r } = analyseAt(play('clarinet', [f0], 1), 0.9);
      const odd = [1, 3, 5].map(h => levelAt(r, h * f0)), even = [2, 4].map(h => levelAt(r, h * f0));
      assert(Math.min(...odd) - Math.max(...even) > 10, `odd ${odd.map(Math.round)} even ${even.map(Math.round)}`);
      return `odd ${odd.map(Math.round).join('/')} dB, even ${even.map(Math.round).join('/')} dB`;
    });

    test('Sitar jawari keeps high harmonics alive: h10–h20 at 2 s are far stronger than without the bridge', () => {
      const f0 = noteF(NOTE.C3);
      const hi = inst => {
        const { r } = analyseAt(play(inst, [f0], 2.2, { restrike: false }), 2.1);
        const ref = levelAt(r, f0);
        let e = 0; for (let h = 10; h <= 20; h++) e += 10 ** ((levelAt(r, h * f0) - ref) / 10);
        return 10 * Math.log10(e);
      };
      const spec = S._specs.sitar, jaw = spec.jaw;
      const withJ = hi('sitar');
      spec.jaw = 0;
      let without;
      try { without = hi('sitar'); } finally { spec.jaw = jaw; }
      assert(withJ - without > 6, `with ${withJ.toFixed(1)} dB, without ${without.toFixed(1)} dB`);
      return `h10–20 energy ${withJ.toFixed(1)} dB vs ${without.toFixed(1)} dB re h1`;
    });

    test('Tanpura plucks latched strings one at a time, in turn (first string at once, then the next two ~1 s apart)', () => {
      // (C3, G3, D4 rather than an octave so no string is another's harmonic)
      const fs = [noteF(NOTE.C3), noteF(NOTE.G3), noteF(NOTE.D4)];
      const x = play('tanpura', fs, 3.5);
      // onset of each string = first time its fundamental is detected
      const first = fs.map(() => null);
      for (let t = 0.25; t < 3.5; t += 0.1) {
        const { voices } = analyseAt(x, t, 8192);
        fs.forEach((f, i) => { if (first[i] == null && voices.some(v => Math.abs(cents(v.f0, f)) < 30)) first[i] = t; });
      }
      assert(first.every(v => v != null), 'a string never sounded: ' + first);
      assert(first[0] < first[1] && first[1] < first[2] && first[2] - first[1] > 0.7 && first[2] < 2.8, 'onsets ' + first.map(v => v.toFixed(1)));
      return 'onsets ' + first.map(v => v.toFixed(1) + ' s').join(', ');
    });

    test('Vibrato on: violin pitch swings by about its set depth; off: steady (within the 85 ms analysis noise)', () => {
      const f0 = noteF(NOTE.A4);
      const track = vib => {
        const x = play('violin', [f0], 2.2, { vibrato: vib });
        const c = [];
        for (let t = 1.0; t < 2.2; t += 0.02) {
          const { voices } = analyseAt(x, t, 4096);
          if (voices.length) c.push(cents(voices[0].f0, f0));
        }
        return Math.max(...c) - Math.min(...c);
      };
      const on = track(true), off = track(false);
      const depth = S._specs.violin.vib.depth; // ±¢, measured from recordings when calibrated
      assert(on > depth && on < 4 * depth + 20, `vibrato swing ${on.toFixed(1)}¢ for depth ±${depth}¢`);
      assert(off < 4, `steady swing ${off.toFixed(2)}¢`);
      return `peak-to-peak ${on.toFixed(1)}¢ with vibrato, ${off.toFixed(2)}¢ without`;
    });
  }

  /* ------------------------------------------------------------------ Report */
  const passed = results.filter(r => r.ok).length;
  if (isNode) {
    for (const r of results) console.log(`${r.ok ? '✔' : '✘'} ${r.name}${r.detail ? '  — ' + r.detail : ''}`);
    console.log(`\n${passed}/${results.length} passed`);
    if (passed !== results.length) process.exitCode = 1;
  } else {
    self.TEST_RESULTS = results;
  }
})();
