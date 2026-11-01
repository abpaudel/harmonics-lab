/*
 * dissonance.js — sensory roughness (Plomp & Levelt 1965, parameterised by
 * Sethares 1993 / "Tuning, Timbre, Spectrum, Scale" 2005).
 *
 * Two partials closer than about a critical band "beat" against each other and
 * sound rough; the roughness peaks when they are ~1/4 of a critical band apart and
 * vanishes at unison (perfect coincidence) and at large separation. Summing the
 * roughness of all partial pairs gives a dissonance value for any sound — no note
 * detection required. Consonant intervals are those where the partials of the two
 * notes either coincide or stay far apart.
 */
(function (root, factory) {
  const mod = factory();
  if (typeof module === 'object' && module.exports) module.exports = mod;
  else root.HDiss = mod;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const B1 = 3.51, B2 = 5.75, DSTAR = 0.24, S1 = 0.0207, S2 = 18.96;
  const PEAK = Math.exp(-B1 * 0.21253) - Math.exp(-B2 * 0.21253); // normalise max to 1
  const XMAX = Math.log(B2 / B1) / (B2 - B1);

  /** Roughness of two partials (amplitudes linear). Max = min(a1, a2). */
  function pairRoughness(f1, a1, f2, a2) {
    const fmin = f1 < f2 ? f1 : f2;
    const s = DSTAR / (S1 * fmin + S2);
    const x = s * Math.abs(f2 - f1);
    if (x > 6) return 0;
    return Math.min(a1, a2) * (Math.exp(-B1 * x) - Math.exp(-B2 * x)) / PEAK;
  }

  /** Separation (Hz) of maximum roughness around frequency f. */
  function maxRoughnessDf(f) { return XMAX / (DSTAR / (S1 * f + S2)); }

  /** Sum of roughness over all pairs. partials: [{freq, amp}] */
  function totalRoughness(partials) {
    let d = 0;
    const n = partials.length;
    for (let i = 0; i < n; i++) {
      const p = partials[i];
      for (let j = i + 1; j < n; j++) d += pairRoughness(p.freq, p.amp, partials[j].freq, partials[j].amp);
    }
    return d;
  }

  /**
   * The strongest roughness-producing pairs, for drawing. Returns
   * [{i, j, d, beat (Hz)}] sorted by d descending.
   */
  function roughPairs(partials, limit = 40, minD = 1e-4) {
    const out = [];
    const n = partials.length;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const d = pairRoughness(partials[i].freq, partials[i].amp, partials[j].freq, partials[j].amp);
        if (d > minD) out.push({ i, j, d, beat: Math.abs(partials[j].freq - partials[i].freq) });
      }
    }
    out.sort((a, b) => b.d - a.d);
    return out.slice(0, limit);
  }

  /**
   * Sethares dissonance curve: roughness of a timbre sounded together with a copy
   * of itself transposed by ratio r, for r in [rMin, rMax].
   * timbre: [{freq (multiple of f0, e.g. 1, 2, 3 …), amp}]
   */
  function dissonanceCurve(timbre, f0, rMin = 1, rMax = 2.05, steps = 800) {
    const base = timbre.map(p => ({ freq: p.freq * f0, amp: p.amp }));
    const intrinsic = totalRoughness(base);
    const out = [];
    for (let s = 0; s <= steps; s++) {
      // logarithmic steps (equal cents)
      const r = rMin * Math.pow(rMax / rMin, s / steps);
      let d = intrinsic * 2;
      for (const p of base) {
        for (const q of base) d += pairRoughness(p.freq, p.amp, q.freq * r, q.amp);
      }
      for (let i = 0; i < base.length; i++) {
        for (let j = i + 1; j < base.length; j++) {
          d += pairRoughness(base[i].freq * r, base[i].amp, base[j].freq * r, base[j].amp) - pairRoughness(base[i].freq, base[i].amp, base[j].freq, base[j].amp);
        }
      }
      out.push({ ratio: r, d });
    }
    return out;
  }

  /** Local minima of a curve [{ratio, d}] that are dips of at least `minDepth` (relative). */
  function localMinima(curve, minDepth = 0.002) {
    const res = [];
    const span = Math.max(...curve.map(c => c.d)) - Math.min(...curve.map(c => c.d));
    for (let i = 0; i < curve.length; i++) {
      const v = curve[i].d;
      const l = i > 0 ? curve[i - 1].d : Infinity, r = i < curve.length - 1 ? curve[i + 1].d : Infinity;
      if (v <= l && v <= r) {
        // depth: rise on both sides within a window
        let lm = v, rm = v;
        for (let k = i; k >= Math.max(0, i - 40); k--) lm = Math.max(lm, curve[k].d);
        for (let k = i; k < Math.min(curve.length, i + 40); k++) rm = Math.max(rm, curve[k].d);
        const depth = Math.min(i === 0 ? Infinity : lm - v, i === curve.length - 1 ? Infinity : rm - v);
        if (depth >= minDepth * span) res.push({ ratio: curve[i].ratio, d: v, depth });
      }
    }
    return res;
  }

  return { pairRoughness, totalRoughness, roughPairs, dissonanceCurve, localMinima, maxRoughnessDf };
});
