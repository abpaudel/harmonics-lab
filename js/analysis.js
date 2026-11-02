/*
 * analysis.js — the analysis pipeline, driven by audio samples on a fixed hop.
 *
 * Core takes raw samples (any chunk size), keeps its own ring buffer and runs one
 * analysis every `hop` samples (≈ 1/60 s), independent of the display frame rate:
 * spectrum + peaks (dsp.js), note detection (pitch.js), roughness (dissonance.js),
 * smoothed display spectrum. Each reading is handed to `emit` as a plain,
 * structured-cloneable object, so the same code runs in a Web Worker
 * (analysis-worker.js) or, where workers are unavailable, on the main thread.
 *
 * If analysis cannot keep up (slow device, large FFT, busy thread), the audio queues
 * up behind it. Core measures that lag against the wall clock and skips readings
 * until it has caught up; the next reading reports how many hops it stands for
 * (`cols`), so time axes stay correct.
 */
(function (root, factory) {
  const isNode = typeof module === 'object' && module.exports;
  const mod = isNode
    ? factory(require('./dsp.js'), require('./pitch.js'), require('./dissonance.js'))
    : factory(root.HDSP, root.HPitch, root.HDiss);
  if (isNode) module.exports = mod;
  else root.HAnalysis = mod;
})(typeof self !== 'undefined' ? self : this, function (D, P, X) {
  'use strict';

  const RATE = 60;          // target readings per second
  const MAX_LAG_S = 0.15;   // fall further behind than this and readings are skipped

  /** Readings per second actually used for a sample rate (hop is a whole number of samples). */
  function hopFor(sampleRate) { return Math.max(1, Math.round(sampleRate / RATE)); }

  const DEFAULT_PARAMS = {
    thresh: 15, range: 60, gate: -70, poly: true, maxVoices: 4, minF0: 50, maxHarm: 16,
    fMax: 6000, smooth: 0.5, running: false, sourcesActive: false,
  };

  class Core {
    /**
     * emit(frame, transfer): receives each reading and the list of its transferable buffers.
     * now(): wall clock in ms (injectable for tests).
     */
    constructor(emit, now = () => performance.now()) {
      this.emit = emit;
      this.now = now;
      this.params = { ...DEFAULT_PARAMS };
      this.analyzer = null;
    }

    /** Analyzer shape: { sampleRate, fft, window }. Resets the ring buffer and smoothing. */
    configure({ sampleRate, fft, window }) {
      this.sampleRate = sampleRate;
      this.analyzer = new D.Analyzer({ sampleRate, fftSize: fft, windowType: window });
      this.hop = hopFor(sampleRate);
      this.rate = sampleRate / this.hop;
      const need = this.analyzer.samplesNeeded;
      let size = 1;
      while (size < need + 16 * this.hop + 8192) size <<= 1;
      this.ring = new Float32Array(size);
      this.mask = size - 1;
      this.buf = new Float32Array(need);
      this.written = 0;          // total samples received
      this.nextEnd = this.hop;   // sample count at which the next reading is due
      this.skipped = 0;          // hops passed without a reading since the last one
      this.lagBase = null;       // baseline of (wall clock − audio clock), in samples
      this.lagAt = 0;
      this.displayDb = null;
      this.roughEma = 0;
    }

    /** Detection / display parameters and run state (partial updates allowed). */
    setParams(p) {
      const wasRunning = this.params.running;
      Object.assign(this.params, p);
      // Starting again: begin with the newest audio, no catch-up over the paused stretch.
      if (this.params.running && !wasRunning && this.analyzer) {
        this.nextEnd = this.written + this.hop;
        this.skipped = 0;
      }
    }

    /** Append samples; runs every reading that falls due. */
    push(x) {
      if (!this.analyzer) return;
      const r = this.ring, m = this.mask, n = x.length;
      let p = this.written & m;
      for (let i = 0; i < n; i++) { r[p] = x[i]; p = (p + 1) & m; }
      this.written += n;
      if (!this.params.running) { this.nextEnd = this.written + this.hop; return; }

      const behind = this._lag() > MAX_LAG_S * this.sampleRate;
      while (this.written >= this.nextEnd) {
        // Behind real time: skip readings until the queued audio has been drained.
        if (behind) { this.skipped++; this.nextEnd += this.hop; continue; }
        this._analyse(this.nextEnd);
        this.nextEnd += this.hop;
      }
    }

    /**
     * How far (in samples) the audio received so far trails the wall clock, relative to
     * the smallest such lag seen. The baseline creeps up by 1 ms per second so clock drift
     * between the audio device and the system clock cannot accumulate.
     */
    _lag() {
      const t = this.now();
      const lag = t * this.sampleRate / 1000 - this.written;
      if (this.lagBase === null) { this.lagBase = lag; this.lagAt = t; return 0; }
      this.lagBase += (t - this.lagAt) * this.sampleRate / 1e6;
      this.lagAt = t;
      if (lag < this.lagBase) this.lagBase = lag;
      return lag - this.lagBase;
    }

    _analyse(end) {
      const an = this.analyzer, need = an.samplesNeeded, s = this.params, r = this.ring, m = this.mask, buf = this.buf;
      let p = (end - need) & m;
      for (let i = 0; i < need; i++) { buf[i] = r[p]; p = (p + 1) & m; }

      const nyq = this.sampleRate / 2;
      const res = an.process(buf, {
        minFreq: 25, maxFreq: Math.min(nyq * 0.95, Math.max(s.fMax * 1.05, 12000)),
        thresholdDb: s.thresh, rangeDb: s.range + 10, maxPeaks: 150,
      });
      const silent = res.rmsDb < s.gate || !s.sourcesActive;
      const peaks = silent ? [] : res.peaks;

      // display spectrum (smoothed copy)
      if (!this.displayDb || this.displayDb.length !== res.db.length) this.displayDb = Float32Array.from(res.db);
      else {
        const a = s.smooth, d = this.displayDb, src = res.db;
        for (let k = 0; k < d.length; k++) d[k] = a * d[k] + (1 - a) * src[k];
      }

      const voices = P.detectVoices(peaks, {
        polyphonic: s.poly, maxVoices: s.maxVoices, minF0: s.minF0, dynamicDb: s.range, maxHarmonics: Math.max(32, s.maxHarm),
      });

      // roughness of the whole sound, amplitudes relative to the loudest partial
      let maxAmp = 0;
      for (const pk of peaks) if (pk.amp > maxAmp) maxAmp = pk.amp;
      const parts = peaks.map(pk => ({ freq: pk.freq, amp: maxAmp ? pk.amp / maxAmp : 0 }));
      const total = parts.length ? X.totalRoughness(parts) : 0;
      this.roughEma = this.roughEma * 0.85 + total * 0.15;

      const db = res.db.slice(), displayDb = this.displayDb.slice(), floor = res.floor.slice();
      const frame = {
        type: 'frame',
        cols: 1 + this.skipped,          // hops this reading stands for
        rate: this.rate,                 // readings per second
        time: end / this.sampleRate,     // audio time at the end of the window, s
        result: {
          sampleRate: res.sampleRate, fftSize: res.fftSize, binHz: res.binHz,
          db, floor, peaks, rmsDb: res.rmsDb, peakAbs: res.peakAbs,
        },
        displayDb, voices, silent,
        roughness: this.roughEma,
        roughPairs: parts.length ? X.roughPairs(parts, 80, 0.005) : [],
        level: res.peakAbs,
      };
      this.skipped = 0;
      this.emit(frame, [db.buffer, displayDb.buffer, floor.buffer]);
    }
  }

  /**
   * Main-thread side. Runs Core in a Web Worker when possible and falls back to running
   * it in this thread (e.g. pages opened from file://, where workers are refused).
   * onframe(frame) receives every reading.
   */
  class Client {
    constructor(onframe, workerUrl) {
      this.onframe = onframe;
      this.cfg = null;
      this.params = {};
      this.sinkListeners = [];
      this.kind = 'starting';
      try {
        if (typeof Worker === 'undefined') throw new Error('no Worker');
        const w = new Worker(workerUrl);
        this.worker = w;
        this.kind = 'Worker';
        w.onmessage = e => {
          if (e.data.type === 'frame') this.onframe(e.data);
        };
        w.onerror = e => {
          if (e && e.preventDefault) e.preventDefault();
          this._fallback(e && e.message);
        };
      } catch (err) {
        this._fallback(err && err.message);
      }
    }

    _fallback(reason) {
      if (this.core) return;
      if (this.worker) { this.worker.terminate(); this.worker = null; }
      this.kind = 'main thread';
      this.fallbackReason = reason ? String(reason) : '';
      this.core = new Core(f => this.onframe(f));
      if (this.cfg) this.core.configure(this.cfg);
      this.core.setParams(this.params);
      this.sinkListeners.forEach(fn => fn());
    }

    /**
     * Where audio samples should go: { port } (a MessagePort into the worker, which the
     * capture worklet can post to directly) or { fn } (call with each Float32Array chunk).
     */
    sink() {
      if (this.core) return { fn: x => this.core.push(x) };
      const ch = new MessageChannel();
      this.worker.postMessage({ type: 'port', port: ch.port1 }, [ch.port1]);
      return { port: ch.port2 };
    }

    /** Called when the sink changes (worker failed and analysis moved to this thread). */
    onSinkChange(fn) { this.sinkListeners.push(fn); }

    configure(cfg) {
      this.cfg = { ...cfg };
      if (this.core) this.core.configure(this.cfg);
      else this.worker.postMessage({ type: 'configure', cfg: this.cfg });
    }

    setParams(p) {
      Object.assign(this.params, p);
      if (this.core) this.core.setParams(p);
      else this.worker.postMessage({ type: 'params', params: p });
    }
  }

  return { Core, Client, hopFor, RATE, MAX_LAG_S };
});
