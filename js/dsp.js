/*
 * dsp.js — spectral analysis core.
 *
 * Works in the browser (exposes window.HDSP) and in Node (module.exports) so the
 * exact same code can be validated with synthetic signals.
 *
 * Accuracy strategy
 *  - Two overlapping frames (offset by `hop` samples) are packed into ONE complex
 *    FFT (frame A in the real part, frame B in the imaginary part).
 *  - Peak frequency is refined with the phase-vocoder method: the phase advance of
 *    a stationary sinusoid between the two frames is exactly 2*pi*f*hop/fs, which
 *    gives sub-0.01-bin precision, far better than parabolic interpolation.
 *  - Peak amplitude is corrected for scalloping loss using the analytic window kernel.
 */
(function (root, factory) {
  const mod = factory();
  if (typeof module === 'object' && module.exports) module.exports = mod;
  else root.HDSP = mod;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const TWO_PI = Math.PI * 2;

  /* ------------------------------------------------------------------ FFT */
  const fftTables = new Map();
  function tablesFor(n) {
    let t = fftTables.get(n);
    if (t) return t;
    const levels = Math.round(Math.log2(n));
    if (1 << levels !== n) throw new Error('FFT size must be a power of two');
    const rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      let x = i, r = 0;
      for (let j = 0; j < levels; j++) { r = (r << 1) | (x & 1); x >>>= 1; }
      rev[i] = r;
    }
    const cos = new Float64Array(n >> 1), sin = new Float64Array(n >> 1);
    for (let i = 0; i < n >> 1; i++) { cos[i] = Math.cos(TWO_PI * i / n); sin[i] = Math.sin(TWO_PI * i / n); }
    t = { rev, cos, sin };
    fftTables.set(n, t);
    return t;
  }

  /** In-place forward complex FFT (kernel e^{-i 2 pi k n / N}). */
  function fft(re, im) {
    const n = re.length;
    const { rev, cos, sin } = tablesFor(n);
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1, step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = i, k = 0; j < i + half; j++, k += step) {
          const l = j + half;
          const c = cos[k], s = sin[k];
          const tre = re[l] * c + im[l] * s;
          const tim = im[l] * c - re[l] * s;
          re[l] = re[j] - tre; im[l] = im[j] - tim;
          re[j] += tre; im[j] += tim;
        }
      }
    }
  }

  /* -------------------------------------------------------------- Windows */
  // Cosine-sum windows: w[n] = sum_m (-1)^m a_m cos(2 pi m n / N)  (periodic form)
  const WINDOWS = {
    hann: { coeffs: [0.5, 0.5], mainLobeBins: 2, label: 'Hann' },
    blackmanHarris: { coeffs: [0.35875, 0.48829, 0.14128, 0.01168], mainLobeBins: 4, label: 'Blackman-Harris' },
  };

  function makeWindow(type, n) {
    const a = WINDOWS[type].coeffs;
    const w = new Float64Array(n);
    let sum = 0;
    for (let i = 0; i < n; i++) {
      let v = 0;
      for (let m = 0; m < a.length; m++) v += (m % 2 ? -1 : 1) * a[m] * Math.cos(TWO_PI * m * i / n);
      w[i] = v; sum += v;
    }
    return { w, sum };
  }

  function sinc(x) { if (Math.abs(x) < 1e-9) return 1; const px = Math.PI * x; return Math.sin(px) / px; }

  /** Normalised magnitude response of the window at an offset of `d` bins (1 at d = 0). */
  function windowKernel(type, d) {
    const a = WINDOWS[type].coeffs;
    let v = a[0] * sinc(d);
    for (let m = 1; m < a.length; m++) v += 0.5 * a[m] * (sinc(d - m) + sinc(d + m));
    return Math.abs(v) / a[0];
  }

  function princarg(p) { return p - TWO_PI * Math.round(p / TWO_PI); }

  /* ------------------------------------------------------------- Analyzer */
  class Analyzer {
    constructor(opts) { this.configure(opts || {}); }

    configure({ sampleRate = 48000, fftSize = 16384, windowType = 'hann', hopDivisor = 4 } = {}) {
      this.sampleRate = sampleRate;
      this.fftSize = fftSize;
      this.windowType = windowType;
      this.hop = fftSize / hopDivisor;
      this.binHz = sampleRate / fftSize;
      const { w, sum } = makeWindow(windowType, fftSize);
      this.win = w; this.winSum = sum;
      this.re = new Float64Array(fftSize);
      this.im = new Float64Array(fftSize);
      const nb = fftSize / 2 + 1;
      this.db = new Float32Array(nb);
      this.phA = new Float32Array(nb);
      this.phB = new Float32Array(nb);
      this.floor = new Float32Array(nb);
      this._tmp = new Float32Array(nb);
      this._prefix = new Float64Array(nb + 1);
    }

    /** Number of samples the analyzer needs for one analysis. */
    get samplesNeeded() { return this.fftSize + this.hop; }

    /**
     * Analyse the most recent `samplesNeeded` samples of `buf` (ending at `end`).
     * opts: { minFreq, maxFreq, thresholdDb (above local floor), rangeDb (below max peak), maxPeaks }
     */
    process(buf, opts = {}, end = buf.length) {
      const N = this.fftSize, H = this.hop, w = this.win, re = this.re, im = this.im;
      const startB = end - N, startA = startB - H;
      if (startA < 0) throw new Error('not enough samples');
      let sumSq = 0, peakAbs = 0;
      for (let i = 0; i < N; i++) {
        const b = buf[startB + i];
        re[i] = buf[startA + i] * w[i];
        im[i] = b * w[i];
        sumSq += b * b;
        const ab = b < 0 ? -b : b;
        if (ab > peakAbs) peakAbs = ab;
      }
      fft(re, im);

      // Unpack the two real spectra.
      const nb = N / 2 + 1, scale = 2 / this.winSum, db = this.db, phA = this.phA, phB = this.phB;
      this._linB = this._linB && this._linB.length === nb ? this._linB : new Float32Array(nb);
      const lin = this._linB;
      for (let k = 0; k < nb; k++) {
        const nk = (N - k) & (N - 1);
        const aRe = 0.5 * (re[k] + re[nk]), aIm = 0.5 * (im[k] - im[nk]);
        const bRe = 0.5 * (im[k] + im[nk]), bIm = -0.5 * (re[k] - re[nk]);
        const mag = Math.sqrt(bRe * bRe + bIm * bIm) * scale;
        lin[k] = mag;
        db[k] = 20 * Math.log10(mag + 1e-12);
        phA[k] = Math.atan2(aIm, aRe);
        phB[k] = Math.atan2(bIm, bRe);
      }
      this._estimateFloor();
      const peaks = this._findPeaks(opts);
      return {
        sampleRate: this.sampleRate, fftSize: N, binHz: this.binHz,
        db, floor: this.floor, peaks,
        rmsDb: 10 * Math.log10(sumSq / N + 1e-20), peakAbs,
      };
    }

    /**
     * Local noise floor: a two-pass, clipped moving average of the dB spectrum over a
     * constant fractional bandwidth (about +/- 1/6 octave). Approximates a running median.
     */
    _estimateFloor() {
      const db = this.db, nb = db.length, floor = this.floor, tmp = this._tmp, P = this._prefix;
      const halfWidth = k => Math.max(12, Math.round(k * 0.12));
      const smooth = (src, dst) => {
        P[0] = 0;
        for (let k = 0; k < nb; k++) P[k + 1] = P[k] + src[k];
        for (let k = 0; k < nb; k++) {
          const h = halfWidth(k);
          const lo = Math.max(0, k - h), hi = Math.min(nb - 1, k + h);
          dst[k] = (P[hi + 1] - P[lo]) / (hi - lo + 1);
        }
      };
      smooth(db, floor);
      for (let k = 0; k < nb; k++) tmp[k] = Math.min(db[k], floor[k] + 3);
      smooth(tmp, floor);
      for (let k = 0; k < nb; k++) tmp[k] = Math.min(db[k], floor[k] + 3);
      smooth(tmp, floor);
    }

    _findPeaks({ minFreq = 25, maxFreq = 12000, thresholdDb = 15, rangeDb = 70, maxPeaks = 120, absMinDb = -110 } = {}) {
      const db = this.db, floor = this.floor, binHz = this.binHz, nb = db.length;
      const lobe = WINDOWS[this.windowType].mainLobeBins;
      const kMin = Math.max(lobe + 1, Math.floor(minFreq / binHz));
      const kMax = Math.min(nb - lobe - 2, Math.ceil(maxFreq / binHz));
      const cands = [];
      for (let k = kMin; k <= kMax; k++) {
        const v = db[k];
        if (v < absMinDb || v < floor[k] + thresholdDb) continue;
        let isMax = true;
        for (let j = 1; j <= lobe; j++) {
          if (db[k - j] >= v || db[k + j] > v) { isMax = false; break; }
        }
        if (isMax) cands.push(k);
      }
      if (!cands.length) return [];
      let maxDb = -Infinity;
      for (const k of cands) if (db[k] > maxDb) maxDb = db[k];
      const strong = cands.filter(k => db[k] >= maxDb - rangeDb);

      // Reject window side-lobes / leakage: a weaker local maximum within a few bins of a
      // much stronger one is not a real partial.
      const sideBins = this.windowType === 'hann' ? 8 : 6;
      const sideDrop = this.windowType === 'hann' ? 26 : 60;
      const kept = strong.filter(k => {
        for (const j of strong) {
          if (j !== k && Math.abs(j - k) <= sideBins && db[j] - db[k] > sideDrop) return false;
        }
        return true;
      });

      const peaks = kept.map(k => this._refine(k));
      peaks.sort((a, b) => b.db - a.db);
      const out = peaks.slice(0, maxPeaks);
      out.sort((a, b) => a.freq - b.freq);
      return out;
    }

    _refine(k) {
      const db = this.db, binHz = this.binHz, N = this.fftSize, H = this.hop;
      // Parabolic interpolation on the dB magnitude (fallback / sanity check).
      const a = db[k - 1], b = db[k], c = db[k + 1];
      const den = a - 2 * b + c;
      const pOff = den !== 0 ? Math.max(-0.5, Math.min(0.5, 0.5 * (a - c) / den)) : 0;
      // Phase vocoder: phase advance over `hop` samples.
      const expected = TWO_PI * k * H / N;
      const dev = princarg(this.phB[k] - this.phA[k] - expected);
      let off = dev * N / (TWO_PI * H); // offset in bins
      let method = 'phase';
      if (!isFinite(off) || Math.abs(off - pOff) > 0.6) { off = pOff; method = 'parabolic'; }
      const freq = (k + off) * binHz;
      const corr = windowKernel(this.windowType, Math.min(Math.abs(off), 0.999));
      const amp = this._linB[k] / corr;
      return {
        bin: k, freq, amp, db: 20 * Math.log10(amp + 1e-12),
        prominence: b - this.floor[k], method,
      };
    }
  }

  /* -------------------------------------------------- Test-signal helpers */
  /**
   * Additive synthesis of a sum of partials (used by tests and the in-app tone lab).
   * partials: [{ freq, amp, phase }]
   */
  function synth(partials, length, sampleRate, noiseAmp = 0, seed = 1) {
    const out = new Float32Array(length);
    for (const p of partials) {
      const w = TWO_PI * p.freq / sampleRate, ph = p.phase || 0;
      for (let i = 0; i < length; i++) out[i] += p.amp * Math.sin(w * i + ph);
    }
    if (noiseAmp > 0) {
      let s = seed >>> 0 || 1;
      const rnd = () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
      for (let i = 0; i < length; i++) {
        // Box-Muller gaussian
        const u = rnd() || 1e-9, v = rnd();
        out[i] += noiseAmp * Math.sqrt(-2 * Math.log(u)) * Math.cos(TWO_PI * v);
      }
    }
    return out;
  }

  return { fft, makeWindow, windowKernel, WINDOWS, Analyzer, synth, princarg };
});
