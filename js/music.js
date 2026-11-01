/*
 * music.js — pitch naming, tuning systems, Hindustani sargam, interval names.
 * Pure functions; browser (window.HMusic) + Node (module.exports).
 */
(function (root, factory) {
  const mod = factory();
  if (typeof module === 'object' && module.exports) module.exports = mod;
  else root.HMusic = mod;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SHARP_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
  const FLAT_NAMES = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'G♭', 'G', 'A♭', 'A', 'B♭', 'B'];

  const log2 = Math.log2;
  const cents = r => 1200 * log2(r);

  /* ------------------------------------------------------------- Sargam */
  // The 12 svaras of the Hindustani chromatic scale (Bhatkhande convention):
  // komal (flat) svaras are written underlined, tivra Ma with a mark above.
  const SVARAS = [
    { latin: 'Sa', deva: 'सा', komal: false, tivra: false, full: 'Shadja (Sa)' },
    { latin: 'Re', deva: 'रे', komal: true, tivra: false, full: 'Komal Re' },
    { latin: 'Re', deva: 'रे', komal: false, tivra: false, full: 'Shuddha Re' },
    { latin: 'Ga', deva: 'ग', komal: true, tivra: false, full: 'Komal Ga' },
    { latin: 'Ga', deva: 'ग', komal: false, tivra: false, full: 'Shuddha Ga' },
    { latin: 'Ma', deva: 'म', komal: false, tivra: false, full: 'Shuddha Ma' },
    { latin: 'Ma', deva: 'म', komal: false, tivra: true, full: 'Tivra Ma' },
    { latin: 'Pa', deva: 'प', komal: false, tivra: false, full: 'Pancham (Pa)' },
    { latin: 'Dha', deva: 'ध', komal: true, tivra: false, full: 'Komal Dha' },
    { latin: 'Dha', deva: 'ध', komal: false, tivra: false, full: 'Shuddha Dha' },
    { latin: 'Ni', deva: 'नि', komal: true, tivra: false, full: 'Komal Ni' },
    { latin: 'Ni', deva: 'नि', komal: false, tivra: false, full: 'Shuddha Ni' },
  ];

  /** Plain-text form, e.g. "re(k)", "Ma(t)", with octave marks "." (mandra) / "'" (taar). */
  function svaraText(idx, octave = 0, script = 'latin') {
    const s = SVARAS[idx];
    let t = script === 'deva' ? s.deva : s.latin;
    if (s.komal) t += script === 'deva' ? '॒' : '(k)';
    if (s.tivra) t += script === 'deva' ? 'ॕ' : '(t)';
    if (octave < 0) t = '.'.repeat(-octave) + t;
    if (octave > 0) t = t + "'".repeat(octave);
    return t;
  }

  /** Name of chromatic step `step` above tonic `tonicPc`, spelled with flats or sharps. */
  function degreeNoteName(tonicPc, step, flats) {
    const pc = (tonicPc + ((step % 12) + 12) % 12) % 12;
    return (flats ? FLAT_NAMES : SHARP_NAMES)[pc];
  }

  /* ------------------------------------------------------------ Tunings */
  // Each tuning: 12 chromatic degrees relative to the tonic (Sa), as ratios where
  // meaningful, otherwise cents. `fixedRoot` = the temperament is defined on C
  // regardless of the chosen key (historical well-temperaments).
  const R = (n, d) => ({ ratio: [n, d], cents: cents(n / d) });
  const C = c => ({ ratio: null, cents: c });

  const TUNINGS = {
    et: {
      name: '12-tone Equal Temperament',
      short: '12-TET',
      about: 'Every semitone is exactly 2^(1/12) (100 cents). All keys sound the same; only octaves are acoustically pure. Major thirds are 13.7¢ wider than the 5th/4th harmonic relation, so they beat.',
      degrees: Array.from({ length: 12 }, (_, i) => C(i * 100)),
    },
    just: {
      name: 'Just Intonation (5-limit)',
      short: 'Just',
      about: 'Intervals are small whole-number ratios taken from the harmonic series (3/2, 5/4, 6/5…). Chords on the tonic are beat-free, but the tuning is tied to one key.',
      degrees: [R(1, 1), R(16, 15), R(9, 8), R(6, 5), R(5, 4), R(4, 3), R(45, 32), R(3, 2), R(8, 5), R(5, 3), R(16, 9), R(15, 8)],
    },
    pythagorean: {
      name: 'Pythagorean',
      short: 'Pythag.',
      about: 'Built only from pure fifths (3/2) and octaves. Fifths and fourths are pure; major thirds (81/64) are 21.5¢ sharp of 5/4 — bright and tense.',
      degrees: [R(1, 1), R(256, 243), R(9, 8), R(32, 27), R(81, 64), R(4, 3), R(729, 512), R(3, 2), R(128, 81), R(27, 16), R(16, 9), R(243, 128)],
    },
    meantone: {
      name: 'Quarter-comma Meantone',
      short: '¼-comma',
      about: 'Fifths are narrowed by ¼ of the syntonic comma so that major thirds are pure 5/4. Sweet in nearby keys; the leftover "wolf" fifth (G♯–E♭) is badly out.',
      // fifths of 696.578¢ stacked from E♭ to G♯ relative to the tonic
      degrees: [0, 76.049, 193.157, 310.265, 386.314, 503.422, 579.471, 696.578, 772.627, 889.735, 1006.843, 1082.892].map(C),
    },
    werckmeister: {
      name: 'Werckmeister III (on C)',
      short: 'Werck. III',
      about: 'A 1691 well-temperament: four fifths (C–G–D–A and B–F♯) narrowed by ¼ Pythagorean comma, the rest pure. Every key is usable but each has its own colour. Fixed to C.',
      degrees: [0, 90.225, 192.18, 294.135, 390.225, 498.045, 588.27, 696.09, 792.18, 888.27, 996.09, 1092.18].map(C),
      fixedRoot: 0,
    },
    septimal: {
      name: 'Harmonic / Septimal (7-limit)',
      short: '7-limit',
      about: 'Like 5-limit just intonation but uses the 7th harmonic for the minor seventh (7/4, 31¢ flat of ET) and 7/6 for the minor third: the "barbershop" seventh.',
      degrees: [R(1, 1), R(16, 15), R(9, 8), R(7, 6), R(5, 4), R(4, 3), R(7, 5), R(3, 2), R(8, 5), R(5, 3), R(7, 4), R(15, 8)],
    },
  };

  // 22 shrutis — the classical Indian microtonal grid (one common modern assignment).
  const SHRUTIS = [
    [1, 1, 0, 'Sa'], [256, 243, 1, 'ati-komal'], [16, 15, 1, 'komal'], [10, 9, 2, 'shuddha (low)'], [9, 8, 2, 'shuddha'],
    [32, 27, 3, 'ati-komal'], [6, 5, 3, 'komal'], [5, 4, 4, 'shuddha'], [81, 64, 4, 'tivra'],
    [4, 3, 5, 'shuddha'], [27, 20, 5, 'ekashruti'], [45, 32, 6, 'tivra'], [729, 512, 6, 'tivratar'],
    [3, 2, 7, 'Pa'], [128, 81, 8, 'ati-komal'], [8, 5, 8, 'komal'], [5, 3, 9, 'shuddha (low)'], [27, 16, 9, 'shuddha'],
    [16, 9, 10, 'ati-komal'], [9, 5, 10, 'komal'], [15, 8, 11, 'shuddha'], [243, 128, 11, 'tivra'],
  ].map(([n, d, svara, quality], i) => ({ index: i + 1, ratio: [n, d], cents: cents(n / d), svara, quality }));

  /* ------------------------------------------------------- Pitch naming */
  class PitchSpace {
    /**
     * a4: reference A4 in Hz. tonicPc: tonic pitch class (0 = C). tuning: key of TUNINGS.
     * tonicOffsetCents: fine adjustment of Sa against its ET position.
     */
    constructor({ a4 = 440, tonicPc = 0, tuning = 'et', tonicOffsetCents = 0, flats = false, script = 'latin' } = {}) {
      Object.assign(this, { a4, tonicPc, tuning, tonicOffsetCents, flats, script });
    }

    midi(f) { return 69 + 12 * log2(f / this.a4); }
    freqOfMidi(m) { return this.a4 * Math.pow(2, (m - 69) / 12); }

    /** Nearest 12-TET note: {name, octave, midi, cents, label} */
    etNote(f) {
      const m = this.midi(f);
      const n = Math.round(m);
      const pc = ((n % 12) + 12) % 12;
      const name = (this.flats ? FLAT_NAMES : SHARP_NAMES)[pc];
      const octave = Math.floor(n / 12) - 1;
      return { name, octave, midi: n, pc, cents: (m - n) * 100, label: name + octave };
    }

    /** Frequency of the tonic (Sa) in octave 4 (e.g. C4) — the madhya saptak Sa. */
    tonicFreq() {
      const tuning = TUNINGS[this.tuning];
      const pc = tuning.fixedRoot !== undefined ? tuning.fixedRoot : this.tonicPc;
      return this.a4 * Math.pow(2, (pc - 9) / 12) * Math.pow(2, this.tonicOffsetCents / 1200);
    }

    /** Degrees of the active tuning relative to the *chosen* tonic (handles fixed-root temperaments). */
    activeDegrees() {
      const t = TUNINGS[this.tuning];
      if (t.fixedRoot === undefined) return t.degrees.map((d, i) => ({ ...d, step: i }));
      // Rotate a C-based temperament so that degree 0 corresponds to the chosen tonic.
      const rot = ((this.tonicPc - t.fixedRoot) % 12 + 12) % 12;
      const base = t.degrees[rot].cents;
      return Array.from({ length: 12 }, (_, i) => {
        const d = t.degrees[(i + rot) % 12];
        let c = d.cents - base; if (c < 0) c += 1200;
        return { ratio: null, cents: c, step: i };
      });
    }

    /** Frequency of the chromatic step `step` (0..11, may exceed) in saptak `octave` (0 = madhya). */
    degreeFreq(step, octave = 0) {
      const deg = this.activeDegrees();
      const o = Math.floor(step / 12), s = ((step % 12) + 12) % 12;
      // Sa of the chosen key, as placed by the tuning (matters for fixed-root temperaments)
      const sa = this.saFreq();
      return sa * Math.pow(2, (deg[s].cents + 1200 * (octave + o)) / 1200);
    }

    /** Sa as positioned by the current tuning (for fixed-root tunings Sa = tuned degree of tonic). */
    saFreq() {
      const t = TUNINGS[this.tuning];
      if (t.fixedRoot === undefined) return this.tonicFreq();
      const rot = ((this.tonicPc - t.fixedRoot) % 12 + 12) % 12;
      const rootFreq = this.a4 * Math.pow(2, (t.fixedRoot - 9) / 12);
      // Werckmeister etc. are anchored so that A stays at a4: shift by A's offset from ET
      const aOff = t.degrees[9 - t.fixedRoot].cents - (9 - t.fixedRoot) * 100;
      let f = rootFreq * Math.pow(2, (t.degrees[rot].cents - aOff) / 1200);
      if (this.tonicPc < t.fixedRoot) f *= 2;
      return f * Math.pow(2, this.tonicOffsetCents / 1200);
    }

    /**
     * Describe f relative to the tonic in the active tuning:
     * {step, octave (saptak; 0 = middle), cents (deviation from tuned degree), svara (text),
     *  degreeCents, ratio}
     */
    tuned(f) {
      const sa = this.saFreq();
      const c = 1200 * log2(f / sa);
      const deg = this.activeDegrees();
      let oct = Math.floor(c / 1200);
      const within = c - oct * 1200;
      let best = 0, bestDev = Infinity;
      for (let i = 0; i <= 12; i++) {
        const dc = i === 12 ? 1200 : deg[i].cents;
        const dev = within - dc;
        if (Math.abs(dev) < Math.abs(bestDev)) { bestDev = dev; best = i; }
      }
      if (best === 12) { best = 0; oct += 1; }
      const d = deg[best];
      return {
        step: best, octave: oct, cents: bestDev, degreeCents: d.cents, ratio: d.ratio,
        svara: SVARAS[best], text: svaraText(best, oct, this.script),
        westernDegree: degreeNoteName(this.tonicPc, best, this.flats),
      };
    }

    /**
     * Name f by the active tuning: note name/octave of the nearest tuned degree and the
     * deviation in cents from it (for 12-TET this is the ordinary tuner reading).
     */
    label(f) {
      const t = this.tuned(f);
      const dn = this.etNote(this.degreeFreq(t.step, t.octave));
      return { name: dn.name, octave: dn.octave, label: dn.name + dn.octave, cents: t.cents, tuned: t };
    }

    /** Nearest of the 22 shrutis */
    shruti(f) {
      const c = 1200 * log2(f / this.saFreq());
      const within = ((c % 1200) + 1200) % 1200;
      let best = SHRUTIS[0], dev = within;
      for (const s of SHRUTIS.concat([{ ...SHRUTIS[0], cents: 1200 }])) {
        if (Math.abs(within - s.cents) < Math.abs(dev)) { best = s; dev = within - s.cents; }
      }
      return { shruti: best, cents: dev };
    }
  }

  /* ------------------------------------------------------ Interval names */
  // Simple-ratio intervals from the harmonic series (used to label harmonics and
  // the interval between detected notes).
  const JUST_INTERVALS = [
    [1, 1, 'Unison'], [16, 15, 'Minor 2nd'], [9, 8, 'Major 2nd'], [7, 6, 'Septimal min 3rd'], [6, 5, 'Minor 3rd'],
    [5, 4, 'Major 3rd'], [4, 3, 'Perfect 4th'], [7, 5, 'Septimal tritone'], [45, 32, 'Tritone'], [3, 2, 'Perfect 5th'],
    [8, 5, 'Minor 6th'], [5, 3, 'Major 6th'], [7, 4, 'Harmonic 7th'], [16, 9, 'Minor 7th'], [9, 5, 'Minor 7th (5-lim)'],
    [15, 8, 'Major 7th'], [2, 1, 'Octave'],
  ].map(([n, d, name]) => ({ n, d, name, cents: cents(n / d) }));

  const ET_INTERVAL_NAMES = ['Unison', 'Minor 2nd', 'Major 2nd', 'Minor 3rd', 'Major 3rd', 'Perfect 4th', 'Tritone',
    'Perfect 5th', 'Minor 6th', 'Major 6th', 'Minor 7th', 'Major 7th'];
  const COMPOUND_NAMES = ['Octave', 'Minor 9th', 'Major 9th', 'Minor 10th', 'Major 10th', 'Perfect 11th', 'Augmented 11th',
    'Perfect 12th', 'Minor 13th', 'Major 13th', 'Minor 14th', 'Major 14th'];

  function intervalName(semis) {
    const s = ((semis % 12) + 12) % 12, o = Math.floor(semis / 12);
    if (o === 0) return ET_INTERVAL_NAMES[s];
    if (o === 1) return COMPOUND_NAMES[s];
    if (s === 0) return `${o} octaves`;
    return `${ET_INTERVAL_NAMES[s]} + ${o} octaves`;
  }

  /** Name the interval between two frequencies (lower, higher). */
  function describeInterval(f1, f2) {
    const lo = Math.min(f1, f2), hi = Math.max(f1, f2);
    const c = 1200 * log2(hi / lo);
    const octaves = Math.floor((c + 50) / 1200);
    const red = c - octaves * 1200; // -50..1150
    const semis = Math.round(red / 100);
    const etName = intervalName(semis + 12 * octaves);
    let best = null;
    for (const j of JUST_INTERVALS) {
      const dev = red - j.cents;
      if (!best || Math.abs(dev) < Math.abs(best.dev)) best = { ...j, dev };
    }
    // full (unreduced) just ratio, e.g. 3/2 an octave up -> 3/1
    let jn = best.n, jd = best.d;
    for (let i = 0; i < octaves; i++) { if (jd % 2 === 0) jd /= 2; else jn *= 2; }
    return {
      cents: c, octaves, reducedCents: red, semitones: semis + 12 * octaves,
      etName, etDev: red - semis * 100, just: best, justFull: [jn, jd],
    };
  }

  /** Describe the h-th harmonic relative to the fundamental. */
  function describeHarmonic(h) {
    const c = cents(h);
    const oct = Math.floor(c / 1200 + 1e-9);
    const red = c - oct * 1200;
    const semis = Math.round(red / 100);
    let pow2 = 1; for (let i = 0; i < oct; i++) pow2 *= 2;
    return {
      h, cents: c, octaves: oct, reducedCents: red,
      etName: ET_INTERVAL_NAMES[semis % 12] + (semis === 12 ? ' (8ve)' : ''),
      etSemis: semis + 12 * oct,
      etDev: red - semis * 100, // how far the harmonic lies from the nearest ET note
      ratioText: `${h}/${pow2}`,
    };
  }

  function gcd(a, b) { while (b) { [a, b] = [b, a % b]; } return a; }
  function ratioText(r) { if (!r) return ''; const g = gcd(r[0], r[1]); return `${r[0] / g}/${r[1] / g}`; }

  return {
    SHARP_NAMES, FLAT_NAMES, SVARAS, TUNINGS, SHRUTIS, JUST_INTERVALS,
    PitchSpace, svaraText, describeInterval, describeHarmonic, ratioText, cents, degreeNoteName, intervalName,
  };
});
