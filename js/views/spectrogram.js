/*
 * Spectrogram: scrolling time × log-frequency image with note axis and traces of the
 * detected fundamentals. Keeps recording while hidden (cheap: one column per analysis
 * reading). Columns come at the analysis rate (≈ 60 per second, fixed by the audio hop,
 * not the display), so the time axis is exact; a reading that stands for several hops
 * (analysis fell behind) fills that many columns. Uses the unsmoothed spectrum, so
 * the display smoothing does not blur it in time.
 */
(function (root) {
  'use strict';
  const U = root.HUI;

  // perceptually ordered dark→bright colormap (inferno-like), 256 entries
  const LUT = (() => {
    const stops = [[0, 0, 0, 4], [0.15, 31, 12, 72], [0.3, 85, 15, 109], [0.45, 136, 34, 106], [0.6, 186, 54, 85],
      [0.72, 227, 89, 51], [0.85, 249, 140, 10], [0.95, 249, 201, 50], [1, 252, 255, 164]];
    const out = new Uint8ClampedArray(256 * 3);
    for (let i = 0; i < 256; i++) {
      const t = i / 255;
      let k = 0; while (k < stops.length - 2 && t > stops[k + 1][0]) k++;
      const [t0, r0, g0, b0] = stops[k], [t1, r1, g1, b1] = stops[k + 1];
      const u = (t - t0) / (t1 - t0);
      out[i * 3] = r0 + (r1 - r0) * u; out[i * 3 + 1] = g0 + (g1 - g0) * u; out[i * 3 + 2] = b0 + (b1 - b0) * u;
    }
    return out;
  })();

  const AX = 44, T = 6, B = 18;

  const view = {
    init(app) {
      this.app = app;
      this.off = document.createElement('canvas');
      this.off.width = this.off.height = 1;
      this.cv = U.managedCanvas(document.getElementById('cvSpectrogram'), () => { if (this.cv) this._alloc(); });
      this._alloc();
    },

    _alloc() {
      const w = Math.max(10, this.cv.w - AX - 4), h = Math.max(10, this.cv.h - T - B);
      if (this.off.width === w && this.off.height === h) return;
      const old = this.off.width > 1 ? this.off : null;
      const nc = document.createElement('canvas');
      nc.width = w; nc.height = h;
      const c = nc.getContext('2d');
      c.fillStyle = '#000004'; c.fillRect(0, 0, w, h);
      if (old) c.drawImage(old, w - old.width, 0, old.width, h);
      this.off = nc; this.offCtx = c;
      this.col = c.createImageData(1, h);
      this._range = null;
    },

    /** Called for every analysis reading. */
    push(frame) {
      if (!frame || !frame.result || !frame.result.db) return;
      this.rate = frame.rate;
      const s = this.app.settings, w = this.off.width, h = this.off.height;
      const key = s.fMin + '|' + s.fMax;
      if (this._range !== key) { // range changed: clear
        this._range = key; this.offCtx.fillStyle = '#000004'; this.offCtx.fillRect(0, 0, w, h);
      }
      const c = this.offCtx, n = Math.max(1, Math.min(w, frame.cols || 1));
      c.drawImage(this.off, -n, 0);
      const sc = U.logScale(s.fMin, s.fMax, h - 1, 0);
      const db = frame.result.db, binHz = frame.result.binHz, data = this.col.data;
      const lo = s.dbMin, span = -lo;
      for (let y = 0; y < h; y++) {
        const fa = sc.from(y + 0.5), fb = sc.from(y - 0.5);
        const ka = Math.floor(fa / binHz), kb = Math.max(ka, Math.ceil(fb / binHz));
        let v = -200;
        for (let k = ka; k <= kb && k < db.length; k++) if (db[k] > v) v = db[k];
        let t = (v - lo) / span; t = t < 0 ? 0 : t > 1 ? 1 : t;
        const i = Math.round(t * 255) * 3, o = y * 4;
        data[o] = LUT[i]; data[o + 1] = LUT[i + 1]; data[o + 2] = LUT[i + 2]; data[o + 3] = 255;
      }
      for (let i = 1; i <= n; i++) c.putImageData(this.col, w - i, 0);
      for (const v of frame.voices) {
        if (v.f0 < s.fMin || v.f0 > s.fMax) continue;
        c.fillStyle = v.color;
        c.fillRect(w - n - 1, Math.round(sc.to(v.f0)) - 1, n + 1, 3);
      }
    },

    render() {
      const app = this.app, s = app.settings, ps = app.ps;
      const ctx = this.cv.begin(), W = this.cv.w, H = this.cv.h;
      this._alloc();
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(this.off, AX, T);
      const sc = U.logScale(s.fMin, s.fMax, T + this.off.height - 1, T);
      const mLo = Math.ceil(ps.midi(s.fMin)), mHi = Math.floor(ps.midi(s.fMax));
      const pxPerSemi = this.off.height / (12 * Math.log2(s.fMax / s.fMin));
      ctx.font = `10px ${U.MONO}`; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      for (let m = mLo; m <= mHi; m++) {
        const pc = ((m % 12) + 12) % 12;
        if (pc !== 0 && !(pxPerSemi > 10 && [2, 4, 5, 7, 9, 11].includes(pc))) continue;
        const y = Math.round(sc.to(ps.freqOfMidi(m))) + 0.5;
        ctx.fillStyle = pc === 0 ? U.C.text : U.C.text2;
        ctx.fillText(ps.etNote(ps.freqOfMidi(m)).label, AX - 6, y);
        ctx.fillStyle = 'rgba(255,255,255,0.25)'; ctx.fillRect(AX, y - 0.5, 4, 1);
      }
      const rate = this.rate || 60, secs = this.off.width / rate;
      ctx.fillStyle = U.C.text2; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      for (let t = 0; t <= secs; t += secs > 20 ? 5 : 2) {
        const x = AX + this.off.width - t * rate;
        ctx.textAlign = t === 0 ? 'right' : 'center';
        ctx.fillText(t === 0 ? 'now' : `−${t}s`, x, T + this.off.height + 3);
      }
    },
  };

  (root.HViews = root.HViews || {}).spectrogram = view;
})(typeof self !== 'undefined' ? self : this);
