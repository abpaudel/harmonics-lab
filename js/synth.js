/*
 * synth.js — Tone Lab instrument models.
 *
 * Everything lives inside `factory()`, which has no outside references: audio.js
 * stringifies it into an AudioWorklet module (so synthesis runs off the main thread),
 * the ScriptProcessor fallback calls it directly, and the Node test suite renders
 * instruments offline and checks them with the real analyser.
 *
 * Three model families, each following a published technique, chosen so that the
 * pitch of every note is exactly the frequency asked for (vital in a tuning lab —
 * self-oscillating physical models of winds and bows drift by several cents):
 *
 *  1. Digital waveguide string (extended Karplus–Strong, Jaffe & Smith 1983) for
 *     plucked strings: delay line + one-pole loss filter + Lagrange fractional delay,
 *     with the loop's phase delay compensated so f0 is exact. Sitar/tanpura add a
 *     jawari bridge: the delay length is modulated by the string's own displacement
 *     (Siddiq, "A physical model of the nonlinear sitar string", 2012), which keeps
 *     pumping energy into high harmonics — the buzzing "zing". A shared bank of
 *     sympathetic strings (sitar taraf, sarangi) is tuned to the current scale.
 *  2. Modal / additive synthesis for struck strings and membranes: stiff-string
 *     partials f_n = n f0 sqrt(1 + B n^2) with register-dependent B (piano, santoor),
 *     hammer-position comb and felt low-pass, frequency-dependent decay
 *     sigma = b1 + b3 f^2 (Chaigne & Askenfelt 1994, Bensa et al. 2003), detuned
 *     unison strings and two-stage decay (Weinreich 1977). Tabla dayan uses the
 *     harmonic membrane modes Raman described (1934).
 *  3. Spectral modelling — deterministic harmonics + stochastic noise (Serra 1989) —
 *     for sustained instruments: a source spectrum shaped by a body / formant
 *     response that is re-evaluated as vibrato moves each partial, so partials swell
 *     and fade through the resonances as on a real violin (Mathews & Kohut 1973);
 *     breath / bow noise, attack chiff, and level-dependent brightness for brass
 *     and reeds (Risset & Mathews 1969). Voice uses a Klatt cascade formant filter.
 */
