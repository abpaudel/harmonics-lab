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
 *  4. Modal resonators for bars, bells, bowls, tines and pans (Adrien 1991): every
 *     vibrational mode is a damped complex phasor, so it rings at exactly r·f0 and can
 *     glide when retuned without clicks. The mallet's contact time low-passes the
 *     excitation; striking harder shortens it and brings out the upper modes.
 *
 * Dynamics (velocity 0–1, 0.7 = mf) act on timbre, not just level: louder notes tilt
 * every spectrum towards the upper partials by an instrument-specific amount (hammer
 * felt stiffening, brass and reed brightening), pluck shapes get sharper, and mallets
 * shorter. At the default 0.7 every model sounds exactly as calibrated.
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
    const VEL0 = 0.7;                                   // mezzo-forte: the calibrated level
    const velGain = (v, range = 20) => dB(range * (v - VEL0)); // ~20 dB from pp to ff

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

    /** A piano soundboard: broad, irregular low-Q resonances (a few dB of colour). */
    function soundboard(seed) {
      const r = new Rng(seed), peaks = [];
      for (let i = 0; i < 22; i++) peaks.push([90 * Math.pow(2, i * 5.4 / 22 + (r.next() - 0.5) * 0.15), 3 + r.next() * 5, 0.15 + 0.35 * r.next()]);
      return parallelBody({ floor: 0.7, peaks });
    }
    const piano = {
      kind: 'add', group: 'Western', label: 'Piano',
      about: 'Modal synthesis: stiff-string partials stretched by the register\'s inharmonicity B, hammer at 1/8 of the string through a felt low-pass that opens up the harder the key is struck, decay σ = b₁ + b₃f², two slightly detuned unison strings (beating, double decay). The soundboard colours every partial irregularly.',
      body: soundboard(1709), bright: 1.6,
      struck: true, att: 0.002, rel: 0.25, restrike: 3, maxH: 64, gain: 0.95,
      B: f0 => clamp(Math.pow(10, -3.4 + 0.024 * (midiOf(f0) - 60)), 1.2e-4, 0.02),
      unison: [-0.35, 0.35],
      src: (h, f0, f) => {
        const fc = clamp(2400 * Math.pow(f0 / 261.6, 0.5), 900, 9000);
        return (0.12 + 0.88 * Math.abs(Math.sin(Math.PI * h / 8.2))) * Math.pow(h, -0.55) / (1 + (f / fc) * (f / fc));
      },
      sigma: (f, f0) => 0.9 * Math.pow(2, (midiOf(f0) - 60) / 18) + 1.5e-7 * f * f,
      decay2: { w: 0.12, div: 7 },
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

    // Tabla: the dayan's loaded membrane (Raman's five harmonic modes, each a
    // near-degenerate pair, plus quick inharmonic modes) and the bayan's bass modes.
    // A stroke (bol) shapes which modes it excites and how fast they are damped; the
    // syahi's tension rise just after the stroke bends the pitch down into the note.
    const TABLA_STROKES = {
      // Na / Ta: rim stroke, ring finger resting on the syahi's edge
      na: { amp: () => 1, decay: () => 1, slap: 0 },
      // Tin / Din: the open maidan; the fundamental is damped, 2nd–3rd harmonics ring
      tin: { amp: k => (k === 1 ? 0.3 : k === 2 ? 1.3 : k === 3 ? 1.1 : k > 5 ? 0.5 : 0.9), decay: () => 1.15, slap: -6 },
      // Tun: centre of the syahi, undamped: almost only the fundamental, ringing long
      tun: { amp: k => (k === 1 ? 1.6 : k > 5 ? 0.2 : 0.35), decay: () => 1.4, slap: -10 },
      // Te / Ti: flat fingers stay on the syahi, a dry closed slap
      te: { amp: k => (k > 5 ? 1.5 : 0.5), decay: () => 0.12, slap: 3 },
    };
    // bol → dayan stroke + open bayan (Ge)
    const BOLS = { Dha: ['na', 1], Dhin: ['tin', 1], Ta: ['na', 0], Tin: ['tin', 0], Tun: ['tun', 0], Te: ['te', 0] };
    const tabla = {
      kind: 'modal', group: 'Indian', label: 'Tabla',
      about: 'Modal synthesis of the loaded membrane: the syahi makes the dayan\'s first five modes harmonic (1:2:3:4:5), as C. V. Raman showed, each a slightly split pair, plus quick inharmonic modes. Each bol excites them differently: Na rings the harmonics, Tin damps the fundamental, Tun is almost only the fundamental, Te is a dry slap. Dha and Dhin add the bayan\'s open Ge, whose pitch sinks just after the stroke. With Re-strike a latched note plays the Teentaal theka.',
      mallet: 3200, rel: 0.1, restrike: 0.42, gain: 1.1,
      // Teentaal: Dha Dhin Dhin Dha | Dha Dhin Dhin Dha | Dha Tin Tin Ta | Ta Dhin Dhin Dha
      pattern: ['Dha', 'Dhin', 'Dhin', 'Dha', 'Dha', 'Dhin', 'Dhin', 'Dha', 'Dha', 'Tin', 'Tin', 'Ta', 'Ta', 'Dhin', 'Dhin', 'Dha'],
      strokes: TABLA_STROKES, bols: BOLS,
      bend: [{ cents: 30, tau: 0.035 }, { cents: 70, tau: 0.07 }], // dayan, bayan
      modes: f0 => {
        const m = [], t60 = f => 6.9 / (2.6 + 2e-6 * f * f);
        [1, 0.75, 0.55, 0.35, 0.22].forEach((a, i) => {
          const r = i + 1, T = t60(r * f0);
          m.push({ r: r * Math.pow(2, -0.5 / 1200), a: a * 0.6, t60: T, h: r }, { r: r * Math.pow(2, 0.5 / 1200), a: a * 0.6, t60: T, h: r });
        });
        [[6.3, 0.15], [7.45, 0.1], [8.8, 0.08], [10.2, 0.05]].forEach(([r, a]) => m.push({ r, a, t60: 6.9 / (6.9 / t60(r * f0) + 14), h: 99 }));
        // bayan, about an octave and a fourth below, its overtones only roughly harmonic
        [[1, 0.9, 0.9], [1.98, 0.3, 0.5], [2.95, 0.12, 0.3]].forEach(([r, a, T]) => m.push({ r: r * 0.375, a, t60: T, grp: 1 }));
        return m;
      },
      noise: { burst: -9, burstF: 3000, burstQ: 0.8, burstTau: 0.006 },
    };

    const violin = {
      kind: 'add', group: 'Western', label: 'Violin',
      about: 'Bowed string: Helmholtz-motion sawtooth (bow at 1/10, notching every 10th harmonic) through a dense, irregular body response with the bridge hill near 2.5 kHz. Vibrato sweeps each partial across the body peaks, so harmonics shimmer; plus bow noise and attack scratch.',
      shimmer: 1.5,
      att: 0.08, rel: 0.15, partialAtt: 0.05, dyn: 0.4, maxH: 40, gain: 1,
      src: h => (0.3 + 0.7 * Math.abs(Math.sin(Math.PI * h * 0.1))) / h,
      body: bowedBody(1, 7, 2500),
      vib: { rate: 5.8, depth: 18, amp: 0.05, delay: 0.25, drift: 3 },
      scoop: { cents: -10, tau: 0.05 },
      noise: { sync: 0.7, hiss: -40, hissF: 3500, hissQ: 0.8, harm: -36, harmQ: 30, burst: -22, burstF: 2000, burstQ: 1, burstTau: 0.03 },
    };
    const cello = {
      ...violin, label: 'Cello',
      about: 'Bowed string like the violin, with a body about 2.4× larger: main air and wood modes near 110–230 Hz and the bridge hill lower, giving the darker, warmer timbre; slower, wider vibrato.',
      att: 0.12, body: bowedBody(0.42, 11, 2300),
      vib: { rate: 5.2, depth: 16, amp: 0.05, delay: 0.3, drift: 3 },
    };

    const flute = {
      kind: 'add', group: 'Western', label: 'Flute',
      about: 'Spectral model: strong fundamental with harmonics falling ~6 dB each (purer in the high register), soft breath noise concentrated around the first harmonics (only a trace of broadband hiss), an attack chiff, and the flute\'s mostly-amplitude vibrato.',
      shimmer: 0.8,
      att: 0.07, rel: 0.12, dyn: 0.6, maxH: 16, gain: 1,
      src: (h, f0) => Math.exp(-(0.75 + 0.6 * clamp(Math.log2(f0 / 262), 0, 2)) * (h - 1)),
      chiff: { gain: 1, tau: 0.05 },
      vib: { rate: 5, depth: 6, amp: 0.12, delay: 0.3, drift: 2 },
      noise: { sync: 0.35, hiss: -52, hissF: 2500, hissQ: 1, harm: -38, harmQ: 30, burst: -30, burstF: 1500, burstQ: 1, burstTau: 0.03 },
    };
    const bansuri = {
      ...flute, group: 'Indian', label: 'Bansuri',
      about: 'Bamboo transverse flute: an even more fundamental-heavy, hollow spectrum than the metal flute, a soft, breathy colour around the low harmonics, a soft slow-speaking attack that slides up into the note, and gentle andolan-like vibrato.',
      att: 0.11, rel: 0.2, dyn: 0.5,
      src: (h, f0) => Math.exp(-(1.0 + 0.5 * clamp(Math.log2(f0 / 262), 0, 2)) * (h - 1)),
      scoop: { cents: -20, tau: 0.08 },
      vib: { rate: 4.6, depth: 7, amp: 0.15, delay: 0.45, drift: 3 },
      noise: { sync: 0.35, hiss: -56, hissF: 2000, hissQ: 1, harm: -38, harmQ: 30, burst: -32, burstF: 1200, burstQ: 1, burstTau: 0.05 },
    };

    const clarinet = {
      kind: 'add', group: 'Western', label: 'Clarinet',
      about: 'Closed cylindrical bore: odd harmonics dominate below the tone-hole cutoff (~1.6 kHz) while even ones are 20–25 dB down; above the cutoff even harmonics fill in and the spectrum rolls off. Straight tone, little breath noise.',
      shimmer: 0.5,
      att: 0.04, rel: 0.08, dyn: 0.5, maxH: 40, gain: 1,
      src: (h, f0, f) => {
        const fc = 1600, x = clamp((f - fc * 0.7) / (fc * 0.8), 0, 1);
        const even = 0.06 + 0.6 * x * x * (3 - 2 * x);
        return (h % 2 ? 1 : even) * Math.pow(h, -0.9) / (f > fc ? Math.pow(f / fc, 1.5) : 1);
      },
      vib: { rate: 5, depth: 0, amp: 0, delay: 0, drift: 1.5 },
      noise: { sync: 0.5, hiss: -44, hissF: 2500, hissQ: 0.7, harm: -42, harmQ: 20, burst: -28, burstF: 1500, burstQ: 1, burstTau: 0.02 },
    };
    const oboe = {
      kind: 'add', group: 'Western', label: 'Oboe',
      about: 'Double reed on a conical bore: rich harmonics shaped by fixed formants near 1.1 kHz and 2.9 kHz (the nasal colour), with a weak fundamental in the low register.',
      shimmer: 0.8,
      att: 0.045, rel: 0.1, dyn: 0.5, maxH: 40, gain: 1,
      src: h => Math.pow(h, -0.4),
      body: parallelBody({ floor: 0.15, peaks: [[1150, 2.2, 1], [2900, 3, 0.45], [4400, 4, 0.15]], hp: 400, lp: 6000, n: 4 }),
      vib: { rate: 5.2, depth: 9, amp: 0.04, delay: 0.25, drift: 2 },
      noise: { sync: 0.5, hiss: -44, hissF: 3000, hissQ: 0.7, burst: -26, burstF: 1500, burstQ: 1, burstTau: 0.02 },
    };
    const shehnai = {
      kind: 'add', group: 'Indian', label: 'Shehnai',
      about: 'Keyless double-reed oboe with a flared metal bell: very bright and nasal (formants near 1.25, 2.5 and 3.6 kHz, weak fundamental), notes approached with a meend from below and a wide, singing vibrato.',
      shimmer: 1.0,
      att: 0.05, rel: 0.12, dyn: 0.6, maxH: 40, gain: 0.95,
      src: h => Math.pow(h, -0.25),
      body: parallelBody({ floor: 0.1, peaks: [[1250, 2, 1], [2500, 2.5, 0.6], [3600, 3, 0.3]], hp: 450, lp: 7000, n: 3 }),
      scoop: { cents: -60, tau: 0.1 },
      vib: { rate: 5.6, depth: 22, amp: 0.05, delay: 0.3, drift: 5 },
      noise: { sync: 0.5, hiss: -38, hissF: 3500, hissQ: 0.7, burst: -24, burstF: 1800, burstQ: 1, burstTau: 0.02 },
    };
    const trumpet = {
      kind: 'add', group: 'Western', label: 'Trumpet',
      about: 'Brass after Risset: the higher a harmonic, the more its level depends on loudness, so upper partials enter late in the attack and the tone darkens as it fades; bell formant near 1.2 kHz, a small lip scoop up to pitch.',
      shimmer: 0.6,
      att: 0.035, rel: 0.09, dyn: 1, partialAtt: 0.25, maxH: 30, gain: 0.95,
      src: h => Math.pow(h, -0.3),
      body: parallelBody({ floor: 0.1, peaks: [[1200, 1.2, 1], [2700, 2.5, 0.35]], hp: 350, lp: 5000, n: 3 }),
      scoop: { cents: -35, tau: 0.04 },
      vib: { rate: 5.5, depth: 8, amp: 0.03, delay: 0.35, drift: 2 },
      noise: { sync: 0.5, hiss: -42, hissF: 2000, hissQ: 0.7, burst: -22, burstF: 1500, burstQ: 1, burstTau: 0.02 },
    };
    const organ = {
      kind: 'add', group: 'Western', label: 'Pipe organ',
      about: 'Principal 8′ + Octave 4′ flue pipes: two ranks of steady harmonic spectra (the 4′ reinforcing even harmonics, a fraction of a cent off so the chorus breathes), wind noise and a short pipe chiff. No vibrato.',
      att: 0.05, rel: 0.12, maxH: 32, gain: 0.9,
      layers: [{ mult: 1, cents: 0, gain: 1 }, { mult: 2, cents: 0.6, gain: 0.45 }],
      src: h => Math.pow(h, -1.15),
      chiff: { gain: 0.8, tau: 0.04 },
      noise: { sync: 0.2, hiss: -48, hissF: 1500, hissQ: 0.6, burst: -30, burstF: 2500, burstQ: 1, burstTau: 0.03 },
    };
    // Source–filter voices: one glottal source, a cascade of formants per vowel
    // (adult male averages, after Peterson & Barney 1952).
    const sung = (label, vowel, formants, extra) => ({
      kind: 'add', group: 'Voice', label,
      about: `Source–filter voice: glottal pulse spectrum (−6 dB/oct after lip radiation) through a cascade of formant resonators for ${vowel}. Vibrato moves the harmonics through the formants, each partial shimmers a little, and the breath noise pulses with every glottal cycle.`,
      att: 0.09, rel: 0.15, dyn: 0.3, maxH: 40, gain: 1, shimmer: 1.2,
      src: h => 1 / h,
      body: cascadeBody(formants),
      vib: { rate: 5.5, depth: 30, amp: 0.05, delay: 0.3, drift: 4 },
      noise: { sync: 0.6, hiss: -42, hissF: 3000, hissQ: 0.8, harm: -36, harmQ: 15 },
      ...extra,
    });
    const voice = sung('Voice "aah"', '"aa" (730, 1090, 2440, 3400, 4200 Hz)', [[730, 90], [1090, 110], [2440, 170], [3400, 250], [4200, 300]]);
    const voiceEe = sung('Voice "ee"', '"ee" (270, 2290, 3010, 3400, 4200 Hz): a very low first formant and a high second one, so the low harmonics and a bright cluster near 2.3–3 kHz sound while the middle is hollow', [[270, 60], [2290, 100], [3010, 150], [3400, 220], [4200, 280]]);
    const voiceOo = sung('Voice "ooh"', '"oo" (300, 870, 2240 Hz…): both low formants sit below 1 kHz, so the tone is dark and round', [[300, 70], [870, 90], [2240, 160], [3400, 250], [4200, 300]]);
    const humming = sung('Humming "mm"', 'the closed-lip nasal murmur: a strong resonance near 250 Hz and weak ones above, the sound radiating through the nose with almost no upper harmonics', [[250, 80], [1000, 300], [2200, 350], [3300, 400]], {
      about: 'Humming with closed lips: the glottal source through the nasal tract, whose strong murmur resonance near 250 Hz and weak upper formants leave a soft, nearly pure tone of a few harmonics. Gentle vibrato, almost no breath.',
      body: cascadeBody([[250, 80], [1000, 300], [2200, 350], [3300, 400]], 1200),
      noise: { sync: 0.6, hiss: -56, hissF: 1500, hissQ: 0.8 },
      vib: { rate: 5.3, depth: 18, amp: 0.04, delay: 0.35, drift: 3 },
    });
    const harmonium = {
      kind: 'add', group: 'Indian', label: 'Harmonium',
      about: 'Free reed: a bright, rich spectrum (≈ n^−0.75) lifted by the reed chamber around 2.2 kHz, reeds that buzz into speech in ~35 ms and slight bellows pressure swells. Fixed pitch — no vibrato.',
      shimmer: 0.4,
      att: 0.035, rel: 0.08, dyn: 0.2, maxH: 40, gain: 0.85,
      src: h => Math.pow(h, -0.75),
      body: parallelBody({ floor: 1, peaks: [[2200, 2, 0.8]], lp: 7000, n: 2 }),
      vib: { rate: 0.8, depth: 0, amp: 0.04, delay: 0.2, drift: 1, wobble: true },
      noise: { sync: 0.5, hiss: -46, hissF: 2500, hissQ: 0.7, burst: -30, burstF: 1500, burstQ: 1, burstTau: 0.02 },
    };
    const sarangi = {
      kind: 'add', group: 'Indian', label: 'Sarangi',
      about: 'Bowed gut strings over a skin-covered body: Helmholtz sawtooth shaped by membrane formants (≈ 0.9, 1.7, 2.9 kHz) — very vocal — with a wide gamak vibrato and some 35 sympathetic strings (here a bank tuned to the current scale) ringing behind it.',
      shimmer: 1.8,
      att: 0.1, rel: 0.2, dyn: 0.4, partialAtt: 0.05, maxH: 40, gain: 0.9, symp: 1,
      src: h => (0.3 + 0.7 * Math.abs(Math.sin(Math.PI * h * 0.12))) * Math.pow(h, -1.1),
      body: parallelBody({ floor: 0.25, peaks: [[420, 4, 0.8], [900, 3, 1], [1700, 3, 0.55], [2900, 3, 0.4]], hp: 180, lp: 5000, n: 3 }),
      vib: { rate: 5, depth: 22, amp: 0.06, delay: 0.3, drift: 4 },
      noise: { sync: 0.7, hiss: -38, hissF: 3000, hissQ: 0.8, harm: -34, harmQ: 25, burst: -22, burstF: 1800, burstQ: 1, burstTau: 0.04 },
    };

    // Waveguide strings. t60: decay of the fundamental (s); t60hi: decay at 3 kHz.
    const guitar = {
      kind: 'string', group: 'Western', label: 'Guitar (nylon)',
      about: 'Digital waveguide (extended Karplus–Strong): a delay line one period long with a frequency-dependent loss filter, plucked with the finger 1/5 from the bridge (missing every 5th harmonic). Commuted synthesis: the pluck is convolved with the body\'s impulse response (air and top-plate resonances near 100, 200, 400 Hz, then dozens of plate modes), so the body comes nearly for free. Two polarisations, one decaying fast into the bridge and one ringing on a fraction of a cent sharp, give the two-stage decay. Chords are strummed.',
      t60: f0 => clamp(5 * Math.pow(110 / f0, 0.4), 1.5, 8), t60hi: 0.5,
      pluck: { pos: 0.19, soft: 0.35, noise: 0.05 },
      body: { direct: 0.7, peaks: [[100, 6, 1], [205, 10, 0.8], [400, 8, 0.4]], dense: { n: 36, lo: 480, hi: 5000, q: [12, 35], amp: 1 }, lp: 5000 },
      pol: { amt: 0.45, cents: 0.6, decay: 2.3 },
      restrike: 3, strum: 0.014, rel: 0.12, gain: 1,
    };
    const sitar = {
      kind: 'string', group: 'Indian', label: 'Sitar',
      about: 'Waveguide string on a jawari bridge: the string\'s displacement shortens its vibrating length (after Siddiq 2012), continually pushing energy into high harmonics — the buzzing zing that sweeps through the spectrum. The output is the force on the bridge (∝ the slope of the string), so the high harmonics the jawari makes are heard, coloured by a bridge formant near 3.3 kHz. Tone and sustain are matched to a measured recording. Mizrab pluck near the bridge, gourd resonances, and 11 sympathetic taraf strings tuned to the current scale.',
      // fitted to a recording (Commons "Sitar clipping.ogg", D4): long sustain (~5 dB/s),
      // a bridge/body formant near 3.3 kHz over a dip near 2.2 kHz, steep fall above 5 kHz
      t60: () => 16, t60hi: 3, jaw: 0.05,
      force: { r: 0.9, p: 0.8, disperse: [[300, 2], [520, 3], [800, 2], [1150, 3], [1800, 2], [2600, 3]], eq: [[3300, 2.5, 10], [2200, 1.8, -9], [6000, 1, -3]] },
      pluck: { pos: 0.1, soft: 0.1, noise: 0.08 },
      body: { direct: 0.8, peaks: [[180, 4, 0.6], [520, 5, 0.5], [1150, 4, 0.6], [2600, 3, 0.5]], dense: { n: 24, lo: 300, hi: 4500, q: [10, 25], amp: 0.6 } },
      pol: { amt: 0.35, cents: 0.5, decay: 1.5 },
      restrike: 2.5, rel: 0.3, symp: 1.2, gain: 0.85,
    };
    const tanpura = {
      kind: 'string', group: 'Indian', label: 'Tanpura',
      about: 'Long, soft finger plucks on a wide jawari tuned with the jiva thread: the high harmonics bloom after each pluck and keep moving. Latched notes are plucked in turn in the classic cycle (e.g. Pa – Sa – Sa – low Sa).',
      t60: () => 10, t60hi: 3, jaw: 0.035,
      pluck: { pos: 0.3, soft: 0.7, noise: 0.02 },
      body: { direct: 0.8, peaks: [[110, 4, 0.7], [240, 5, 0.6], [700, 3, 0.4]], dense: { n: 24, lo: 300, hi: 4000, q: [10, 25], amp: 0.6 } },
      pol: { amt: 0.4, cents: 0.4, decay: 1.5 },
      restrike: 3.2, cycle: true, rel: 0.5, gain: 1,
    };
    const veena = {
      kind: 'string', group: 'Indian', label: 'Veena',
      about: 'Saraswati veena: waveguide string with a mild jawari (a gentler buzz than the sitar), fingernail pluck and the deep resonance of the large jackfruit-wood body.',
      t60: () => 6, t60hi: 1.2, jaw: 0.012,
      pluck: { pos: 0.15, soft: 0.3, noise: 0.05 },
      body: { direct: 0.75, peaks: [[90, 5, 0.8], [200, 6, 0.7], [450, 4, 0.4], [1500, 3, 0.3]], dense: { n: 30, lo: 350, hi: 4500, q: [12, 30], amp: 0.6 } },
      pol: { amt: 0.4, cents: 0.5, decay: 1.6 },
      restrike: 3, rel: 0.3, symp: 0.2, gain: 1,
    };


    /* -------------------------------------------- modal (struck bars, bells…) */
    // modes(f0): [{ r: ratio to f0, a: amplitude, t60: decay (s), split?: doublet
    // spacing (Hz), drive?: grown from mode 0 by a quadratic nonlinearity, trem?: under
    // the vibraphone motor, h?/grp?: tabla stroke harmonic / drum }]. mallet: excitation
    // corner frequency (Hz) at mf. ref: the mode that sounds the played pitch (default 1).
    const marimba = {
      kind: 'modal', group: 'Mallets & bells', label: 'Marimba',
      about: 'Modal synthesis of a rosewood bar. The bar is arched thin underneath so that its first three modes are tuned 1 : 4 : 10 (two octaves, then three octaves and a major third). The tube resonator reinforces the fundamental, and the upper modes die away quickly. Yarn mallet: a harder strike is shorter, so it excites more of the upper modes.',
      mallet: 1400, rel: 0.4, restrike: 2.2, gain: 1.8,
      modes: f0 => {
        const T = clamp(1.6 * Math.pow(262 / f0, 0.6), 0.3, 3.5);
        return [{ r: 1, a: 1, t60: T }, { r: 4, a: 0.45, t60: T * 0.2 }, { r: 10, a: 0.22, t60: T * 0.08 }];
      },
      noise: { burst: -26, burstF: 900, burstQ: 1, burstTau: 0.004 },
    };
    const xylophone = {
      kind: 'modal', group: 'Mallets & bells', label: 'Xylophone',
      about: 'Modal synthesis of a hard rosewood bar tuned "quint": the second mode is a twelfth above the fundamental (1 : 3). The short tube resonator and hard mallets give the dry, bright, quickly fading tone; the third mode is not tuned.',
      mallet: 4500, rel: 0.25, restrike: 1.4, gain: 2,
      modes: f0 => {
        const T = clamp(0.9 * Math.pow(523 / f0, 0.6), 0.2, 1.6);
        return [{ r: 1, a: 1, t60: T }, { r: 3, a: 0.55, t60: T * 0.35 }, { r: 6.1, a: 0.12, t60: T * 0.12 }];
      },
      noise: { burst: -20, burstF: 2800, burstQ: 1, burstTau: 0.003 },
    };
    const vibraphone = {
      kind: 'modal', group: 'Mallets & bells', label: 'Vibraphone',
      about: 'Aluminium bars tuned 1 : 4 : 10 like the marimba, but metal rings for many seconds. Motor-driven discs open and close the resonator tubes, so the fundamental pulses (tremolo; switch off with Vibrato). Releasing a key drops the damper bar.',
      mallet: 900, rel: 0.12, restrike: 4, gain: 1.3,
      trem: { rate: 5.2, depth: 0.75 },
      modes: f0 => {
        const T = clamp(6 * Math.pow(262 / f0, 0.5), 2, 10);
        return [{ r: 1, a: 1, t60: T, trem: true }, { r: 4, a: 0.22, t60: T * 0.3 }, { r: 10, a: 0.05, t60: T * 0.12 }];
      },
      noise: { burst: -32, burstF: 1500, burstQ: 1, burstTau: 0.004 },
    };
    const glockenspiel = {
      kind: 'modal', group: 'Mallets & bells', label: 'Glockenspiel',
      about: 'Steel bars that are not tuned beyond the fundamental: the modes of a free bar fall at 1 : 2.76 : 5.40 : 8.93. The spectrum is inharmonic, but these partials are weak beside the long-ringing fundamental, so the pitch is clear. Hard brass mallets.',
      mallet: 9000, rel: 0.5, restrike: 2.5, gain: 1.3, inharmonic: true,
      modes: f0 => {
        const T = clamp(3.5 * Math.pow(1047 / f0, 0.3), 1.2, 6);
        return [{ r: 1, a: 1, t60: T }, { r: 2.756, a: 0.3, t60: T * 0.5 }, { r: 5.404, a: 0.13, t60: T * 0.3 }, { r: 8.933, a: 0.05, t60: T * 0.2 }];
      },
      noise: { burst: -24, burstF: 5000, burstQ: 1, burstTau: 0.002 },
    };
    // Free-free tube, modes 1 … 7 (2.756, 5.404, 8.933, 13.34, 18.64, 24.89 × mode 1),
    // scaled so that mode 4 sits at 2 f0: modes 4, 5, 6 are nearly 2 : 3 : 4 and
    // their missing fundamental is the strike note heard.
    const TUBE = [1, 2.756, 5.404, 8.933, 13.34, 18.64, 24.89].map(x => 2 * x / 8.933);
    const tubularBells = {
      kind: 'modal', group: 'Mallets & bells', label: 'Tubular bells',
      about: 'Orchestral chimes: a free tube\'s modes are inharmonic, but modes 4, 5 and 6 fall close to 2 : 3 : 4. The ear hears their missing fundamental, the strike note, which is the pitch played. No partial sounds at that pitch: watch the spectrum. It is a virtual pitch.',
      mallet: 3500, rel: 1, restrike: 4, gain: 0.9, inharmonic: true, ref: 2,
      modes: f0 => {
        const T = clamp(10 * Math.pow(262 / f0, 0.5), 3, 15);
        const a = [0.12, 0.3, 0.55, 1, 0.8, 0.55, 0.3], d = [1.2, 1, 0.8, 0.7, 0.55, 0.45, 0.35];
        return TUBE.map((r, i) => ({ r, a: a[i], t60: T * d[i], split: 0.3 }));
      },
      noise: { burst: -24, burstF: 3500, burstQ: 1, burstTau: 0.003 },
    };
    const churchBell = {
      kind: 'modal', group: 'Mallets & bells', label: 'Church bell',
      about: 'A tuned minor-third bell, modal synthesis: hum ½, prime 1, tierce 1.2 (a minor third!), quint 1.5, nominal 2, then 2.5, 2.67, 3 and 4. The nominal and tierce dominate the strike, then the hum outlasts everything. Every mode but the prime is a split pair, and the pairs beat as the bell "warbles".',
      mallet: 5000, rel: 1.5, restrike: 4.5, gain: 0.85, inharmonic: true,
      modes: f0 => {
        const T = clamp(30 * Math.pow(262 / f0, 0.8), 5, 40);
        return [[0.5, 0.5, 1], [1, 0.45, 0.55], [1.2, 0.6, 0.4], [1.5, 0.2, 0.3], [2, 1, 0.25], [2.5, 0.3, 0.15], [2.667, 0.2, 0.15], [3, 0.3, 0.12], [4, 0.15, 0.08]]
          .map(([r, a, d]) => ({ r, a, t60: T * d, split: f0 * 0.002 * Math.sqrt(r) }));
      },
      noise: { burst: -22, burstF: 4000, burstQ: 1, burstTau: 0.003 },
    };
    const singingBowl = {
      kind: 'modal', group: 'World', label: 'Singing bowl (struck)',
      about: 'Himalayan bowl struck with a padded stick: the shell\'s bending modes fall near 1 : 2.7 : 5.1 : 8.3, and small asymmetries split each overtone in two. The split modes beat, giving the slow "wah" of each partial. The fundamental rings for half a minute.',
      mallet: 1500, rel: 2, restrike: 6, gain: 0.9, inharmonic: true,
      modes: f0 => {
        const T = clamp(20 * Math.pow(300 / f0, 0.6), 6, 40), k = f0 / 300;
        return [[1, 1, 1, 1.2], [2.71, 0.55, 0.55, 2.4], [5.1, 0.25, 0.3, 3.6], [8.3, 0.1, 0.18, 5]]
          .map(([r, a, d, sp]) => ({ r, a, t60: T * d, split: sp * k }));
      },
      noise: { burst: -30, burstF: 1200, burstQ: 1, burstTau: 0.004 },
    };
    const gangsa = {
      kind: 'modal', group: 'World', label: 'Gamelan gangsa (pair)',
      about: 'Balinese bronze keys are played in pairs tuned a few hertz apart, the lower pengumbang and the higher pengisep. Together they beat at a steady ~6 Hz ("ombak", the wave), which makes the shimmer. The keys\' modes (≈ 1 : 2.65 : 4.85) are inharmonic. The key is damped by hand when released.',
      mallet: 3000, rel: 0.1, restrike: 2, gain: 1.4, inharmonic: true, pair: 6,
      modes: f0 => {
        const T = clamp(4 * Math.pow(400 / f0, 0.5), 1.5, 7);
        return [{ r: 1, a: 1, t60: T }, { r: 2.65, a: 0.4, t60: T * 0.4 }, { r: 4.85, a: 0.15, t60: T * 0.2 }];
      },
      noise: { burst: -22, burstF: 2500, burstQ: 1, burstTau: 0.004 },
    };
    const kalimba = {
      kind: 'modal', group: 'World', label: 'Kalimba',
      about: 'Thumb piano: a steel tine clamped at one end, whose overtones are those of a cantilever (1 : 6.27 : 17.55), far from harmonic. They are faint and short-lived, so the tone is almost a pure, softly decaying fundamental with a bright click as the thumb slips off.',
      mallet: 4000, rel: 0.3, restrike: 1.8, gain: 1.6, inharmonic: true,
      modes: f0 => {
        const T = clamp(2.5 * Math.pow(330 / f0, 0.5), 0.8, 4);
        return [{ r: 1, a: 1, t60: T }, { r: 6.27, a: 0.25, t60: T * 0.12 }, { r: 17.55, a: 0.07, t60: T * 0.04 }];
      },
      noise: { burst: -24, burstF: 2500, burstQ: 1.2, burstTau: 0.003 },
    };
    const steelpan = {
      kind: 'modal', group: 'World', label: 'Steel pan',
      about: 'A note area of a Trinidadian pan is hammered so that its modes are 1 : 2 : 3. The note\'s quadratic nonlinearity pumps energy from the fundamental into the octave, which swells just after the strike (more so when struck harder). That swell is the pan\'s signature.',
      mallet: 2500, rel: 0.25, restrike: 1.6, gain: 1.6,
      modes: f0 => {
        const T = clamp(1.8 * Math.pow(330 / f0, 0.4), 0.8, 3);
        return [{ r: 1, a: 1, t60: T }, { r: 2, a: 0.08, t60: T * 0.25, drive: 1 }, { r: 3, a: 0.15, t60: T * 0.4 }];
      },
      noise: { burst: -26, burstF: 1800, burstQ: 1, burstTau: 0.003 },
    };

    const harp = {
      kind: 'string', group: 'Western', label: 'Harp',
      about: 'Gut and nylon strings plucked with the fingertips near the middle, which keeps the even harmonics weak and the tone round. A long, thin soundboard with dense modes (commuted). Chords are spread as arpeggios, and notes ring on after release.',
      t60: f0 => clamp(8 * Math.pow(110 / f0, 0.6), 1.5, 12), t60hi: 0.6,
      pluck: { pos: 0.45, soft: 0.55, noise: 0.03 },
      body: { direct: 0.6, peaks: [[150, 5, 0.8], [290, 6, 0.7], [520, 6, 0.5]], dense: { n: 30, lo: 400, hi: 4000, q: [10, 30], amp: 0.8 }, lp: 4500 },
      pol: { amt: 0.4, cents: 0.5, decay: 1.8 },
      restrike: 3.5, strum: 0.07, rel: 1.2, gain: 1,
    };
    const harpsichord = {
      kind: 'string', group: 'Western', label: 'Harpsichord',
      about: 'Thin brass and steel strings plucked by a quill close to the end of the string. The quill\'s sharp release excites dozens of harmonics, so the tone is bright and sustained. Every key has the same loudness: the instrument has no dynamics. Releasing a key drops the felt damper at once.',
      t60: f0 => clamp(9 * Math.pow(110 / f0, 0.5), 2, 14), t60hi: 2.5, noDyn: true,
      pluck: { pos: 0.12, soft: 0.02, noise: 0.08 },
      body: { direct: 0.7, peaks: [[180, 5, 0.6], [420, 6, 0.6], [1200, 4, 0.5], [3000, 3, 0.4]], dense: { n: 40, lo: 300, hi: 6000, q: [15, 40], amp: 0.8 } },
      pol: { amt: 0.35, cents: 0.4, decay: 1.5 },
      restrike: 3, strum: 0.01, rel: 0.12, gain: 0.85,
    };
    const mandolin = {
      kind: 'string', group: 'Western', label: 'Mandolin',
      about: 'Paired steel courses (two strings tuned about a cent apart, so every note beats gently), picked with a plectrum near the bridge, in a small, bright body. Short sustain: the light top soaks up the strings\' energy quickly.',
      t60: f0 => clamp(2.5 * Math.pow(196 / f0, 0.4), 0.8, 4), t60hi: 0.5,
      pluck: { pos: 0.13, soft: 0.12, noise: 0.08 },
      body: { direct: 0.7, peaks: [[250, 6, 0.8], [480, 8, 0.6], [900, 6, 0.4]], dense: { n: 30, lo: 600, hi: 6000, q: [12, 30], amp: 0.8 } },
      pol: { amt: 0.7, cents: 1.2, decay: 1.05 },
      restrike: 1.6, strum: 0.012, rel: 0.1, gain: 0.9,
    };
    const sarod = {
      kind: 'string', group: 'Indian', label: 'Sarod',
      about: 'Fretless steel strings over a polished metal fingerboard, struck near the bridge with a coconut-shell jawa. The goatskin belly gives vocal formants (≈ 0.4, 0.9, 1.8, 3 kHz). The flat bridge has no jawari, so the tone is clear and ringing. Fifteen sympathetic strings (here the taraf bank tuned to the scale) answer behind it.',
      t60: f0 => clamp(4 * Math.pow(110 / f0, 0.3), 1.5, 6), t60hi: 1.2,
      pluck: { pos: 0.1, soft: 0.08, noise: 0.06 },
      body: { direct: 0.55, peaks: [[420, 4, 0.8], [900, 3, 1], [1800, 3, 0.6], [3000, 3, 0.4]], dense: { n: 20, lo: 500, hi: 5000, q: [10, 25], amp: 0.5 } },
      pol: { amt: 0.4, cents: 0.5, decay: 1.6 },
      restrike: 2.5, rel: 0.25, symp: 0.7, gain: 0.9,
    };

    const INSTRUMENTS = {
      sine: pure('Sine (pure tone)', 'A single sinusoid — no overtones at all.', PURE.sine),
      saw: pure('Sawtooth (all harmonics, 1/n)', 'Every harmonic at 1/n — the idealised bowed / plucked string spectrum. Harmonics and inharmonicity are adjustable.', PURE.saw),
      square: pure('Square (odd harmonics, 1/n)', 'Odd harmonics only at 1/n — the idealised clarinet spectrum.', PURE.square),
      triangle: pure('Triangle (odd, 1/n²)', 'Odd harmonics falling at 1/n² — a soft, flute-like idealised tone.', PURE.triangle),
      piano, harpsichord, guitar, harp, mandolin, violin, cello, flute, clarinet, oboe, trumpet, organ,
      voice, voiceEe, voiceOo, humming,
      sitar, sarod, tanpura, veena, santoor, sarangi, bansuri, shehnai, harmonium, tabla,
      marimba, xylophone, vibraphone, glockenspiel, tubularBells, churchBell,
      steelpan, gangsa, singingBowl, kalimba,
    };

    /* ------------------------------------------------------ additive voice */
    class AddVoice {
      constructor(spec, f0, eng, opts) {
        this.spec = spec; this.eng = eng; this.sr = eng.sr;
        this.f0 = f0; this.target = f0;
        this.opts = opts || {};
        this.rng = new Rng((eng.rng.next() * 4294967296) >>> 0);
        this.t = 0; this.off = -1; this.relLevel = 1;
        this.vel = this.opts.vel != null ? this.opts.vel : eng.vel;
        this.velS = this.vel; this.strikeVel = this.vel;
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
              const rr = r * Math.pow(2, (c + jit) / 1200);
              comps.push({ r: rr, a: a / Math.sqrt(uni.length), n, lr: Math.log(rr) });
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

      strike() { this.t = 0; this.strikeVel = this.vel; this.trigger(); }

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

        // dynamics: struck notes keep the velocity they were struck with; sustained
        // notes follow changes smoothly (crescendo / diminuendo)
        this.velS += (this.vel - this.velS) * (1 - Math.exp(-dt / 0.08));
        const dv = (s.struck ? this.strikeVel : this.velS) - VEL0;
        const tilt = (s.pure ? 0 : s.bright != null ? s.bright : 1) * dv;
        const vlev = velGain(dv + VEL0, s.dynRange);

        // envelopes
        const t = this.t;
        let rel = 1;
        if (this.off >= 0) rel = Math.exp(-(t - this.off) / s.rel);
        const E1 = s.struck ? 1 : 1 - Math.exp(-t / s.att);
        const chiff = s.chiff ? s.chiff.gain * Math.exp(-t / s.chiff.tau) : 0;
        const comps = this.comps, ph = this.ph, prev = this.prev, nyq = sr * 0.45;
        let alive = this.off < 0 && !s.struck;
        const scale = s.gain * eng.voiceLevel * ampMod * rel * vlev;
        // shimmer: every partial's level wanders a little on its own (~8 Hz bandwidth),
        // the upper partials more, as in a real bowed, blown or sung tone
        const shK = s.shimmer && eng.vibrato ? s.shimmer / 8.686 / 0.25 : 0, shA = 1 - Math.exp(-dt * TAU * 8);

        for (let i = 0; i < comps.length; i++) {
          const c = comps[i], f = c.r * fmul;
          let g = 0;
          if (f < nyq) {
            g = c.a;
            if (tilt) g *= Math.exp(tilt * c.lr);
            if (shK) { c.sh = (c.sh || 0) + (this.rng.noise() * 1.7 - (c.sh || 0)) * shA; g *= Math.exp(shK * c.sh * Math.min(1, 0.4 + 0.15 * c.r)); }
            if (s.body) g *= lookup(s.body, f);
            if (s.struck) {
              const sig = s.sigma(f, this.f0);
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
          const lvl = s.gain * eng.voiceLevel * rel * vlev * (s.struck ? 1 : E1 * ampMod);
          const blvl = s.gain * eng.voiceLevel * rel * vlev * dB(12 * dv); // impacts grow faster than the tone
          if (z.harm.length && Math.abs(fmul / this.f0 - 1) > 0.002) for (const hz of z.harm) hz.f.set(hz.h * fmul, s.noise.harmQ, sr);
          const b = z.burst;
          // pitch-synchronous noise: bow slip, reed and glottal flow are turbulent only in
          // part of each cycle, so the noise comes in pulses at f0 and fuses with the tone
          const pm = s.noise.sync || 0, pinc = fmul / sr;
          let nph = this.nph || 0;
          for (let j = 0; j < n; j++) {
            let y = 0;
            if (z.hiss) {
              let hs = z.hiss.g * z.hiss.f.bp(this.rng.noise());
              if (pm) {
                const q = 0.5 + 0.5 * SIN[((nph + 0.25) % 1 * TBL) | 0], q2 = q * q;
                hs *= 1 - pm + pm * q2 * q2 / 0.2734;
                nph += pinc; if (nph >= 1) nph -= 1;
              }
              y += hs;
            }
            for (const hz of z.harm) y += hz.gg * hz.f.bp(this.rng.noise());
            y *= lvl;
            if (b && b.env > 1e-4) { y += b.g * b.env * b.f.bp(this.rng.noise()) * blvl; b.env *= b.k; }
            out[j] += y;
          }
          this.nph = nph;
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

    /**
     * Body impulse response for commuted synthesis (Smith 1993; Karjalainen &
     * Välimäki 1993). String and body are both linear, so their order can be swapped:
     * rather than filtering the string through the body, the string is excited with
     * the body's impulse response. That lets the body have dozens of modes for the
     * price of reading a table. The response is the direct path plus the main
     * air / plate resonances of `body.peaks` and a dense, irregular set of higher
     * plate modes (`body.dense`), each a unity-peak band-pass like the SVFs it replaces.
     */
    function bodyIR(b, sr, seed) {
      const r = new Rng(seed), modes = b.peaks.map(([f, Q, g]) => [f, Q, g]);
      const d = b.dense;
      if (d) for (let i = 0; i < d.n; i++) {
        const f = d.lo * Math.pow(d.hi / d.lo, (i + r.next()) / d.n);
        modes.push([f, d.q[0] + r.next() * (d.q[1] - d.q[0]), d.amp * (0.3 + 0.7 * r.next()) * Math.pow(d.lo / f, 0.3) * (r.next() < 0.5 ? -1 : 1)]);
      }
      let len = 16;
      for (const [f, Q] of modes) len = Math.max(len, Math.ceil(6.9 * 2 * Q / (TAU * f) * sr));
      len = Math.min(len, Math.round(0.4 * sr));
      const h = new Float32Array(len);
      h[0] = b.direct;
      for (const [f, Q, g] of modes) {
        if (f > sr * 0.45) continue;
        const w = TAU * f / sr, k = Math.exp(-w / (2 * Q)), amp = g * w / Q;
        // e^{-ωt/2Q} cos ωt by a rotating phasor
        const c = Math.cos(w) * k, sn = Math.sin(w) * k;
        let x = amp, y = 0;
        for (let t = 0; t < len; t++) { h[t] += x; const nx = x * c - y * sn; y = x * sn + y * c; x = nx; }
      }
      return h;
    }

    /** One polarisation of the string: delay loop, loss filter and its state. */
    class Loop {
      constructor(f0, t60, t60hi, sr) { this.buf = new Float32Array(8192); this.lp = 0; this.yb = 0; this.set(f0, t60, t60hi, sr); this.D = this.L.D; }
      set(f0, t60, t60hi, sr) { this.L = stringLoop(f0, t60, t60hi, sr); }
    }

    class StringVoice {
      constructor(spec, f0, eng, silent) {
        this.spec = spec; this.eng = eng; this.sr = eng.sr;
        this.mask = 8191; this.w = 0;
        this.rng = new Rng((eng.rng.next() * 4294967296) >>> 0);
        this.f0 = f0;
        // two polarisations: the one across the soundboard drives the bridge hard and
        // decays fast; the one parallel to it is a fraction of a cent sharper and rings
        // on. Their sum gives the two-stage decay and slow beating of real plucked strings.
        const pol = spec.pol;
        this.loops = [new Loop(f0, spec.t60(f0), spec.t60hi, this.sr)];
        if (pol) this.loops.push(new Loop(f0 * Math.pow(2, pol.cents / 1200), spec.t60(f0) * pol.decay, spec.t60hi * pol.decay, this.sr));
        this.split = pol ? [Math.sqrt(1 - pol.amt * pol.amt), pol.amt] : [1];
        this.off = -1; this.t = 0; this.relEnv = 1; this.pending = -1;
        this.vel = eng.vel;
        this.ir = eng.bodyIR(spec);
        this.ex = null;
        this.tone = spec.body.lp ? Math.exp(-TAU * spec.body.lp / this.sr) : 0; this.toneZ = 0;
        // bridge-force output: the loop carries displacement, but what drives the body
        // is the force on the bridge, ∝ the string's slope there: a +6 dB/oct tilt
        // (1 − r z⁻¹)/(1 − p z⁻¹) that levels off where the pole p takes over, normalised
        // to unity at f0 so the fundamental keeps its level
        const fo = spec.force;
        this.fr = fo ? fo.r : 0; this.fpole = fo ? fo.p : 0; this.fp = 0; this.fy = 0; this.setForce();
        // ...and through the body, which smears the sharp pulses the jawari makes at the
        // bridge over a few ms (all-pass sections at the body modes: phase only, so the
        // spectrum and pitch are untouched while the crest factor drops by ~6 dB)
        this.ap = fo && fo.disperse ? fo.disperse.map(([fc, Q]) => {
          const w = TAU * fc / this.sr, al = Math.sin(w) / (2 * Q);
          return { b0: (1 - al) / (1 + al), b1: -2 * Math.cos(w) / (1 + al), x1: 0, x2: 0, y1: 0, y2: 0 };
        }) : null;
        // ...and the body's own colour on what the jawari adds (peaking sections, RBJ):
        // the commuted body only shapes the pluck, not the harmonics the bridge makes later
        this.eq = fo && fo.eq ? fo.eq.map(([fc, Q, db]) => {
          const A = Math.pow(10, db / 40), w = TAU * fc / this.sr, al = Math.sin(w) / (2 * Q), a0 = 1 + al / A;
          return { b0: (1 + al * A) / a0, b1: -2 * Math.cos(w) / a0, b2: (1 - al * A) / a0, a2: (1 - al / A) / a0, x1: 0, x2: 0, y1: 0, y2: 0 };
        }) : null;
        if (!silent) this.strike();
      }

      /**
       * Pluck. The excitation is the pluck shape convolved with the body response, fed
       * into the loop over time. The shape (a triangle peaking at the pluck point,
       * zero mean) has a second derivative of three impulses plus a step pair, so the
       * convolution is three or five taps into the body table, integrated twice: O(1)
       * per sample however long the body rings.
       */
      strike(delay = 0) {
        if (delay > 0) { this.pending = delay; return; }
        const p = this.spec.pluck, N = Math.round(this.loops[0].L.P), sr = this.sr;
        // a harder pluck: larger displacement, narrower contact (brighter), more noise
        // (the contact smoothing's corner moves ~2 octaves either way from mf)
        const vel = this.spec.noDyn ? VEL0 : this.vel; // a harpsichord's quill plucks the same at any touch
        const A = velGain(vel);
        const fc = -Math.log(Math.max(p.soft * 0.9, 0.02)) * sr / TAU * Math.pow(2, 5 * (vel - VEL0));
        const k = Math.max(1, Math.round(p.pos * N));
        // triangle (peak A at k, zero at 0 and N) minus its mean A/2
        const a1 = A / k, a2 = A / (N - k);
        this.ex = {
          n: 0, len: N + this.ir.length + 64, N,
          taps2: [[0, a1], [k, -(a1 + a2)], [N, a2]], // into the double integrator
          taps1: [[0, -A / 2], [N, A / 2]],          // into the single integrator (mean)
          i1: 0, i2: 0, s: Math.exp(-TAU * Math.min(fc, sr * 0.45) / sr), z: [0, 0, 0, 0],
          nz: A * p.noise * (0.5 + 0.7 * vel),
        };
        // damp what is still ringing
        for (const lp of this.loops) for (let i = 1; i <= N + 4; i++) lp.buf[(this.w - i) & this.mask] *= 0.3;
        this.t = 0;
      }

      /** Next excitation sample. */
      exNext() {
        const e = this.ex, ir = this.ir, L = ir.length, n = e.n;
        let a = 0, b = 0;
        for (const [d, wgt] of e.taps2) { const m = n - d; if (m >= 0 && m < L) a += wgt * ir[m]; }
        for (const [d, wgt] of e.taps1) { const m = n - d; if (m >= 0 && m < L) b += wgt * ir[m]; }
        e.i1 += a; e.i2 += e.i1 + b;
        let x = e.i2 + (n < e.N ? e.nz * this.rng.noise() : 0);
        // finger / plectrum width: four one-pole stages (as the forward-backward pair did)
        const s = e.s, z = e.z;
        for (let q = 0; q < 4; q++) { z[q] = s * z[q] + (1 - s) * x; x = z[q]; }
        if (++e.n >= e.len) this.ex = null;
        return x;
      }

      setForce() {
        const r = this.fr, p = this.fpole, w = TAU * this.f0 / this.sr;
        this.fk = r ? Math.sqrt((1 - 2 * p * Math.cos(w) + p * p) / (1 - 2 * r * Math.cos(w) + r * r)) : 1;
      }

      setFreq(f) {
        this.f0 = f; this.setForce();
        const s = this.spec, pol = s.pol;
        this.loops[0].set(f, s.t60(f), s.t60hi, this.sr);
        if (pol) this.loops[1].set(f * Math.pow(2, pol.cents / 1200), s.t60(f) * pol.decay, s.t60hi * pol.decay, this.sr);
      }

      release() { if (this.off < 0) this.off = this.t; }

      render(out, n) {
        const s = this.spec, sr = this.sr, mask = this.mask;
        if (this.pending >= 0) { this.pending -= n / sr; if (this.pending < 0) { this.pending = -1; this.strike(); } }
        if (!this.xb || this.xb.length < n) this.xb = new Float32Array(Math.max(n, 128));
        const xb = this.xb;
        if (this.ex) for (let j = 0; j < n; j++) xb[j] = this.ex ? this.exNext() : 0;
        else xb.fill(0, 0, n);
        const acc = this.tmp && this.tmp.length >= n ? this.tmp : (this.tmp = new Float32Array(Math.max(n, 128)));
        acc.fill(0, 0, n);
        let e = 0;
        const w0 = this.w;
        for (let li = 0; li < this.loops.length; li++) {
          const lo = this.loops[li], L = lo.L, buf = lo.buf, c = this.split[li];
          const a = L.a, g = L.g, J = (s.jaw || 0) * L.P;
          const D0 = lo.D, dD = (L.D - D0) / n;
          let w = w0, lp = lo.lp, yb = lo.yb, D = D0;
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
            const y = g * lp + c * xb[j];
            buf[w] = y; w = (w + 1) & mask;
            yb = y;
            acc[j] += y;
            e += y * y;
          }
          lo.lp = lp; lo.yb = yb; lo.D = L.D;
        }
        this.w = (w0 + n) & mask;
        const gain = s.gain * this.eng.voiceLevel * 5;
        const relK = this.off >= 0 ? Math.exp(-1 / (s.rel * sr)) : 1;
        let env = this.relEnv, tz = this.toneZ, hx = this.hx || 0, hy = this.hy || 0, fp = this.fp, fy = this.fy;
        const fr = this.fr, fk = this.fk, fpo = this.fpole, ap = this.ap, eq = this.eq;
        const R = 1 - TAU * 15 / sr; // DC blocker: the jawari's one-sided contact rectifies
        for (let j = 0; j < n; j++) {
          let o = acc[j];
          hy = o - hx + R * hy; hx = o; o = hy;
          if (fr) {
            const v = o; o = fy = (o - fr * fp) * fk + fpo * fy; fp = v;
            if (ap) for (const q of ap) { const r = q.b0 * o + q.b1 * q.x1 + q.x2 - q.b1 * q.y1 - q.b0 * q.y2; q.x2 = q.x1; q.x1 = o; q.y2 = q.y1; q.y1 = r; o = r; }
            if (eq) for (const q of eq) { const r = q.b0 * o + q.b1 * q.x1 + q.b2 * q.x2 - q.b1 * q.y1 - q.a2 * q.y2; q.x2 = q.x1; q.x1 = o; q.y2 = q.y1; q.y1 = r; o = r; }
          }
          if (this.tone) { tz = this.tone * tz + (1 - this.tone) * o; o = tz; }
          out[j] += o * gain * env;
          env *= relK;
        }
        this.relEnv = env; this.toneZ = tz; this.hx = hx; this.hy = hy; this.fp = fp; this.fy = fy;
        this.t += n / sr;
        if (this.off >= 0 && env < 1e-4) return false;
        if (e / n < 1e-12 && this.t > 0.1 && this.pending < 0 && !this.ex) return this.off < 0 ? 'silent' : false;
        return true;
      }
    }

    /* ---------------------------------------------------------- modal voice */
    class ModalVoice {
      constructor(spec, f0, eng, opts) {
        this.spec = spec; this.eng = eng; this.sr = eng.sr;
        this.rng = new Rng((eng.rng.next() * 4294967296) >>> 0);
        this.vel = opts && opts.vel != null ? opts.vel : eng.vel;
        this.f0 = f0; this.target = f0; this.coefF = 0;
        this.t = 0; this.off = -1; this.relEnv = 1; this.pending = -1;
        this.bol = 0; this.tg = [0, 0]; this.gm = [1, 1]; // stroke counter, time since each group was struck, bend
        this.tremPh = this.rng.next();
        const sr = this.sr, ms = [];
        // expand doublets (split) and the paired instrument (pair, Hz at the fundamental)
        for (const m of spec.modes(f0)) {
          const offs = [];
          // (the reference mode stays single, so the pitch it carries reads exactly)
          const split = m.r === (spec.ref || 1) ? 0 : m.split;
          for (const sp of split ? [-0.5, 0.5] : [0]) {
            const o = (split || 0) * sp * (1 + 0.3 * (this.rng.next() - 0.5));
            offs.push(o);
            if (spec.pair) offs.push(o + spec.pair * m.r);
          }
          for (const o of offs) {
            if (m.r * f0 + o > sr * 0.45) continue;
            ms.push({ r: m.r, o, a: m.a / Math.sqrt(offs.length), t60: m.t60, rho: Math.pow(10, -3 / (m.t60 * sr)), trem: !!m.trem, drive: m.drive || 0, h: m.h || 0, grp: m.grp || 0 });
          }
        }
        this.m = ms;
        const N = ms.length;
        this.re = new Float64Array(N); this.im = new Float64Array(N);
        this.cr = new Float64Array(N); this.ci = new Float64Array(N);
        this.w = new Float32Array(N).fill(1);
        // unit rms at mf, so dynamics change level and colour from a calibrated point
        let e = 0;
        for (const q of ms) { const g = q.a * this.mallet(q.r * f0, VEL0); e += g * g / 2; }
        this.norm = 1 / Math.sqrt(e || 1);
        // quadratic coupling gain: steady driven amplitude ≈ drive × mode-0 amplitude at mf
        const a0 = ms.length ? ms[0].a * this.mallet(f0, VEL0) * this.norm : 1;
        for (const q of ms) if (q.drive) q.k = 2 * q.drive * (1 - q.rho) / a0;
        this.acc = new Float32Array(128); this.src = new Float32Array(128);
        const nz = spec.noise;
        this.burst = nz && nz.burst != null ? { f: new SVF().set(nz.burstF, nz.burstQ, sr), g: noiseGain(dB(nz.burst), nz.burstF, nz.burstQ, sr), env: 0, k: Math.exp(-1 / (nz.burstTau * sr)), lvl: 1 } : null;
        this.coeffs();
        this.strike();
      }

      /** Mallet contact low-pass: a harder strike is shorter, so its corner rises. */
      mallet(f, vel) {
        const fc = this.spec.mallet * Math.pow(2, 2.5 * (vel - VEL0)), x = f / fc;
        return 1 / Math.sqrt(1 + x * x * x * x);
      }

      coeffs() {
        const sr = this.sr, f0 = this.f0, gm = this.gm;
        for (let i = 0; i < this.m.length; i++) {
          const q = this.m[i], w = TAU * (q.r * f0 * gm[q.grp] + q.o) / sr;
          this.cr[i] = q.rho * Math.cos(w); this.ci[i] = q.rho * Math.sin(w);
        }
        this.coefF = f0;
      }

      strike(delay = 0) {
        if (delay > 0) { this.pending = delay; return; }
        const s = this.spec, v = this.vel, A = velGain(v) * this.norm, damp = 0.5;
        // a bol: which dayan stroke, and whether the bayan is struck too
        let st = null, ge = 1;
        if (s.pattern) { const b = s.bols[s.pattern[this.bol++ % s.pattern.length]]; st = s.strokes[b[0]]; ge = b[1]; }
        for (let i = 0; i < this.m.length; i++) {
          const q = this.m[i];
          if (q.grp && !ge) continue; // the bayan keeps ringing
          const am = st && !q.grp ? st.amp(q.h) : 1, dm = st && !q.grp ? st.decay(q.h) : 1;
          q.rho = Math.pow(10, -3 / (q.t60 * dm * this.sr));
          // the mallet (or hand) partly damps what is still ringing, then adds the new impulse
          this.re[i] = this.re[i] * damp + q.a * am * this.mallet(q.r * this.f0, v) * A;
          this.im[i] *= damp;
        }
        this.tg[0] = 0; if (ge) this.tg[1] = 0;
        this.coefF = 0;
        if (this.burst) { this.burst.env = 1; this.burst.lvl = velGain(v) * dB(12 * (v - VEL0) + (st ? st.slap : 0)); }
        this.t = 0;
      }

      setFreq(f) { this.target = f; }

      release() { if (this.off < 0) this.off = this.t; }

      render(out, n) {
        const s = this.spec, sr = this.sr, dt = n / sr, eng = this.eng;
        if (this.pending >= 0) { this.pending -= dt; if (this.pending < 0) { this.pending = -1; this.strike(); } }
        this.f0 += (this.target - this.f0) * (1 - Math.exp(-dt / 0.015));
        let bending = false;
        if (s.bend) for (let g = 0; g < 2; g++) {
          const c = s.bend[g].cents * Math.exp(-this.tg[g] / s.bend[g].tau);
          this.gm[g] = Math.pow(2, c / 1200); this.tg[g] += dt;
          if (Math.abs(c) > 0.01) bending = true;
        }
        if (bending || Math.abs(this.f0 / this.coefF - 1) > 1e-7) this.coeffs();
        if (this.acc.length < n) { this.acc = new Float32Array(n); this.src = new Float32Array(n); }
        const acc = this.acc, src = this.src, M = this.m, re = this.re, im = this.im, cr = this.cr, ci = this.ci, W = this.w;
        acc.fill(0, 0, n);
        // vibraphone motor: the resonator discs modulate the modes they cover
        let tw = 1;
        if (s.trem && eng.vibrato) {
          this.tremPh += s.trem.rate * dt; this.tremPh -= Math.floor(this.tremPh);
          tw = 1 - s.trem.depth * (0.5 - 0.5 * Math.cos(TAU * this.tremPh));
        }
        let e = 0;
        for (let i = 0; i < M.length; i++) {
          const q = M[i], c = cr[i], sn = ci[i], k = q.k || 0;
          let x = re[i], y = im[i];
          const w1 = q.trem ? tw : 1, w0 = W[i], dw = (w1 - w0) / n;
          let w = w0;
          for (let j = 0; j < n; j++) {
            const nx = x * c - y * sn;
            y = x * sn + y * c; x = nx;
            if (k) x += k * src[j] * src[j];
            w += dw;
            acc[j] += y * w;
            if (i === 0) src[j] = y;
          }
          re[i] = x; im[i] = y; W[i] = w1;
          e += x * x + y * y;
        }
        const gain = s.gain * eng.voiceLevel;
        const relK = this.off >= 0 ? Math.exp(-1 / (s.rel * sr)) : 1;
        let env = this.relEnv;
        const b = this.burst;
        for (let j = 0; j < n; j++) {
          let o = acc[j];
          if (b && b.env > 1e-4) { o += b.g * b.lvl * b.env * b.f.bp(this.rng.noise()); b.env *= b.k; }
          out[j] += o * gain * env;
          env *= relK;
        }
        this.relEnv = env;
        this.t += dt;
        if (this.off >= 0 && env < 1e-4) return false;
        if (e < 1e-12 && !(b && b.env > 1e-4) && this.t > 0.1 && this.pending < 0) return this.off < 0 ? 'silent' : false;
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
        this.vel = VEL0;
        this.order = 0;
        this.symp = new SympBank(sr);
        this.sympIn = new Float32Array(128);
        this.limG = 1;
        this.time = 0;
        this.beatNext = 0;
        this.cycleNext = 0; this.cycleLast = 0;
        this.tmp = new Float32Array(128);
        this.irs = new Map();
      }

      /** Body response of a string instrument, built once per engine. */
      bodyIR(spec) {
        if (!this.irs.has(spec)) this.irs.set(spec, bodyIR(spec.body, this.sr, 0x5eed ^ spec.label.length * 7919));
        return this.irs.get(spec);
      }

      handle(m) {
        switch (m.t) {
          case 'on': this.noteOn(m.id, m.freq, m.inst, m); break;
          case 'off': this.noteOff(m.id); break;
          case 'freq': this.setFreq(m.id, m.freq); break;
          case 'allOff': for (const id of [...this.voices.keys()]) this.noteOff(id); break;
          case 'opts':
            if ('vibrato' in m) this.vibrato = m.vibrato;
            if ('restrike' in m) this.restrike = m.restrike;
            if ('vel' in m) { this.vel = clamp(m.vel, 0, 1); for (const r of this.voices.values()) if (!r.released) r.v.vel = this.vel; }
            break;
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
        const v = spec.kind === 'string' ? new StringVoice(spec, freq, this, queued)
          : spec.kind === 'modal' ? new ModalVoice(spec, freq, this, opts) : new AddVoice(spec, freq, this, opts);
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
      META[k] = { label: s.label, group: s.group, about: s.about, pure: !!s.pure, decays: !!(s.struck || s.kind === 'string' || s.kind === 'modal'), vibrato: !!(s.trem || s.vib && (s.vib.depth || s.vib.amp || s.vib.drift)), symp: !!s.symp, inharmonic: !!s.inharmonic, ref: s.ref || 1, pattern: !!s.pattern };
    }
    return { Engine, INSTRUMENTS: META, _specs: INSTRUMENTS, stringLoop };
  }

  const api = factory();
  api.factory = factory;
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.HSynth = api;
})(typeof self !== 'undefined' ? self : this);
