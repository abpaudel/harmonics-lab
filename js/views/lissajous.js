/*
 * Lissajous / harmonograph: two detected notes drawn against each other, one on X and
 * one on Y. A simple frequency ratio p:q traces a closed figure that touches the sides
 * q times and the top p times. A slightly mistuned ratio makes the figure turn, once per
 * beat of the coinciding harmonics (harmonic p of X against harmonic q of Y). A complex
 * ratio never settles into a shape.
 *
 * The curves are rebuilt from the measured frequencies (and, optionally, the measured
 * partial levels) of the detected notes, so this works for the mono microphone, files
 * and chords alike. Partial phases are not measured, so the timbre option shows the
 * right frequencies and levels with arbitrary starting phases.
 *
 * Scope: a phosphor-style trace of the last few tens of milliseconds, in real time.
 * Harmonograph: a decaying trace over ~100 cycles, like the pendulum drawing machine.
 * Any mistuning shows up as a rosette instead of a single clean figure.
 */
(function (root) {
  'use strict';
  const U = root.HUI;
  const TAU = Math.PI * 2;
  const LINE = '#8fb4ff';

  /** Simplest ratio p:q (q ≤ 16, p ≤ 32) within 30¢ of r = fy/fx, or null. */
  function nearestRatio(r) {
    let best = null;
    for (let q = 1; q <= 16; q++) {
      const p = Math.round(r * q);
      if (p < 1 || p > 32) continue;
      const g = gcd(p, q);
      if (g > 1) continue; // reduced form found at a smaller q
      const dev = 1200 * Math.log2(r / (p / q));
      if (Math.abs(dev) < 30 && (!best || p * q < best.p * best.q)) best = { p, q, dev };
    }
    return best;
  }
  function gcd(a, b) { while (b) { [a, b] = [b, a % b]; } return a; }
  /** Phase of Y that draws the p:q figure symmetric about both axes (and never degenerate). */
  function symPhase(p, q) { return (p + q) % 2 ? 0 : Math.PI / (2 * q); }

  const view = {
    init(app) {
      this.app = app;
      this.cv = U.managedCanvas(document.getElementById('cvLissajous'));
      this.picker = document.getElementById('lissVoices');
      this.selStyle = document.getElementById('lissStyle');
      this.selSignal = document.getElementById('lissSignal');
      this.sel = []; // ids of the last two clicked notes
      this.phases = new Map(); // per-partial phase accumulators (radians)
      this.lastT = null;
      this.picker.addEventListener('click', e => {
        const b = e.target.closest('button[data-v]');
        if (!b) return;
        const id = b.dataset.v;
        this.sel = this.sel.filter(x => x !== id).concat(id).slice(-2);
        app.requestRender(); this.renderSlow(true);
      });
      for (const el of [this.selStyle, this.selSignal]) el.addEventListener('change', () => app.requestRender());
    },

    /** The one or two notes to plot, lower note first (X). */
    pair() {
      const voices = this.app.frame ? this.app.frame.voices : [];
      const chosen = this.sel.map(id => voices.find(v => String(v.id) === id)).filter(Boolean);
      for (const v of voices) { if (chosen.length >= 2) break; if (!chosen.includes(v)) chosen.push(v); }
      return chosen.sort((a, b) => a.f0 - b.f0);
    },

    /** Sinusoidal components of a note: [{key, f, amp}]. */
    components(v, maxH) {
      if (this.selSignal.value === 'pure') return [{ key: v.id + ':1', f: v.f0, amp: 1 }];
      const ref = Math.max(...v.harmonics.map(h => h.db));
      const out = v.harmonics.filter(h => h.h <= maxH && h.db - ref > -50)
        .map(h => ({ key: v.id + ':' + h.h, f: h.freq, amp: Math.pow(10, (h.db - ref) / 20) }));
      return out.length ? out : [{ key: v.id + ':1', f: v.f0, amp: 1 }];
    },

    /** Advance every partial's phase by the real elapsed time (not while frozen). */
    advance(comps) {
      const now = performance.now() / 1000;
      const dt = this.lastT == null || this.app.frozen ? 0 : Math.min(0.1, now - this.lastT);
      this.lastT = now;
      const keep = new Set();
      for (const c of comps) {
        keep.add(c.key);
        const ph = this.phases.has(c.key) ? this.phases.get(c.key) : Math.random() * TAU;
        this.phases.set(c.key, (ph + TAU * c.f * dt) % TAU);
        c.ph = this.phases.get(c.key);
      }
      for (const k of this.phases.keys()) if (!keep.has(k)) this.phases.delete(k);
    },

    render() {
      const app = this.app, ps = app.ps;
      const ctx = this.cv.begin(), W = this.cv.w, H = this.cv.h;
      const pair = this.pair();
      if (!pair.length) {
        ctx.fillStyle = U.C.text2; ctx.font = `13px ${U.SANS}`; ctx.textAlign = 'center';
        ctx.fillText('Play two notes (try Fifth, then Major 3rd, in the Tone Lab) to draw their Lissajous figure.', W / 2, H / 2);
        this.lastT = null;
        return;
      }
      const harmonograph = this.selStyle.value === 'harmonograph';
      const [vx, vy] = pair.length === 2 ? pair : [pair[0], null];
      const cx = this.components(vx, harmonograph ? 6 : 12);
      const cy = vy ? this.components(vy, harmonograph ? 6 : 12) : null;
      this.advance(cy ? cx.concat(cy) : cx);
      const ratio = vy ? nearestRatio(vy.f0 / vx.f0) : null;

      // layout: square plot, info to the right (or below on narrow screens)
      const wide = W >= 600;
      const S = Math.max(80, wide ? Math.min(H - 36, W - 290) : Math.min(W - 24, H - 120));
      const px = wide ? 28 : (W - S) / 2, py = wide ? (H - S) / 2 : 12;
      this.drawFrame(ctx, px, py, S, vx, vy);

      // sample the curve
      let pts;
      if (harmonograph) pts = this.harmonograph(cx, cy, vx.f0, ratio);
      else pts = this.scope(cx, cy, vx, ratio);
      // scale X and Y separately so the figure fills the box
      let mx = 1e-9, my = 1e-9;
      for (let i = 0; i < pts.length; i += 2) { mx = Math.max(mx, Math.abs(pts[i])); my = Math.max(my, Math.abs(pts[i + 1])); }
      const kx = (S / 2 - 6) / mx, ky = (S / 2 - 6) / my, ox = px + S / 2, oy = py + S / 2;
      ctx.lineJoin = 'round';
      if (harmonograph) {
        ctx.strokeStyle = U.hexA(LINE, 0.75); ctx.lineWidth = 0.8;
        ctx.beginPath();
        for (let i = 0; i < pts.length; i += 2) {
          const X = ox + pts[i] * kx, Y = oy - pts[i + 1] * ky;
          i ? ctx.lineTo(X, Y) : ctx.moveTo(X, Y);
        }
        ctx.stroke();
      } else {
        // phosphor: older parts of the trace fade out
        const n = pts.length / 2, chunks = 24, per = Math.ceil(n / chunks);
        ctx.lineWidth = 1.4;
        for (let c = 0; c < chunks; c++) {
          const i0 = c * per, i1 = Math.min(n - 1, (c + 1) * per);
          if (i1 <= i0) break;
          ctx.strokeStyle = U.hexA(LINE, 0.06 + 0.94 * Math.pow((c + 1) / chunks, 1.6));
          ctx.beginPath();
          ctx.moveTo(ox + pts[2 * i0] * kx, oy - pts[2 * i0 + 1] * ky);
          for (let i = i0 + 1; i <= i1; i++) ctx.lineTo(ox + pts[2 * i] * kx, oy - pts[2 * i + 1] * ky);
          ctx.stroke();
        }
      }
      ctx.lineWidth = 1;

      const ix = wide ? px + S + 28 : 16, iy = wide ? py + 4 : py + S + 14;
      this.drawInfo(ctx, ix, iy, W - ix - 12, vx, vy, ratio, wide, ps, harmonograph);
    },

    /** Real-time trace of the last few periods of the figure. Returns [x0,y0,x1,y1,…]. */
    scope(cx, cy, vx, ratio) {
      const g = ratio ? vx.f0 / ratio.q : vx.f0 / 16; // repetition rate of the closed figure
      const win = Math.max(0.02, Math.min(0.25, 2.5 / g));
      const all = cy ? cx.concat(cy) : cx;
      const fMax = Math.max(...all.map(c => c.f));
      const n = Math.round(Math.max(600, Math.min(12000, win * fMax * 40)));
      const out = new Float32Array(2 * n);
      // one note: plot it against itself a quarter period later (phase portrait)
      const lag = cy ? 0 : 1 / (4 * vx.f0);
      for (let i = 0; i < n; i++) {
        const t = -win + win * i / (n - 1);
        let x = 0, y = 0;
        for (const c of cx) {
          x += c.amp * Math.sin(c.ph + TAU * c.f * t);
          if (!cy) y += c.amp * Math.sin(c.ph + TAU * c.f * (t - lag));
        }
        if (cy) for (const c of cy) y += c.amp * Math.sin(c.ph + TAU * c.f * t);
        out[2 * i] = x; out[2 * i + 1] = y;
      }
      return out;
    },

    /** Decaying pendulum drawing over ~100 cycles of X, frequencies relative to X's f0. */
    harmonograph(cx, cy, f0, ratio) {
      const all = cy ? cx.concat(cy) : cx;
      const K = cy ? 120 : 40;
      const rMax = Math.max(...all.map(c => c.f / f0));
      const n = Math.round(Math.min(40000, Math.max(4000, K * 72 * rMax)));
      const T = TAU * K, d = Math.log(14) / T;
      // fixed starting phases so the drawing depends only on the ratio: a pure ratio
      // gives nested copies of the symmetric p:q figure, a mistuned one a rosette
      const phY = ratio ? symPhase(ratio.p, ratio.q) : Math.PI / 2;
      const rel = c => (cx.includes(c) ? 0 : phY);
      const out = new Float32Array(2 * n);
      for (let i = 0; i < n; i++) {
        const tau = T * i / (n - 1), e = Math.exp(-d * tau);
        let x = 0, y = 0;
        for (const c of cx) {
          const r = c.f / f0;
          x += c.amp * Math.sin(r * tau + rel(c));
          if (!cy) y += c.amp * Math.sin(r * (tau - Math.PI / 2) + rel(c));
        }
        if (cy) for (const c of cy) y += c.amp * Math.sin((c.f / f0) * tau + rel(c));
        out[2 * i] = x * e; out[2 * i + 1] = y * e;
      }
      return out;
    },

    drawFrame(ctx, px, py, S, vx, vy) {
      ctx.fillStyle = 'rgba(255,255,255,0.015)'; ctx.fillRect(px, py, S, S);
      ctx.strokeStyle = U.C.gridStrong; ctx.strokeRect(px + 0.5, py + 0.5, S - 1, S - 1);
      ctx.strokeStyle = U.C.grid;
      for (let i = 1; i < 4; i++) {
        const o = Math.round(S * i / 4) + 0.5;
        ctx.beginPath(); ctx.moveTo(px + o, py); ctx.lineTo(px + o, py + S); ctx.moveTo(px, py + o); ctx.lineTo(px + S, py + o); ctx.stroke();
      }
      const ps = this.app.ps;
      ctx.font = `600 11px ${U.SANS}`; ctx.textBaseline = 'top'; ctx.textAlign = 'center';
      ctx.fillStyle = vx.color;
      ctx.fillText('X: ' + ps.label(vx.f0).label, px + S / 2, py + S + 4);
      ctx.save(); ctx.translate(px - 16, py + S / 2); ctx.rotate(-Math.PI / 2);
      ctx.fillStyle = vy ? vy.color : vx.color;
      ctx.fillText(vy ? 'Y: ' + ps.label(vy.f0).label : 'Y: same, ¼ period later', 0, 0);
      ctx.restore();
    },

    drawInfo(ctx, x, y, w, vx, vy, ratio, wide, ps, harmonograph) {
      const lines = []; // [text, color, bold]
      if (!vy) {
        lines.push([`${ps.label(vx.f0).label} · ${U.fmtHz(vx.f0)} Hz`, vx.color, true]);
        lines.push(['One note, plotted against itself a quarter', U.C.text]);
        lines.push(['period later. A pure tone is a circle;', U.C.text]);
        lines.push(['overtones add loops. Add a second note.', U.C.text]);
      } else {
        const r = vy.f0 / vx.f0;
        lines.push([`${ps.label(vy.f0).label} / ${ps.label(vx.f0).label} = ${r.toFixed(5)}`, U.C.text, true]);
        if (!ratio) {
          lines.push(['No simple ratio: the curve never closes.', U.C.bad]);
        } else {
          const { p, q, dev } = ratio;
          const beat = Math.abs(p * vx.f0 - q * vy.f0);
          lines.push([`≈ ${p}:${q}  ${U.fmtCents(dev, 2)}`, Math.abs(dev) < 1 ? U.C.ok : U.C.warn, true]);
          lines.push([`Touches the sides ${q}×, the top ${p}×.`, U.C.text]);
          if (beat < 0.05) lines.push(['Stands still: the ratio is pure.', U.C.ok]);
          else if (beat < 25) {
            lines.push([`Turns once every ${beat < 1 ? (1 / beat).toFixed(1) + ' s' : (1000 / beat).toFixed(0) + ' ms'} (${beat.toFixed(2)} Hz),`, beat < 1.5 ? U.C.ok : U.C.warn]);
            lines.push([`the beat of harmonic ${p} of X with ${q} of Y.`, U.C.text2]);
          } else lines.push([`Churns at ${beat.toFixed(0)} Hz: too fast to hold a shape.`, U.C.bad]);
          if (p * q > 48) lines.push(['Complex ratio: a dense, tangled figure.', U.C.text2]);
        }
      }
      ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      let yy = y;
      for (const [t, c, b] of lines) {
        ctx.font = `${b ? '600 ' : ''}12px ${b ? U.MONO : U.SANS}`; ctx.fillStyle = c;
        ctx.fillText(t, x, yy, w); yy += b ? 18 : 16;
      }
      // inset: the pure p:q figure for comparison, in the same style as the main plot
      if (wide && ratio && ratio.p * ratio.q <= 48) {
        const s = Math.min(110, w - 10, this.cv.h - yy - 34);
        if (s < 50) return;
        const ix = x, iy = yy + 18;
        ctx.font = `11px ${U.SANS}`; ctx.fillStyle = U.C.text2;
        ctx.fillText(`Pure ${ratio.p}:${ratio.q}${harmonograph ? ' (harmonograph)' : ''}`, ix, iy - 15);
        ctx.strokeStyle = U.C.grid; ctx.strokeRect(ix + 0.5, iy + 0.5, s, s);
        const half = s / 2 - 5, cxp = ix + s / 2, cyp = iy + s / 2;
        ctx.beginPath();
        if (harmonograph) {
          const key = ratio.p + ':' + ratio.q;
          if (this._insetKey !== key) {
            this._insetKey = key;
            this._insetPts = this.harmonograph([{ f: ratio.q, amp: 1 }], [{ f: ratio.p, amp: 1 }], ratio.q, ratio);
          }
          const pts = this._insetPts;
          for (let i = 0; i < pts.length; i += 2) {
            const X = cxp + pts[i] * half, Y = cyp - pts[i + 1] * half;
            i ? ctx.lineTo(X, Y) : ctx.moveTo(X, Y);
          }
          ctx.strokeStyle = U.hexA(U.C.sa, 0.6); ctx.lineWidth = 0.6;
        } else {
          const N = 400, phi = symPhase(ratio.p, ratio.q);
          for (let i = 0; i <= N; i++) {
            const th = TAU * i / N;
            const X = cxp + Math.sin(ratio.q * th) * half, Y = cyp - Math.sin(ratio.p * th + phi) * half;
            i ? ctx.lineTo(X, Y) : ctx.moveTo(X, Y);
          }
          ctx.strokeStyle = U.hexA(U.C.sa, 0.9); ctx.lineWidth = 1.2;
        }
        ctx.stroke(); ctx.lineWidth = 1;
      }
    },

    renderSlow(force) {
      const app = this.app, ps = app.ps;
      const voices = app.frame ? app.frame.voices : [];
      const cur = new Set(this.pair().map(v => String(v.id)));
      const sig = voices.map(x => x.id + x.color + ps.etNote(x.f0).label).join('|') + [...cur].join(',');
      if (sig === this._pickSig && !force) return;
      this._pickSig = sig;
      this.picker.innerHTML = voices.length > 2 ? voices.map(x => {
        const on = cur.has(String(x.id));
        return `<button data-v="${x.id}" aria-pressed="${on}" style="${on ? `background:${x.color};border-color:${x.color}` : `color:${x.color}`}">${ps.etNote(x.f0).label}</button>`;
      }).join('') : '';
    },
  };

  view.nearestRatio = nearestRatio;
  (root.HViews = root.HViews || {}).lissajous = view;
})(typeof self !== 'undefined' ? self : this);