(function (root) {
  'use strict';

  function factory() {
    'use strict';
    const TAU = Math.PI * 2;
    const TBL = 4096;
    const SIN = new Float32Array(TBL + 1);
    for (let i = 0; i <= TBL; i++) SIN[i] = Math.sin(TAU * i / TBL);
    const dB = x => Math.pow(10, x / 20);
    const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
    const midiOf = f => 69 + 12 * Math.log2(f / 440);

    class Rng {
      constructor(seed) { this.s = (seed >>> 0) || 0x9e3779b9; }
      next() { let s = this.s; s ^= s << 13; s ^= s >>> 17; s ^= s << 5; this.s = s >>> 0; return this.s / 4294967296; }
      noise() { return this.next() * 2 - 1; }
    }

    /** Topology-preserving state-variable filter (Zavalishin). bp() has unity peak gain. */
    class SVF {
      constructor() { this.ic1 = 0; this.ic2 = 0; this.k = 1; this.a1 = 0; this.a2 = 0; this.a3 = 0; }
      set(fc, Q, sr) {
        const g = Math.tan(Math.PI * Math.min(fc, sr * 0.45) / sr);
        this.k = 1 / Q; this.a1 = 1 / (1 + g * (g + this.k)); this.a2 = g * this.a1; this.a3 = g * this.a2;
        return this;
      }
      bp(x) {
        const v3 = x - this.ic2, v1 = this.a1 * this.ic1 + this.a2 * v3, v2 = this.ic2 + this.a2 * this.ic1 + this.a3 * v3;
        this.ic1 = 2 * v1 - this.ic1; this.ic2 = 2 * v2 - this.ic2;
        return this.k * v1;
      }
    }
    /** Gain that gives white noise in [-1,1] an rms of `rms` after a unity-peak band-pass. */
    const noiseGain = (rms, fc, Q, sr) => rms / Math.sqrt((1 / 3) * (Math.PI / 2) * (Math.min(fc, sr * 0.45) / Q) / (sr / 2));

    /* ---------------------------------------------- spectral envelope tables */
    // Body / formant responses tabulated on a log-frequency axis (20 Hz – 20 kHz,
    // 1/48 octave) so every partial can be looked up cheaply every block.
    const L0 = Math.log2(20), LSTEP = 1 / 48, LN = Math.ceil((Math.log2(20000) - L0) / LSTEP) + 2;
    function table(fn) {
      const t = new Float32Array(LN);
      for (let i = 0; i < LN; i++) t[i] = fn(Math.pow(2, L0 + i * LSTEP));
      return t;
    }
    function lookup(t, f) {
      const x = (Math.log2(f > 20 ? f : 20) - L0) / LSTEP, i = x | 0;
      if (i >= LN - 1) return t[LN - 1];
      return t[i] + (x - i) * (t[i + 1] - t[i]);
    }
    const res = (f, fc, Q) => 1 / Math.sqrt(1 + Q * Q * Math.pow(f / fc - fc / f, 2)); // unity-peak resonance
    /** floor + sum of resonance peaks, with optional high-pass (hp) and low-pass (lp, order n). */
    function parallelBody({ floor = 0, peaks = [], hp = 0, lp = 0, n = 2 }) {
      return table(f => {
        let g = floor;
        for (const [fc, Q, a] of peaks) g += a * res(f, fc, Q);
        if (hp) g *= (f / hp) / Math.sqrt(1 + (f / hp) * (f / hp));
        if (lp) g /= 1 + Math.pow(f / lp, n);
        return g;
      });
    }
    /** Klatt-style cascade of formant resonators [freq, bandwidth] (unity gain at DC). */
    function cascadeBody(formants, lp) {
      return table(f => {
        let g = 1;
        for (const [F, B] of formants) g /= Math.sqrt(Math.pow(1 - (f / F) * (f / F), 2) + Math.pow(f * B / (F * F), 2));
        if (lp) g /= 1 + Math.pow(f / lp, 2);
        return g;
      });
    }
    /** Violin-family body: a few strong low modes plus a dense, irregular set of
     *  resonances under a "bridge hill" (after Mathews & Kohut's 1973 electronic violin). */
    function bowedBody(scale, seed, hill) {
      const r = new Rng(seed);
      const peaks = [[275 * scale, 14, 1.0], [460 * scale, 18, 0.8], [550 * scale, 16, 0.9]];
      for (let i = 0; i < 26; i++) {
        const fc = 300 * scale * Math.pow(2, i * 4.3 / 26 + (r.next() - 0.5) * 0.12);
        peaks.push([fc, 12 + r.next() * 18, 0.25 + 0.75 * r.next()]);
      }
      return table(f => {
        let g = 0.12;
        for (const [fc, Q, a] of peaks) g += a * res(f, fc, Q);
        g *= 1 + 1.6 * res(f, hill * scale, 1.3); // bridge hill
        g *= (f / (190 * scale)) ** 2 / (1 + (f / (190 * scale)) ** 2);
        return g / (1 + Math.pow(f / (5200 * Math.sqrt(scale)), 4));
      });
    }

    /* --------------------------------------------------- instrument catalogue */
    const PURE = {
      sine: h => (h === 1 ? 1 : 0),
      saw: h => 1 / h,
      square: h => (h % 2 ? 1 / h : 0),
      triangle: h => (h % 2 ? 1 / (h * h) : 0),
    };
    const pure = (label, about, src) => ({ kind: 'add', group: 'Pure tones', label, about, src, pure: true, att: 0.04, rel: 0.08, gain: 1 });

    const piano = {
      kind: 'add', group: 'Western', label: 'Piano',
      about: 'Modal synthesis: stiff-string partials stretched by the register\'s inharmonicity B, hammer at 1/8 of the string through a felt low-pass, decay σ = b₁ + b₃f², two slightly detuned unison strings (beating, double decay) and a hammer thump.',
      struck: true, att: 0.002, rel: 0.25, restrike: 3, maxH: 64, gain: 0.95,
      B: f0 => clamp(Math.pow(10, -3.4 + 0.024 * (midiOf(f0) - 60)), 1.2e-4, 0.02),
      unison: [-0.35, 0.35],
      src: (h, f0, f) => {
        const fc = clamp(2400 * Math.pow(f0 / 261.6, 0.5), 900, 9000);
        return (0.12 + 0.88 * Math.abs(Math.sin(Math.PI * h / 8.2))) * Math.pow(h, -0.55) / (1 + (f / fc) * (f / fc));
      },
      sigma: (f, f0) => 0.9 * Math.pow(2, (midiOf(f0) - 60) / 18) + 1.5e-7 * f * f,
      decay2: { w: 0.12, div: 7 },
      noise: { burst: -20, burstF: 500, burstQ: 0.7, burstTau: 0.012 },
    };

    const santoor = {
      kind: 'add', group: 'Indian', label: 'Santoor',
      about: 'Hammered dulcimer, modal synthesis: four detuned strings per course (the shimmer), hard walnut mallets striking near the bridge (bright, harmonics up to 6 kHz), low inharmonicity and a box resonance.',
      struck: true, att: 0.001, rel: 0.3, restrike: 1.6, maxH: 40, gain: 0.85, B: () => 8e-5,
      unison: [-0.9, -0.3, 0.3, 0.9],
      src: (h, f0, f) => (0.2 + 0.8 * Math.abs(Math.sin(Math.PI * h * 0.11))) * Math.pow(h, -0.6) / (1 + (f / 6000) * (f / 6000)),
      body: parallelBody({ floor: 1, peaks: [[260, 4, 0.5], [520, 4, 0.4]] }),
      sigma: (f, f0) => 0.55 * Math.pow(2, (midiOf(f0) - 60) / 24) + 1.5e-7 * f * f,
      decay2: { w: 0.2, div: 4 },
      noise: { burst: -18, burstF: 2500, burstQ: 1, burstTau: 0.004 },
    };

    // Tabla dayan, "Na" stroke: Raman's five harmonic modes, each a near-degenerate pair,
    // plus a few inharmonic modes that die quickly, a slap, and a falling pitch transient.
    const tabla = {
      kind: 'add', group: 'Indian', label: 'Tabla (dayan)',
      about: 'Modal synthesis of the loaded membrane: the syahi makes the first five modes harmonic (1:2:3:4:5), as C. V. Raman showed — each a slightly split pair — plus quick inharmonic modes, a rim slap and the pitch drop just after the stroke.',
      struck: true, att: 0.001, rel: 0.1, restrike: 1.2, gain: 0.9,
      modes: () => {
        const m = [];
        [1, 0.75, 0.55, 0.35, 0.22].forEach((a, i) => { m.push({ r: (i + 1) * Math.pow(2, -0.5 / 1200), a: a * 0.6 }, { r: (i + 1) * Math.pow(2, 0.5 / 1200), a: a * 0.6 }); });
        [[6.3, 0.15], [7.45, 0.1], [8.8, 0.08], [10.2, 0.05]].forEach(([r, a]) => m.push({ r, a, extra: 14 }));
        return m;
      },
      sigma: f => 2.6 + 2e-6 * f * f,
      scoop: { cents: 30, tau: 0.035 },
      noise: { burst: -9, burstF: 3000, burstQ: 0.8, burstTau: 0.006 },
    };

    const violin = {
      kind: 'add', group: 'Western', label: 'Violin',
      about: 'Bowed string: Helmholtz-motion sawtooth (bow at 1/10, notching every 10th harmonic) through a dense, irregular body response with the bridge hill near 2.5 kHz. Vibrato sweeps each partial across the body peaks, so harmonics shimmer; plus bow noise and attack scratch.',
      att: 0.08, rel: 0.15, partialAtt: 0.05, dyn: 0.4, maxH: 40, gain: 1,
      src: h => (0.3 + 0.7 * Math.abs(Math.sin(Math.PI * h * 0.1))) / h,
      body: bowedBody(1, 7, 2500),
      vib: { rate: 5.8, depth: 18, amp: 0.05, delay: 0.25, drift: 3 },
      scoop: { cents: -10, tau: 0.05 },
      noise: { hiss: -40, hissF: 3500, hissQ: 0.8, harm: -36, harmQ: 30, burst: -22, burstF: 2000, burstQ: 1, burstTau: 0.03 },
    };
    const cello = {
      ...violin, label: 'Cello',
      about: 'Bowed string like the violin, with a body about 2.4× larger: main air and wood modes near 110–230 Hz and the bridge hill lower, giving the darker, warmer timbre; slower, wider vibrato.',
      att: 0.12, body: bowedBody(0.42, 11, 2300),
      vib: { rate: 5.2, depth: 16, amp: 0.05, delay: 0.3, drift: 3 },
    };

    const flute = {
      kind: 'add', group: 'Western', label: 'Flute',
      about: 'Spectral model: strong fundamental with harmonics falling ~6 dB each (purer in the high register), breath noise both broadband and concentrated around the first harmonics, an attack chiff, and the flute\'s mostly-amplitude vibrato.',
      att: 0.07, rel: 0.12, dyn: 0.6, maxH: 16, gain: 1,
      src: (h, f0) => Math.exp(-(0.75 + 0.6 * clamp(Math.log2(f0 / 262), 0, 2)) * (h - 1)),
      chiff: { gain: 1, tau: 0.05 },
      vib: { rate: 5, depth: 6, amp: 0.12, delay: 0.3, drift: 2 },
      noise: { hiss: -31, hissF: 3000, hissQ: 0.6, harm: -29, harmQ: 12, burst: -20, burstF: 2000, burstQ: 1, burstTau: 0.04 },
    };
    const bansuri = {
      ...flute, group: 'Indian', label: 'Bansuri',
      about: 'Bamboo transverse flute: an even more fundamental-heavy, hollow spectrum than the metal flute, much more breath (large embouchure, no keys), a soft slow-speaking attack that slides up into the note, and gentle andolan-like vibrato.',
      att: 0.11, rel: 0.2, dyn: 0.5,
      src: (h, f0) => Math.exp(-(1.0 + 0.5 * clamp(Math.log2(f0 / 262), 0, 2)) * (h - 1)),
      scoop: { cents: -20, tau: 0.08 },
      vib: { rate: 4.6, depth: 7, amp: 0.15, delay: 0.45, drift: 3 },
      noise: { hiss: -25, hissF: 2200, hissQ: 0.5, harm: -22, harmQ: 8, burst: -16, burstF: 1500, burstQ: 1, burstTau: 0.06 },
    };

    const clarinet = {
      kind: 'add', group: 'Western', label: 'Clarinet',
      about: 'Closed cylindrical bore: odd harmonics dominate below the tone-hole cutoff (~1.6 kHz) while even ones are 20–25 dB down; above the cutoff even harmonics fill in and the spectrum rolls off. Straight tone, little breath noise.',
      att: 0.04, rel: 0.08, dyn: 0.5, maxH: 40, gain: 1,
      src: (h, f0, f) => {
        const fc = 1600, x = clamp((f - fc * 0.7) / (fc * 0.8), 0, 1);
        const even = 0.06 + 0.6 * x * x * (3 - 2 * x);
        return (h % 2 ? 1 : even) * Math.pow(h, -0.9) / (f > fc ? Math.pow(f / fc, 1.5) : 1);
      },
      vib: { rate: 5, depth: 0, amp: 0, delay: 0, drift: 1.5 },
      noise: { hiss: -44, hissF: 2500, hissQ: 0.7, harm: -42, harmQ: 20, burst: -28, burstF: 1500, burstQ: 1, burstTau: 0.02 },
    };
    const oboe = {
      kind: 'add', group: 'Western', label: 'Oboe',
      about: 'Double reed on a conical bore: rich harmonics shaped by fixed formants near 1.1 kHz and 2.9 kHz (the nasal colour), with a weak fundamental in the low register.',
      att: 0.045, rel: 0.1, dyn: 0.5, maxH: 40, gain: 1,
      src: h => Math.pow(h, -0.4),
      body: parallelBody({ floor: 0.15, peaks: [[1150, 2.2, 1], [2900, 3, 0.45], [4400, 4, 0.15]], hp: 400, lp: 6000, n: 4 }),
      vib: { rate: 5.2, depth: 9, amp: 0.04, delay: 0.25, drift: 2 },
      noise: { hiss: -44, hissF: 3000, hissQ: 0.7, burst: -26, burstF: 1500, burstQ: 1, burstTau: 0.02 },
    };
    const shehnai = {
      kind: 'add', group: 'Indian', label: 'Shehnai',
      about: 'Keyless double-reed oboe with a flared metal bell: very bright and nasal (formants near 1.25, 2.5 and 3.6 kHz, weak fundamental), notes approached with a meend from below and a wide, singing vibrato.',
      att: 0.05, rel: 0.12, dyn: 0.6, maxH: 40, gain: 0.95,
      src: h => Math.pow(h, -0.25),
      body: parallelBody({ floor: 0.1, peaks: [[1250, 2, 1], [2500, 2.5, 0.6], [3600, 3, 0.3]], hp: 450, lp: 7000, n: 3 }),
      scoop: { cents: -60, tau: 0.1 },
      vib: { rate: 5.6, depth: 22, amp: 0.05, delay: 0.3, drift: 5 },
      noise: { hiss: -38, hissF: 3500, hissQ: 0.7, burst: -24, burstF: 1800, burstQ: 1, burstTau: 0.02 },
    };
    const trumpet = {
      kind: 'add', group: 'Western', label: 'Trumpet',
      about: 'Brass after Risset: the higher a harmonic, the more its level depends on loudness, so upper partials enter late in the attack and the tone darkens as it fades; bell formant near 1.2 kHz, a small lip scoop up to pitch.',
      att: 0.035, rel: 0.09, dyn: 1, partialAtt: 0.25, maxH: 30, gain: 0.95,
      src: h => Math.pow(h, -0.3),
      body: parallelBody({ floor: 0.1, peaks: [[1200, 1.2, 1], [2700, 2.5, 0.35]], hp: 350, lp: 5000, n: 3 }),
      scoop: { cents: -35, tau: 0.04 },
      vib: { rate: 5.5, depth: 8, amp: 0.03, delay: 0.35, drift: 2 },
      noise: { hiss: -42, hissF: 2000, hissQ: 0.7, burst: -22, burstF: 1500, burstQ: 1, burstTau: 0.02 },
    };
    const organ = {
      kind: 'add', group: 'Western', label: 'Pipe organ',
      about: 'Principal 8′ + Octave 4′ flue pipes: two ranks of steady harmonic spectra (the 4′ reinforcing even harmonics, a fraction of a cent off so the chorus breathes), wind noise and a short pipe chiff. No vibrato.',
      att: 0.05, rel: 0.12, maxH: 32, gain: 0.9,
      layers: [{ mult: 1, cents: 0, gain: 1 }, { mult: 2, cents: 0.6, gain: 0.45 }],
      src: h => Math.pow(h, -1.15),
      chiff: { gain: 0.8, tau: 0.04 },
      noise: { hiss: -48, hissF: 1500, hissQ: 0.6, burst: -30, burstF: 2500, burstQ: 1, burstTau: 0.03 },
    };
    const voice = {
      kind: 'add', group: 'Western', label: 'Voice "aah"',
      about: 'Source–filter voice: glottal pulse spectrum (−6 dB/oct) through a cascade of five formant resonators for "aa" (730, 1090, 2440, 3400, 4200 Hz). Vibrato moves the harmonics through the formants; slight jitter and breath.',
      att: 0.09, rel: 0.15, dyn: 0.3, maxH: 40, gain: 1,
      src: h => 1 / h,
      body: cascadeBody([[730, 90], [1090, 110], [2440, 170], [3400, 250], [4200, 300]]),
      vib: { rate: 5.5, depth: 30, amp: 0.05, delay: 0.3, drift: 4 },
      noise: { hiss: -42, hissF: 3000, hissQ: 0.8, harm: -36, harmQ: 15 },
    };
    const harmonium = {
      kind: 'add', group: 'Indian', label: 'Harmonium',
      about: 'Free reed: a bright, rich spectrum (≈ n^−0.75) lifted by the reed chamber around 2.2 kHz, reeds that buzz into speech in ~35 ms and slight bellows pressure swells. Fixed pitch — no vibrato.',
      att: 0.035, rel: 0.08, dyn: 0.2, maxH: 40, gain: 0.85,
      src: h => Math.pow(h, -0.75),
      body: parallelBody({ floor: 1, peaks: [[2200, 2, 0.8]], lp: 7000, n: 2 }),
      vib: { rate: 0.8, depth: 0, amp: 0.04, delay: 0.2, drift: 1, wobble: true },
      noise: { hiss: -46, hissF: 2500, hissQ: 0.7, burst: -30, burstF: 1500, burstQ: 1, burstTau: 0.02 },
    };
    const sarangi = {
      kind: 'add', group: 'Indian', label: 'Sarangi',
      about: 'Bowed gut strings over a skin-covered body: Helmholtz sawtooth shaped by membrane formants (≈ 0.9, 1.7, 2.9 kHz) — very vocal — with a wide gamak vibrato and some 35 sympathetic strings (here a bank tuned to the current scale) ringing behind it.',
      att: 0.1, rel: 0.2, dyn: 0.4, partialAtt: 0.05, maxH: 40, gain: 0.9, symp: 1,
      src: h => (0.3 + 0.7 * Math.abs(Math.sin(Math.PI * h * 0.12))) * Math.pow(h, -1.1),
      body: parallelBody({ floor: 0.25, peaks: [[420, 4, 0.8], [900, 3, 1], [1700, 3, 0.55], [2900, 3, 0.4]], hp: 180, lp: 5000, n: 3 }),
      vib: { rate: 5, depth: 22, amp: 0.06, delay: 0.3, drift: 4 },
      noise: { hiss: -38, hissF: 3000, hissQ: 0.8, harm: -34, harmQ: 25, burst: -22, burstF: 1800, burstQ: 1, burstTau: 0.04 },
    };

    // Waveguide strings. t60: decay of the fundamental (s); t60hi: decay at 3 kHz.
    const guitar = {
      kind: 'string', group: 'Western', label: 'Guitar (nylon)',
      about: 'Digital waveguide (extended Karplus–Strong): a delay line one period long with a frequency-dependent loss filter, plucked with the finger 1/5 from the bridge (missing every 5th harmonic), through the body\'s air and top-plate resonances (~100, 200, 400 Hz). Chords are strummed.',
      t60: f0 => clamp(5 * Math.pow(110 / f0, 0.4), 1.5, 8), t60hi: 0.5,
      pluck: { pos: 0.19, soft: 0.35, noise: 0.05 },
      body: { direct: 0.7, peaks: [[100, 6, 1], [205, 10, 0.8], [400, 8, 0.4]], lp: 5000 },
      restrike: 3, strum: 0.014, rel: 0.12, gain: 1,
    };
    const sitar = {
      kind: 'string', group: 'Indian', label: 'Sitar',
      about: 'Waveguide string on a jawari bridge: the string\'s displacement shortens its vibrating length (after Siddiq 2012), continually pushing energy into high harmonics — the buzzing zing that sweeps through the spectrum. Mizrab pluck near the bridge, gourd resonances, and 11 sympathetic taraf strings tuned to the current scale.',
      t60: () => 4, t60hi: 1.5, jaw: 0.05,
      pluck: { pos: 0.1, soft: 0.1, noise: 0.15 },
      body: { direct: 0.8, peaks: [[180, 4, 0.6], [520, 5, 0.5], [1150, 4, 0.6], [2600, 3, 0.5]] },
      restrike: 2.5, rel: 0.3, symp: 0.8, gain: 0.9,
    };
    const tanpura = {
      kind: 'string', group: 'Indian', label: 'Tanpura',
      about: 'Long, soft finger plucks on a wide jawari tuned with the jiva thread: the high harmonics bloom after each pluck and keep moving. Latched notes are plucked in turn in the classic cycle (e.g. Pa – Sa – Sa – low Sa).',
      t60: () => 10, t60hi: 3, jaw: 0.035,
      pluck: { pos: 0.3, soft: 0.7, noise: 0.02 },
      body: { direct: 0.8, peaks: [[110, 4, 0.7], [240, 5, 0.6], [700, 3, 0.4]] },
      restrike: 3.2, cycle: true, rel: 0.5, gain: 1,
    };
    const veena = {
      kind: 'string', group: 'Indian', label: 'Veena',
      about: 'Saraswati veena: waveguide string with a mild jawari (a gentler buzz than the sitar), fingernail pluck and the deep resonance of the large jackfruit-wood body.',
      t60: () => 6, t60hi: 1.2, jaw: 0.012,
      pluck: { pos: 0.15, soft: 0.3, noise: 0.05 },
      body: { direct: 0.75, peaks: [[90, 5, 0.8], [200, 6, 0.7], [450, 4, 0.4], [1500, 3, 0.3]] },
      restrike: 3, rel: 0.3, symp: 0.2, gain: 1,
    };

    const INSTRUMENTS = {
      sine: pure('Sine (pure tone)', 'A single sinusoid — no overtones at all.', PURE.sine),
      saw: pure('Sawtooth (all harmonics, 1/n)', 'Every harmonic at 1/n — the idealised bowed / plucked string spectrum. Harmonics and inharmonicity are adjustable.', PURE.saw),
      square: pure('Square (odd harmonics, 1/n)', 'Odd harmonics only at 1/n — the idealised clarinet spectrum.', PURE.square),
      triangle: pure('Triangle (odd, 1/n²)', 'Odd harmonics falling at 1/n² — a soft, flute-like idealised tone.', PURE.triangle),
      piano, guitar, violin, cello, flute, clarinet, oboe, trumpet, organ, voice,
      sitar, tanpura, veena, santoor, sarangi, bansuri, shehnai, harmonium, tabla,
    };

    /* ------------------------------------------------------ additive voice */
    class AddVoice {
      constructor(spec, f0, eng, opts) {
        this.spec = spec; this.eng = eng; this.sr = eng.sr;
        this.f0 = f0; this.target = f0;
        this.opts = opts || {};
        this.rng = new Rng((eng.rng.next() * 4294967296) >>> 0);
        this.t = 0; this.off = -1; this.relLevel = 1;
        this.vibPh = this.rng.next(); this.drift = 0; this.driftT = 0; this.wob = 0; this.wobT = 0;
        this.build(f0);
        this.ph = new Float64Array(this.comps.length);
        for (let i = 0; i < this.ph.length; i++) this.ph[i] = spec.struck ? 0.75 + this.rng.next() * 0.02 : this.rng.next();
        this.prev = new Float32Array(this.comps.length);
        this.initNoise();
      }

      build(f0) {
        const s = this.spec, sr = this.sr, comps = [];
        const nyq = sr * 0.45;
        if (s.modes) {
          for (const m of s.modes(f0)) comps.push({ r: m.r, a: m.a, extra: m.extra || 0 });
        } else {
          const B = s.pure ? (this.opts.inharm || 0) : s.B ? s.B(f0) : 0;
          const maxH = s.pure ? (this.opts.nHarm || 12) : s.maxH || 40;
          const layers = s.layers || [{ mult: 1, cents: 0, gain: 1 }];
          const uni = s.unison || [0];
          for (const L of layers) {
            for (let h = 1; h <= maxH; h++) {
              const n = h * L.mult;
              const r = n * Math.sqrt((1 + B * n * n) / (1 + B)) * Math.pow(2, L.cents / 1200);
              const f = r * f0;
              if (f > nyq) break;
              const a = s.src(h, f0, f) * L.gain;
              if (!(a > 1e-5)) continue;
              for (const c of uni) {
                const jit = s.unison ? (this.rng.next() - 0.5) * 0.15 : 0;
                comps.push({ r: r * Math.pow(2, (c + jit) / 1200), a: a / Math.sqrt(uni.length), n });
              }
            }
          }
        }
        // normalise to unit rms at the nominal pitch (body included)
        let e = 0;
        for (const c of comps) { const g = c.a * (s.body ? lookup(s.body, c.r * f0) : 1); e += g * g / 2; }
        const k = 1 / Math.sqrt(e || 1);
        for (const c of comps) c.a *= k;
        this.comps = comps;
        this.builtF0 = f0;
      }

      initNoise() {
        const n = this.spec.noise;
        this.nz = null;
        if (!n) return;
        const sr = this.sr, z = { hiss: null, harm: [], burst: null };
        if (n.hiss != null) z.hiss = { f: new SVF().set(n.hissF, n.hissQ, sr), g: noiseGain(dB(n.hiss), n.hissF, n.hissQ, sr) };
        if (n.harm != null) for (let h = 1; h <= 3; h++) z.harm.push({ h, f: new SVF(), g: dB(n.harm - 6 * (h - 1)) });
        if (n.burst != null) z.burst = { f: new SVF().set(n.burstF, n.burstQ, sr), g: noiseGain(dB(n.burst), n.burstF, n.burstQ, sr), env: 0, k: Math.exp(-1 / (n.burstTau * sr)) };
        this.nz = z;
        this.setHarmNoise();
        this.trigger();
      }

      setHarmNoise() {
        if (!this.nz) return;
        for (const z of this.nz.harm) {
          const fc = z.h * this.f0, Q = this.spec.noise.harmQ;
          z.f.set(fc, Q, this.sr);
          z.gg = noiseGain(z.g, fc, Q, this.sr);
        }
      }

      trigger() { if (this.nz && this.nz.burst) this.nz.burst.env = 1; }

      strike() { this.t = 0; this.trigger(); }

      setFreq(f) {
        this.target = f;
        if (Math.abs(Math.log2(f / this.builtF0)) > 0.04) {
          const oldPh = this.ph, oldPrev = this.prev;
          this.f0 = f; this.build(f);
          this.ph = new Float64Array(this.comps.length); this.prev = new Float32Array(this.comps.length);
          for (let i = 0; i < this.ph.length; i++) { this.ph[i] = i < oldPh.length ? oldPh[i] : this.rng.next(); this.prev[i] = i < oldPrev.length ? oldPrev[i] : 0; }
          this.setHarmNoise();
        }
      }

      release() { if (this.off < 0) this.off = this.t; }

      render(out, n) {
        const s = this.spec, sr = this.sr, eng = this.eng, dt = n / sr;
        // pitch glide toward target (retuning), vibrato, drift, scoop
        this.f0 += (this.target - this.f0) * (1 - Math.exp(-dt / 0.015));
        let cents = 0, ampMod = 1;
        const v = s.vib;
        if (v && eng.vibrato) {
          const ramp = clamp((this.t - v.delay) / 0.4, 0, 1);
          this.vibPh += v.rate * dt * (1 + 0.04 * this.drift / (v.drift || 1));
          this.vibPh -= Math.floor(this.vibPh);
          const sv = SIN[(this.vibPh * TBL) | 0];
          cents += v.depth * ramp * sv;
          ampMod += v.amp * ramp * sv * (v.wobble ? 0 : 1);
          // slow random drift (smoothed noise, ~0.3 s)
          this.driftT += (this.rng.noise() - this.driftT) * Math.min(1, dt / 0.3);
          this.drift += (this.driftT * 2.2 - this.drift) * Math.min(1, dt / 0.3);
          cents += v.drift * this.drift;
          if (v.wobble) {
            this.wobT += (this.rng.noise() - this.wobT) * Math.min(1, dt / 0.6);
            this.wob += (this.wobT * 2 - this.wob) * Math.min(1, dt / 0.6);
            ampMod += v.amp * this.wob;
          }
        }
        if (s.scoop) cents += s.scoop.cents * Math.exp(-this.t / s.scoop.tau);
        const fmul = this.f0 * Math.pow(2, cents / 1200);

        // envelopes
        const t = this.t;
        let rel = 1;
        if (this.off >= 0) rel = Math.exp(-(t - this.off) / s.rel);
        const E1 = s.struck ? 1 : 1 - Math.exp(-t / s.att);
        const chiff = s.chiff ? s.chiff.gain * Math.exp(-t / s.chiff.tau) : 0;
        const comps = this.comps, ph = this.ph, prev = this.prev, nyq = sr * 0.45;
        let alive = this.off < 0 && !s.struck;
        const scale = s.gain * eng.voiceLevel * ampMod * rel;

        for (let i = 0; i < comps.length; i++) {
          const c = comps[i], f = c.r * fmul;
          let g = 0;
          if (f < nyq) {
            g = c.a;
            if (s.body) g *= lookup(s.body, f);
            if (s.struck) {
              const sig = s.sigma(f, this.f0) + (c.extra || 0);
              g *= s.decay2 ? (1 - s.decay2.w) * Math.exp(-sig * t) + s.decay2.w * Math.exp(-sig / s.decay2.div * t) : Math.exp(-sig * t);
              if (t < 0.003) g *= t / 0.003; // de-click
            } else {
              const r = c.r;
              const Eh = s.partialAtt ? 1 - Math.exp(-t / (s.att * (1 + s.partialAtt * (r - 1)))) : E1;
              g *= s.dyn ? Math.pow(Eh * rel, s.dyn * (r - 1) / 4) * Eh : Eh;
              if (chiff && r > 1.5) g *= 1 + chiff;
            }
            g *= scale;
          }
          const g0 = prev[i];
          prev[i] = g;
          if (g0 < 1e-7 && g < 1e-7) continue;
          if (g > 1e-6) alive = true;
          const inc = f / sr, dg = (g - g0) / n;
          let p = ph[i], a = g0;
          for (let j = 0; j < n; j++) {
            const x = p * TBL, k = x | 0;
            out[j] += a * (SIN[k] + (x - k) * (SIN[k + 1] - SIN[k]));
            a += dg;
            p += inc; if (p >= 1) p -= 1;
          }
          ph[i] = p;
        }

        // stochastic part
        const z = this.nz;
        if (z) {
          const lvl = s.gain * eng.voiceLevel * rel * (s.struck ? 1 : E1 * ampMod);
          if (z.harm.length && Math.abs(fmul / this.f0 - 1) > 0.002) for (const hz of z.harm) hz.f.set(hz.h * fmul, s.noise.harmQ, sr);
          const b = z.burst;
          for (let j = 0; j < n; j++) {
            let y = 0;
            if (z.hiss) y += z.hiss.g * z.hiss.f.bp(this.rng.noise());
            for (const hz of z.harm) y += hz.gg * hz.f.bp(this.rng.noise());
            y *= lvl;
            if (b && b.env > 1e-4) { y += b.g * b.env * b.f.bp(this.rng.noise()) * s.gain * eng.voiceLevel * rel; b.env *= b.k; }
            out[j] += y;
          }
          if (b && b.env > 1e-4) alive = true;
        }

        this.t += dt;
        if (this.off >= 0 && rel < 1e-4) return false;
        if (s.struck && !alive && this.t > 0.05 && !(eng.restrike && s.restrike)) return this.off < 0 ? 'silent' : false;
        return true;
      }
    }

    /* ------------------------------------------------------ waveguide voice */
    // 3rd-order Lagrange interpolated read of y[n - d] (d >= 2) from a ring buffer.
    function lagrange(buf, mask, w, d) {
      const base = Math.floor(d) - 1, u = d - base; // u in [1, 2)
      const i0 = (w - base) & mask, i1 = (i0 - 1) & mask, i2 = (i0 - 2) & mask, i3 = (i0 - 3) & mask;
      const um1 = u - 1, um2 = u - 2, um3 = u - 3;
      return -um1 * um2 * um3 / 6 * buf[i0] + u * um2 * um3 / 2 * buf[i1] - u * um1 * um3 / 2 * buf[i2] + u * um1 * um2 / 6 * buf[i3];
    }
    /** Loop parameters for a target f0: integer+fractional delay, loss filter, gain. */
    function stringLoop(f0, t60, t60hi, sr) {
      const P = sr / f0, w0 = TAU * f0 / sr, wr = Math.min(TAU * 3000 / sr, Math.PI * 0.9);
      const mag = (a, w) => (1 - a) / Math.sqrt(1 - 2 * a * Math.cos(w) + a * a);
      const want = Math.pow(10, -3 * (1 / t60hi - 1 / t60) / f0); // |H(wr)|/|H(w0)| per pass
      let lo = 0, hi = 0.97, a = 0;
      if (wr > w0 * 1.01 && mag(hi, wr) / mag(hi, w0) < want) {
        for (let it = 0; it < 40; it++) { a = (lo + hi) / 2; if (mag(a, wr) / mag(a, w0) > want) lo = a; else hi = a; }
      }
      const g = Math.pow(10, -3 / (f0 * t60)) / mag(a, w0);
      const pd = Math.atan2(a * Math.sin(w0), 1 - a * Math.cos(w0)) / w0; // one-pole phase delay at f0
      return { D: Math.max(2, P - pd), a, g: Math.min(g, 0.99999), P };
    }

    class StringVoice {
      constructor(spec, f0, eng, silent) {
        this.spec = spec; this.eng = eng; this.sr = eng.sr;
        this.buf = new Float32Array(8192); this.mask = 8191; this.w = 0;
        this.lp = 0; this.yb = 0;
        this.rng = new Rng((eng.rng.next() * 4294967296) >>> 0);
        this.f0 = f0; this.loop = stringLoop(f0, spec.t60(f0), spec.t60hi, this.sr); this.D = this.loop.D;
        this.off = -1; this.t = 0; this.relEnv = 1; this.pending = -1; this.peak = 1;
        const b = spec.body;
        this.body = b.peaks.map(([fc, Q, g]) => ({ f: new SVF().set(fc, Q, this.sr), g }));
        this.direct = b.direct;
        this.tone = b.lp ? Math.exp(-TAU * b.lp / this.sr) : 0; this.toneZ = 0;
        if (!silent) this.strike();
      }

      strike(delay = 0) {
        if (delay > 0) { this.pending = delay; return; }
        const p = this.spec.pluck, N = Math.round(this.loop.P), buf = this.buf, mask = this.mask;
        const shape = new Float32Array(N);
        for (let i = 0; i < N; i++) {
          const x = i / N;
          shape[i] = (x < p.pos ? x / p.pos : (1 - x) / (1 - p.pos)) + p.noise * this.rng.noise();
        }
        // finger / plectrum width: forward-backward one-pole smoothing
        const s = p.soft * 0.9;
        for (let pass = 0; pass < 2; pass++) {
          let z = shape[0];
          for (let i = 0; i < N; i++) { z = s * z + (1 - s) * shape[i]; shape[i] = z; }
          for (let i = N - 1; i >= 0; i--) { z = s * z + (1 - s) * shape[i]; shape[i] = z; }
        }
        let mean = 0; for (let i = 0; i < N; i++) mean += shape[i]; mean /= N;
        let pk = 0; for (let i = 0; i < N; i++) { shape[i] -= mean; pk = Math.max(pk, Math.abs(shape[i])); }
        // damp what is still ringing, then add the new displacement into the last period
        for (let i = 1; i <= N + 4; i++) buf[(this.w - i) & mask] *= 0.3;
        for (let i = 0; i < N; i++) buf[(this.w - N + i) & mask] += shape[i] / pk;
        this.peak = 1;
        this.t = 0;
      }

      setFreq(f) {
        this.f0 = f;
        this.loop = stringLoop(f, this.spec.t60(f), this.spec.t60hi, this.sr);
      }

      release() { if (this.off < 0) this.off = this.t; }

      render(out, n) {
        const s = this.spec, sr = this.sr, buf = this.buf, mask = this.mask, L = this.loop;
        if (this.pending >= 0) { this.pending -= n / sr; if (this.pending < 0) { this.pending = -1; this.strike(); } }
        const a = L.a, g = L.g, J = (s.jaw || 0) * L.P;
        const D0 = this.D, dD = (L.D - D0) / n;
        const gain = s.gain * this.eng.voiceLevel * 5;
        const relK = this.off >= 0 ? Math.exp(-1 / (s.rel * sr)) : 1;
        let w = this.w, lp = this.lp, yb = this.yb, env = this.relEnv, D = D0, tz = this.toneZ, e = 0;
        for (let j = 0; j < n; j++) {
          D += dD;
          let d = D;
          if (J) {
            // jawari: one-sided contact with the curved bridge shortens the vibrating
            // length while the string is displaced towards it (Siddiq 2012). The
            // self-modulation spreads energy into ever higher harmonics.
            d = D - J * Math.min(yb > 0 ? yb : 0, 1.5);
          }
          const x = lagrange(buf, mask, w, d);
          lp = (1 - a) * x + a * lp;
          const y = g * lp;
          buf[w] = y; w = (w + 1) & mask;
          yb = y;
          let o = this.direct * y;
          for (let k = 0; k < this.body.length; k++) o += this.body[k].g * this.body[k].f.bp(y);
          if (this.tone) { tz = this.tone * tz + (1 - this.tone) * o; o = tz; }
          out[j] += o * gain * env;
          env *= relK;
          e += y * y;
        }
        this.w = w; this.lp = lp; this.yb = yb; this.relEnv = env; this.D = L.D; this.toneZ = tz;
        this.t += n / sr;
        if (this.off >= 0 && env < 1e-4) return false;
        if (e / n < 1e-12 && this.t > 0.1 && this.pending < 0) return this.off < 0 ? 'silent' : false;
        return true;
      }
    }

    /* ------------------------------------------------ sympathetic strings */
    class SympBank {
      constructor(sr) { this.sr = sr; this.strings = []; this.energy = 0; this.idle = 0; }
      tune(freqs) {
        const sr = this.sr;
        const old = this.strings;
        this.strings = freqs.filter(f => f > 60 && f < sr / 8).slice(0, 13).map((f, i) => {
          const L = stringLoop(f, 4, 1.2, sr);
          const prev = old[i];
          return { L, buf: prev ? prev.buf : new Float32Array(4096), w: prev ? prev.w : 0, lp: 0, c: (1 - L.g) * 2.5 };
        });
      }
      render(input, out, n, active) {
        if (!this.strings.length) return;
        if (!active && this.idle > this.sr * 2) return;
        let e = 0;
        for (const st of this.strings) {
          const { D, a, g } = st.L, buf = st.buf;
          let w = st.w, lp = st.lp;
          for (let j = 0; j < n; j++) {
            const x = lagrange(buf, 4095, w, D);
            lp = (1 - a) * x + a * lp;
            const y = g * lp + st.c * input[j];
            buf[w] = y; w = (w + 1) & 4095;
            out[j] += y * 0.35;
            e += y * y;
          }
          st.w = w; st.lp = lp;
        }
        this.idle = e < 1e-10 && !active ? this.idle + n : 0;
      }
    }

    /* ------------------------------------------------------------- engine */
    const SYMP_DRIVE = 0.2;
    class Engine {
      /** `seed` makes rendering reproducible (tests); by default every session differs. */
      constructor(sr, seed) {
        this.sr = sr;
        this.rng = new Rng(seed || (Math.random() * 4294967296) >>> 0);
        this.voices = new Map(); // id -> {v, spec, freq, order}
        this.vibrato = true;
        this.restrike = true;
        this.voiceLevel = 0.06;
        this.order = 0;
        this.symp = new SympBank(sr);
        this.sympIn = new Float32Array(128);
        this.limG = 1;
        this.time = 0;
        this.beatNext = 0;
        this.cycleNext = 0; this.cycleLast = 0;
        this.tmp = new Float32Array(128);
      }

      handle(m) {
        switch (m.t) {
          case 'on': this.noteOn(m.id, m.freq, m.inst, m); break;
          case 'off': this.noteOff(m.id); break;
          case 'freq': this.setFreq(m.id, m.freq); break;
          case 'allOff': for (const id of [...this.voices.keys()]) this.noteOff(id); break;
          case 'opts': if ('vibrato' in m) this.vibrato = m.vibrato; if ('restrike' in m) this.restrike = m.restrike; break;
          case 'symp': this.symp.tune(m.freqs); break;
        }
      }

      noteOn(id, freq, inst, opts) {
        const spec = INSTRUMENTS[inst] || INSTRUMENTS.saw;
        const cur = this.voices.get(id);
        if (cur && !cur.released) {
          if (cur.spec === spec) { this.setFreq(id, freq); return; }
          this.noteOff(id);
        }
        // A tanpura string joins the plucking cycle and waits for its turn (unless it is the first).
        const queued = spec.cycle && this.restrike && this.cycleVoices().length > 0;
        const v = spec.kind === 'string' ? new StringVoice(spec, freq, this, queued) : new AddVoice(spec, freq, this, opts);
        const rec = { v, spec, freq, order: this.order++, released: false, lastStrike: queued ? -Infinity : this.time };
        if (spec.cycle && !queued) { this.cycleLast = this.time; this.cycleNext = this.time + this.cycleGap(1); }
        // more strings in the cycle → shorter gap between plucks
        if (queued) this.cycleNext = Math.min(this.cycleNext, this.cycleLast + this.cycleGap(this.cycleVoices().length + 1));
        else if (!spec.cycle && spec.restrike && !this.liveRestrikers().length) this.beatNext = this.time + spec.restrike;
        this.voices.set(id, rec);
      }

      noteOff(id) {
        const r = this.voices.get(id);
        if (!r) return;
        r.v.release(); r.released = true;
        this.voices.delete(id);
        this.voices.set(id + ':x' + this.order++, r);
      }

      setFreq(id, freq) {
        const r = this.voices.get(id);
        if (r && !r.released) { r.freq = freq; r.v.setFreq(freq); }
      }

      liveRestrikers() { return [...this.voices.values()].filter(r => !r.released && r.spec.restrike && !r.spec.cycle); }
      cycleVoices() {
        const c = [...this.voices.values()].filter(r => !r.released && r.spec.cycle).sort((a, b) => a.freq - b.freq);
        // tanpura order: second string first, lowest last (Pa, Sa, Sa, low Sa)
        if (c.length > 1) c.push(c.shift());
        return c;
      }
      cycleGap(n) { return Math.max(0.8, 3.2 / Math.max(1, n)); }

      schedule() {
        if (!this.restrike) return;
        const now = this.time;
        const cyc = this.cycleVoices();
        if (cyc.length && now >= this.cycleNext) {
          // round robin: pluck the string that has waited longest (ties go in cycle order)
          const r = cyc.reduce((a, b) => (b.lastStrike < a.lastStrike ? b : a));
          r.v.strike(); r.lastStrike = now;
          this.cycleLast = now;
          this.cycleNext = now + this.cycleGap(cyc.length);
        }
        const live = this.liveRestrikers();
        if (live.length && now >= this.beatNext) {
          const period = live[0].spec.restrike;
          live.sort((a, b) => a.freq - b.freq).forEach((r, k) => {
            if (now - r.lastStrike < period * 0.5) return;
            const st = r.spec.strum || 0;
            r.v.strike(k * st); r.lastStrike = now;
          });
          this.beatNext = now + period;
        }
      }

      render(out, n) {
        if (this.sympIn.length < n) { this.sympIn = new Float32Array(n); this.tmp = new Float32Array(n); }
        const sympIn = this.sympIn, tmp = this.tmp;
        sympIn.fill(0, 0, n);
        this.schedule();
        let sympActive = false;
        for (const [id, r] of this.voices) {
          let alive;
          if (r.spec.symp) {
            // instruments with sympathetic strings drive the shared bank with their output
            tmp.fill(0, 0, n);
            alive = r.v.render(tmp, n);
            const c = r.spec.symp * SYMP_DRIVE;
            for (let j = 0; j < n; j++) { out[j] += tmp[j]; sympIn[j] += tmp[j] * c; }
            if (!r.released) sympActive = true;
          } else alive = r.v.render(out, n);
          if (alive === false) this.voices.delete(id);
        }
        this.symp.render(sympIn, out, n, sympActive);
        // transparent peak limiter (no waveshaping, so no added harmonics)
        let pk = 0;
        for (let j = 0; j < n; j++) { const a = Math.abs(out[j]); if (a > pk) pk = a; }
        const g0 = this.limG;
        let g1 = pk * g0 > 0.9 ? 0.9 / pk : g0 + (1 - g0) * 0.003;
        if (g1 > 1) g1 = 1;
        if (pk * g1 > 0.9) g1 = 0.9 / pk;
        const dg = (g1 - g0) / n;
        let gg = g0;
        for (let j = 0; j < n; j++) { gg += dg; out[j] *= Math.min(gg, g1 < g0 ? g1 : gg); }
        this.limG = g1;
        this.time += n / this.sr;
      }

      get active() { return this.voices.size > 0; }
    }

    const META = {};
    for (const [k, s] of Object.entries(INSTRUMENTS)) {
      META[k] = { label: s.label, group: s.group, about: s.about, pure: !!s.pure, decays: !!(s.struck || s.kind === 'string'), vibrato: !!(s.vib && (s.vib.depth || s.vib.amp || s.vib.drift)), symp: !!s.symp };
    }
    return { Engine, INSTRUMENTS: META, _specs: INSTRUMENTS, stringLoop };
  }

  const api = factory();
  api.factory = factory;
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.HSynth = api;
})(typeof self !== 'undefined' ? self : this);
