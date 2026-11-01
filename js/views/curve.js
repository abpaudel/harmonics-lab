/*
 * Dissonance curve (Sethares): roughness of a timbre against a transposed copy of
 * itself across an octave (or two). The minima are the consonant intervals *for that
 * timbre*. Live intervals between detected notes are marked on the curve.
 */
(function (root) {
  'use strict';
  const U = root.HUI, X = root.HDiss, M = root.HMusic;

  const RATIOS = [[1, 1], [16, 15], [9, 8], [7, 6], [6, 5], [5, 4], [4, 3], [7, 5], [3, 2], [8, 5], [5, 3], [7, 4], [9, 5], [15, 8], [2, 1],
    [9, 4], [12, 5], [5, 2], [8, 3], [3, 1], [10, 3], [7, 2], [4, 1]];
  const MAJOR = new Set(['1/1', '6/5', '5/4', '4/3', '3/2', '5/3', '2/1', '5/2', '3/1', '4/1', '7/4']);

  function presetTimbre(kind) {
    const out = [];
    for (let h = 1; h <= 10; h++) {
      if (kind === 'sine' && h > 1) break;
      if (kind === 'square' && h % 2 === 0) continue;
      const stretch = kind === 'stretched' ? Math.sqrt(1 + 0.003 * h * h) / Math.sqrt(1.003) : 1;
      out.push({ freq: h * stretch, amp: kind === 'saw' && h > 8 ? 0 : 1 / h });
    }
    return out.filter(p => p.amp > 0);
  }

  const view = {
    init(app) {
      this.app = app;
      this.cv = U.managedCanvas(document.getElementById('cvCurve'));
      this.selTimbre = document.getElementById('curveTimbre');
      this.selSpan = document.getElementById('curveSpan');
      this.selTimbre.addEventListener('change', () => { this._sig = null; app.requestRender(); });
      this.selSpan.addEventListener('change', () => { this._sig = null; app.requestRender(); });
      this.curve = null;
    },

    _timbre() {
      const voices = this.app.frame ? this.app.frame.voices : [];
      const kind = this.selTimbre.value;
      if (kind === 'live') {
        if (!voices.length) return { parts: presetTimbre('saw'), f0: 261.63, label: 'no live note — showing 1/n string' };
        const v = voices.reduce((a, b) => (a.salience > b.salience ? a : b));
        const ref = Math.max(...v.harmonics.map(h => h.db));
        const parts = v.harmonics.filter(h => h.h <= 12 && h.db > ref - 40)
          .map(h => ({ freq: h.freq / v.f0, amp: Math.pow(10, (h.db - ref) / 20) }));
        const lowest = Math.min(...voices.map(x => x.f0));
        return { parts, f0: lowest, label: `live timbre of ${this.app.ps.etNote(v.f0).label} (${parts.length} partials)`, color: v.color };
      }
      const lowest = voices.length ? Math.min(...voices.map(x => x.f0)) : 261.63;
      return { parts: presetTimbre(kind), f0: lowest, label: this.selTimbre.selectedOptions[0].textContent };
    },

    render() {
      const app = this.app, s = app.settings, ps = app.ps;
      const ctx = this.cv.begin(), W = this.cv.w, H = this.cv.h;
      const L = 40, R = 14, T = 34, B = 60;
      const rMax = +this.selSpan.value;
      const cMax = 1200 * Math.log2(rMax);
      const xOfC = c => L + c / cMax * (W - L - R);

      // recompute the curve when the timbre changes noticeably (max ~4x/s)
      const tb = this._timbre();
      const sig = tb.parts.map(p => p.freq.toFixed(2) + ':' + (20 * Math.log10(p.amp)).toFixed(0)).join(',') + '|' + Math.round(12 * Math.log2(tb.f0)) + '|' + rMax;
      const now = performance.now();
      if (sig !== this._sig && (!this._t || now - this._t > 250)) {
        this._sig = sig; this._t = now;
        this.curve = X.dissonanceCurve(tb.parts, tb.f0, 1, rMax, Math.round(W * 0.8));
        const max = Math.max(...this.curve.map(p => p.d)), min = Math.min(...this.curve.map(p => p.d));
        this.norm = { max, min };
        this.minima = X.localMinima(this.curve, 0.012);
        this.label = tb.label;
      }
      const curve = this.curve;
      if (!curve) return;
      const { max, min } = this.norm;
      const yOf = d => H - B - (d - min) / (max - min || 1) * (H - T - B);

      // ET semitone grid + names
      ctx.font = `10px ${U.SANS}`; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      const names = ['U', 'm2', 'M2', 'm3', 'M3', 'P4', 'TT', 'P5', 'm6', 'M6', 'm7', 'M7'];
      for (let c = 0; c <= cMax + 1; c += 100) {
        const x = Math.round(xOfC(c)) + 0.5;
        ctx.strokeStyle = c % 1200 === 0 ? U.C.gridStrong : U.C.grid;
        ctx.beginPath(); ctx.moveTo(x, T); ctx.lineTo(x, H - B); ctx.stroke();
        ctx.fillStyle = U.C.text2;
        const k = Math.round(c / 100) % 12;
        ctx.fillText(k === 0 ? (c === 0 ? 'U' : '8ve') : names[k], x, H - B + 16);
      }
      // selected tuning's degrees
      const deg = ps.activeDegrees();
      for (let o = 0; o * 1200 <= cMax; o++) {
        deg.forEach((d, i) => {
          const c = d.cents + o * 1200;
          if (c > cMax + 0.1) return;
          const x = xOfC(c);
          ctx.fillStyle = U.C.sa;
          ctx.beginPath(); ctx.moveTo(x - 3.5, H - B + 12); ctx.lineTo(x + 3.5, H - B + 12); ctx.lineTo(x, H - B + 5); ctx.closePath(); ctx.fill();
          if (s.sargam && (W - L - R) / (cMax / 100) > 40) U.drawSvara(ctx, { svara: M.SVARAS[i], octave: o }, x, H - B + 40, 10, U.C.sa, s.script);
        });
      }
      // just ratios
      ctx.textBaseline = 'alphabetic';
      for (const [n, d] of RATIOS) {
        const c = 1200 * Math.log2(n / d);
        if (c > cMax + 0.1) continue;
        const x = xOfC(c), key = n + '/' + d;
        const major = MAJOR.has(key);
        ctx.strokeStyle = major ? 'rgba(94,227,154,0.35)' : 'rgba(94,227,154,0.15)';
        ctx.setLineDash([2, 3]); ctx.beginPath(); ctx.moveTo(x, T - 4); ctx.lineTo(x, H - B); ctx.stroke(); ctx.setLineDash([]);
        if (major || (W - L - R) / (cMax / 100) > 55) {
          ctx.font = `${major ? 600 : 400} 10.5px ${U.MONO}`; ctx.fillStyle = major ? U.C.ok : 'rgba(94,227,154,0.6)';
          ctx.fillText(key, x, T - 8);
        }
      }
      // curve
      ctx.beginPath();
      curve.forEach((p, i) => {
        const x = xOfC(1200 * Math.log2(p.ratio)), y = yOf(p.d);
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      });
      ctx.strokeStyle = '#ff8a94'; ctx.lineWidth = 2; ctx.stroke(); ctx.lineWidth = 1;
      ctx.lineTo(xOfC(cMax), H - B); ctx.lineTo(xOfC(0), H - B); ctx.closePath();
      const g = ctx.createLinearGradient(0, T, 0, H - B);
      g.addColorStop(0, 'rgba(255,95,109,0.28)'); g.addColorStop(1, 'rgba(255,95,109,0.02)');
      ctx.fillStyle = g; ctx.fill();
      // minima
      for (const m of this.minima) {
        const x = xOfC(1200 * Math.log2(m.ratio)), y = yOf(m.d);
        ctx.fillStyle = U.C.ok; ctx.beginPath(); ctx.arc(x, y, 3.5, 0, 7); ctx.fill();
      }
      // y axis label
      ctx.save(); ctx.translate(13, (T + H - B) / 2); ctx.rotate(-Math.PI / 2);
      ctx.font = `10px ${U.SANS}`; ctx.fillStyle = U.C.text2; ctx.textAlign = 'center';
      ctx.fillText('roughness →', 0, 0); ctx.restore();

      // live intervals between notes (relative to lowest)
      const voices = app.frame ? app.frame.voices : [];
      if (voices.length > 1) {
        const base = voices[0];
        voices.slice(1).forEach((v, i) => {
          let c = 1200 * Math.log2(v.f0 / base.f0);
          if (c > cMax) c = c % 1200 + (cMax >= 2400 ? 1200 : 0);
          const x = xOfC(c);
          ctx.strokeStyle = v.color; ctx.lineWidth = 2;
          ctx.beginPath(); ctx.moveTo(x, T); ctx.lineTo(x, H - B); ctx.stroke(); ctx.lineWidth = 1;
          // point on curve
          const r = Math.pow(2, c / 1200);
          let best = curve[0];
          for (const p of curve) if (Math.abs(p.ratio - r) < Math.abs(best.ratio - r)) best = p;
          ctx.fillStyle = v.color; ctx.beginPath(); ctx.arc(x, yOf(best.d), 5, 0, 7); ctx.fill();
          ctx.font = `600 11px ${U.SANS}`; ctx.textAlign = x > W - 140 ? 'right' : 'left';
          ctx.fillText(`${ps.etNote(base.f0).label}→${ps.etNote(v.f0).label}  ${c.toFixed(1)}¢`, x + (x > W - 140 ? -6 : 6), T + 14 + i * 14);
        });
      }
      ctx.font = `11px ${U.SANS}`; ctx.fillStyle = U.C.text2; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
      ctx.fillText(`Timbre: ${this.label} · base ${U.fmtHz(tb.f0)} Hz · ▲ = ${M.TUNINGS[s.tuning].short} degrees · ● = consonant valleys`, L, H - 4);
    },
  };

  (root.HViews = root.HViews || {}).curve = view;
})(typeof self !== 'undefined' ? self : this);
