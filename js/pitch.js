/*
 * pitch.js — find fundamentals ("voices") and their harmonic series in a list of
 * spectral peaks. Works for single notes and (best-effort) chords.
 *
 * Method (harmonic-sum with iterative explanation, after Klapuri 2003/2006):
 *   1. Every strong peak f and its sub-multiples f/2..f/6 are candidate fundamentals.
 *   2. A candidate's score sums the (compressed) salience of peaks that sit on its
 *      harmonic positions h*f0, with a weight that decreases with h. The expected
 *      position is tracked upward so slightly stretched (inharmonic) partials of
 *      strings/piano are still followed.
 *   3. Missing low harmonics are penalised, which suppresses "sub-octave" ghosts
 *      (e.g. C3 explaining a C4+G4 fifth).
 *   4. The best candidate is accepted, the peaks it explains are attenuated (not
 *      removed, so shared partials can still support another note), and the search
 *      repeats.
 */
(function (root, factory) {
  const mod = factory();
  if (typeof module === 'object' && module.exports) module.exports = mod;
  else root.HPitch = mod;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const cents = (a, b) => 1200 * Math.log2(a / b);

  function nearestPeak(peaks, f) {
    // peaks sorted by freq; binary search
    let lo = 0, hi = peaks.length - 1;
    if (hi < 0) return -1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (peaks[mid].freq < f) lo = mid; else hi = mid;
    }
    return Math.abs(peaks[lo].freq - f) <= Math.abs(peaks[hi].freq - f) ? lo : hi;
  }

  const DEFAULTS = {
    minF0: 30, maxF0: 2100, maxVoices: 6, tolCents: 25, tolCentsLocked: 12, maxHarmonics: 32,
    dynamicDb: 60, polyphonic: true, harmonicWeightExp: 0.5, missingPenalty: 0.6,
    relStop: 0.2, minScore: 8, clusterCents: 30, clusterHz: 6,
  };

  /** Match the harmonic series of f0 against peaks. Returns matches & score. */
  function matchSeries(peaks, rem, f0, o, fTop) {
    const matches = [];
    const used = new Set();
    // Predict each partial from the last matched one plus the measured partial spacing.
    // For stiff strings the spacing grows slowly with h, so this follows stretched
    // series closely and lets the tolerance stay tight.
    let lastF = 0, lastH = 0, spacing = f0;
    for (let h = 1; h <= o.maxHarmonics; h++) {
      const expected = lastH ? lastF + (h - lastH) * spacing : h * f0;
      if (expected > fTop * 1.03) break;
      const i = nearestPeak(peaks, expected);
      if (i < 0) break;
      // Wider for the first partials (locking on), tight afterwards; capped so that
      // neighbouring harmonics can never be confused.
      const base = h <= 2 || !lastH ? o.tolCents : o.tolCentsLocked + 0.5 * Math.max(0, h - 12);
      const tol = Math.min(base, 1200 * Math.log2(1 + 0.45 / h));
      const dev = cents(peaks[i].freq, expected);
      if (Math.abs(dev) <= tol && !used.has(i)) {
        used.add(i);
        matches.push({ h, i, dev: cents(peaks[i].freq, h * f0) });
        const f = peaks[i].freq;
        if (lastH) {
          const sp = (f - lastF) / (h - lastH);
          spacing = lastH === 0 ? sp : 0.5 * spacing + 0.5 * sp;
        } else {
          spacing = f / h;
        }
        lastF = f; lastH = h;
      }
    }
    let score = 0, salSum = 0;
    const matchedH = new Set();
    for (const m of matches) {
      score += rem[m.i] / Math.pow(m.h, o.harmonicWeightExp);
      salSum += rem[m.i];
      matchedH.add(m.h);
    }
    const meanSal = matches.length ? salSum / matches.length : 0;
    // penalty for missing low harmonics that would fall inside the analysed range
    let missing = 0;
    for (let h = 1; h <= 6; h++) {
      if (h * f0 > fTop) break;
      if (!matchedH.has(h)) {
        missing++;
        score -= o.missingPenalty * meanSal / Math.pow(h, o.harmonicWeightExp) * (h === 1 ? 1.5 : 1);
      }
    }
    return { f0, matches, score, missing };
  }

  /**
   * peaks: array of {freq, db} sorted by frequency (output of Analyzer.process).
   * Returns voices sorted by frequency:
   *   { f0, score, harmonics: [{h, freq, db, dev (cents from h*f0), peakIndex}], salience }
   */
  /**
   * Merge peaks closer than `clusterCents` AND `clusterHz` into one partial (strongest member wins).
   * Vibrato/tremolo within a long analysis window splits one partial into several
   * sideband peaks; they must not be mistaken for independent partials.
   */
  function clusterPeaks(peaks, clusterCents, clusterHz) {
    const out = [];
    peaks.forEach((p, i) => {
      const last = out[out.length - 1];
      if (last && cents(p.freq, last.lastFreq) < clusterCents && p.freq - last.lastFreq < clusterHz) {
        last.lastFreq = p.freq;
        if (p.db > last.db) { last.freq = p.freq; last.db = p.db; last.origIndex = i; }
      } else {
        out.push({ freq: p.freq, db: p.db, origIndex: i, lastFreq: p.freq });
      }
    });
    return out;
  }

  function detectVoices(rawPeaks, options = {}) {
    const o = Object.assign({}, DEFAULTS, options);
    if (!rawPeaks || !rawPeaks.length) return [];
    const peaks = clusterPeaks(rawPeaks, o.clusterCents, o.clusterHz);
    let maxDb = -Infinity;
    for (const p of peaks) if (p.db > maxDb) maxDb = p.db;
    const ref = maxDb - o.dynamicDb;
    const sal = peaks.map(p => Math.max(0, p.db - ref));
    const rem = sal.slice();
    const fTop = peaks[peaks.length - 1].freq;

    // candidate list from the strongest peaks
    const order = peaks.map((_, i) => i).sort((a, b) => sal[b] - sal[a]).slice(0, 24);
    const baseCands = [];
    for (const i of order) {
      for (let d = 1; d <= 6; d++) {
        const f0 = peaks[i].freq / d;
        if (f0 < o.minF0 || f0 > o.maxF0) continue;
        if (!baseCands.some(c => Math.abs(cents(c, f0)) < 15)) baseCands.push(f0);
      }
    }

    const voices = [];
    let firstScore = 0, guard = 0;
    const rejected = new Set();
    const maxV = o.polyphonic ? o.maxVoices : 1;
    for (let iter = 0; iter < maxV; iter++) {
      let best = null;
      for (const f0 of baseCands) {
        if (rejected.has(f0) || voices.some(v => Math.abs(cents(v.f0, f0)) < 60)) continue;
        const r = matchSeries(peaks, rem, f0, o, fTop);
        if (!r.matches.length) continue;
        if (!best || r.score > best.score) best = r;
      }
      if (!best) break;
      if (iter === 0) firstScore = best.score;
      if (best.score < o.minScore) break;
      if (iter > 0) {
        if (best.score < o.relStop * firstScore) break;
        // A further voice must bring partials that were not already explained,
        // including its own fundamental or 2nd harmonic.
        // Either its own fundamental, or (missing-fundamental case) both h2 and h3 —
        // a sub-octave "ghost" of an existing note has only even harmonics.
        const fresh = best.matches.filter(m => rem[m.i] > 0.6 * sal[m.i]);
        const fh = new Set(fresh.map(m => m.h));
        const ownRoot = fh.has(1) || (fh.has(2) && fh.has(3));
        // "Shadow" of an accepted note: f0 sits near one of its harmonics and every fresh
        // partial hugs that note's harmonic positions (vibrato/FM sidebands, smeared
        // partials). A genuine note there would be an octave/12th doubling, which cannot
        // be separated anyway.
        const nearHarm = (f, v, tol) => { const k = Math.round(f / v.f0); return k >= 1 && Math.abs(cents(f, k * v.f0)) < tol; };
        const shadow = voices.some(v => nearHarm(best.f0, v, 40) &&
          fresh.every(m => nearHarm(peaks[m.i].freq, v, 60)));
        if (fresh.length < 2 || !ownRoot || shadow) {
          // reject this candidate only, keep searching others
          rejected.add(best.f0);
          iter--;
          if (++guard > 12) break;
          continue;
        }
      }
      voices.push(finaliseVoice(best, peaks, sal));
      for (const m of best.matches) rem[m.i] *= 0.3;
    }
    if (o.polyphonic) resolveOctaveErrors(voices);
    voices.sort((a, b) => a.f0 - b.f0);
    return voices;
  }

  function finaliseVoice(r, peaks, sal) {
    const harmonics = r.matches.map(m => ({
      h: m.h, freq: peaks[m.i].freq, db: peaks[m.i].db, peakIndex: peaks[m.i].origIndex, _ci: m.i,
    }));
    // Fundamental frequency: use the measured 1st partial when it is reasonably
    // strong (exactly what a tuner/ear locks onto); otherwise a precision-weighted
    // estimate from the low harmonics (higher h => proportionally finer f/h).
    let f0 = r.f0;
    const h1 = harmonics.find(x => x.h === 1);
    const maxSal = Math.max(...r.matches.map(m => sal[m.i]));
    if (h1 && sal[h1._ci] >= 0.5 * maxSal) {
      f0 = h1.freq;
    } else {
      let num = 0, den = 0;
      for (const x of harmonics) {
        if (x.h > 8) continue;
        const w = (sal[x._ci] + 1) * x.h;
        num += w * x.freq / x.h; den += w;
      }
      if (den > 0) f0 = num / den;
    }
    for (const x of harmonics) { x.dev = cents(x.freq, x.h * f0); delete x._ci; }
    const salience = r.matches.reduce((s, m) => s + sal[m.i], 0);
    return { f0, score: r.score, harmonics, salience, missingFundamental: !h1 };
  }

  // If a weaker voice sits an exact octave above another and all its partials are
  // shared, it is almost always an artefact; detectVoices already gates this, so this
  // is a final cheap sanity pass that drops voices with fewer than 1 own partial.
  function resolveOctaveErrors(voices) {
    for (let i = voices.length - 1; i >= 1; i--) {
      if (voices[i].harmonics.length === 0) voices.splice(i, 1);
    }
  }

  return { detectVoices, matchSeries, DEFAULTS };
});
