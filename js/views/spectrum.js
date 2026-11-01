/*
 * Spectrum view: log-frequency spectrum with note grid, piano strip, labelled peaks,
 * harmonic combs per detected note, tuning ticks and a roughness band.
 */
(function (root) {
  'use strict';
  const U = root.HUI;

  const LEFT = 40, RIGHT = 10, PIANO_H = 22, AXIS_H = 15, ROUGH_H = 9, COMB_ROW = 15;

  const view = {
    init(app) {
      this.app = app;
      this.cv = U.managedCanvas(document.getElementById('cvSpectrum'));
      this.tooltip = document.getElementById('tooltip');
      this.view = null; // {fMin,fMax} zoom state; null = settings range
      this.mouse = null;
      this._bindInteraction();
    },

    range() {
      const s = this.app.settings;
      return this.view || { fMin: s.fMin, fMax: s.fMax };
    },

    _bindInteraction() {
      const c = this.cv.canvas;
      let drag = null;
      c.addEventListener('wheel', e => {
        e.preventDefault();
        const { fMin, fMax } = this.range();
        const sc = U.logScale(fMin, fMax, LEFT, this.cv.w - RIGHT);
        const fc = sc.from(e.offsetX);
        const k = Math.exp(e.deltaY * 0.0015);
        const l0 = Math.log2(fc) + (Math.log2(fMin) - Math.log2(fc)) * k;
        const l1 = Math.log2(fc) + (Math.log2(fMax) - Math.log2(fc)) * k;
        this._setView(Math.pow(2, l0), Math.pow(2, l1));
      }, { passive: false });
      c.addEventListener('pointerdown', e => {
        drag = { x: e.offsetX, r: this.range(), moved: false };
        c.setPointerCapture(e.pointerId);
      });
      c.addEventListener('pointermove', e => {
        this.mouse = { x: e.offsetX, y: e.offsetY };
        if (drag) {
          const dx = e.offsetX - drag.x;
          if (Math.abs(dx) > 3) drag.moved = true;
          if (drag.moved) {
            const span = Math.log2(drag.r.fMax / drag.r.fMin);
            const shift = -dx / (this.cv.w - LEFT - RIGHT) * span;
            this._setView(drag.r.fMin * Math.pow(2, shift), drag.r.fMax * Math.pow(2, shift));
          }
        }
        this.app.requestRender();
      });
      c.addEventListener('pointerup', e => {
        if (drag && !drag.moved) this._click(e);
        drag = null;
      });
      c.addEventListener('pointerleave', () => { this.mouse = null; this.tooltip.hidden = true; this.app.requestRender(); });
      c.addEventListener('dblclick', () => { this.view = null; this.app.requestRender(); });
    },

    _setView(a, b) {
      const nyq = this.app.sampleRate / 2;
      a = Math.max(20, a); b = Math.min(nyq, b);
      if (Math.log2(b / a) < 0.25) return; // at least a minor third span
      this.view = { fMin: a, fMax: b };
      this.app.requestRender();
    },

    _click(e) {
      const f = this.app.frame;
      if (!f || !f.result) return;
      const { fMin, fMax } = this.range();
      const sc = U.logScale(fMin, fMax, LEFT, this.cv.w - RIGHT);
      let best = null, bd = 10;
      for (const p of f.result.peaks) {
        const d = Math.abs(sc.to(p.freq) - e.offsetX);
        if (d < bd) { bd = d; best = p; }
      }
      const freq = best ? best.freq : (e.shiftKey ? sc.from(e.offsetX) : null);
      if (freq) this.app.togglePin(freq);
    },

    render() {
      const app = this.app, s = app.settings, cv = this.cv, ctx = cv.begin();
      const W = cv.w, H = cv.h, frame = app.frame, ps = app.ps;
      const { fMin, fMax } = this.range();
      const x0 = LEFT, x1 = W - RIGHT;
      const sc = U.logScale(fMin, fMax, x0, x1);
      const voices = frame ? frame.voices : [];
      const combRows = Math.max(1, voices.length);
      const yTop = 6 + combRows * COMB_ROW + (s.tunedTicks ? (s.sargam ? 28 : 16) : 8); // room for combs + tuning ticks
      const yBot = H - PIANO_H - AXIS_H - (s.roughStrip ? ROUGH_H + 3 : 0) - 2;
      const dbMin = s.dbMin, dbMax = 0;
      const yOf = db => yBot - (Math.max(dbMin, Math.min(dbMax, db)) - dbMin) / (dbMax - dbMin) * (yBot - yTop);

      // ---- grid: semitones, octave C lines, Sa lines
      const pxPerSemi = (x1 - x0) / (12 * Math.log2(fMax / fMin));
      const mLo = Math.ceil(ps.midi(fMin)), mHi = Math.floor(ps.midi(fMax));
      const saPc = Math.round(ps.midi(ps.saFreq())) % 12;
      for (let m = mLo; m <= mHi; m++) {
        const pc = ((m % 12) + 12) % 12;
        const x = Math.round(sc.to(ps.freqOfMidi(m))) + 0.5;
        if (pc !== 0 && pc !== saPc && pxPerSemi < 7) continue;
        ctx.strokeStyle = pc === saPc && s.sargam ? 'rgba(255,204,102,0.16)' : pc === 0 ? U.C.gridStrong : U.C.grid;
        ctx.beginPath(); ctx.moveTo(x, yTop); ctx.lineTo(x, yBot); ctx.stroke();
      }
      // dB grid
      ctx.font = `10px ${U.MONO}`; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      for (let db = 0; db >= dbMin; db -= 20) {
        const y = Math.round(yOf(db)) + 0.5;
        ctx.strokeStyle = U.C.grid; ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke();
        ctx.fillStyle = U.C.text2; ctx.fillText(db === 0 ? '0 dB' : db, x0 - 5, y);
      }

      // ---- tuning degree ticks (where the chosen tuning puts each svara)
      if (s.tunedTicks) this._drawTuningTicks(ctx, sc, yTop, yBot, x0, x1);

      if (frame && frame.result) {
        this._drawSpectrum(ctx, frame.result, frame.displayDb, sc, yOf, x0, x1, yBot);
        this._drawCombs(ctx, frame, sc, yOf, x0, x1, yTop);
        this._drawPeaks(ctx, frame, sc, yOf, x0, x1, yTop);
        if (s.roughStrip) this._drawRoughStrip(ctx, frame, sc, x0, x1, yBot + 3);
      }

      this._drawPiano(ctx, sc, x0, x1, H - PIANO_H - AXIS_H, voices);
      this._drawHzAxis(ctx, sc, x0, x1, H - AXIS_H);
      this._drawHover(ctx, sc, yOf, x0, x1, yTop, yBot);
    },

    _drawTuningTicks(ctx, sc, yTop, yBot, x0, x1) {
      const app = this.app, ps = app.ps, s = app.settings;
      const { fMin, fMax } = this.range();
      const sa = ps.saFreq();
      const oLo = Math.floor(Math.log2(fMin / sa)) - 1, oHi = Math.ceil(Math.log2(fMax / sa));
      const pxPerOct = (x1 - x0) / Math.log2(fMax / fMin);
      ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
      for (let o = oLo; o <= oHi; o++) {
        for (let st = 0; st < 12; st++) {
          const f = ps.degreeFreq(st, o);
          if (f < fMin || f > fMax) continue;
          const x = sc.to(f);
          const isSa = st === 0, isPa = st === 7;
          if (pxPerOct < 150 && !isSa && !(isPa && pxPerOct > 70)) continue; // too crowded
          ctx.fillStyle = isSa ? U.C.sa : 'rgba(255,204,102,0.55)';
          ctx.beginPath(); ctx.moveTo(x - 3, yTop - 9); ctx.lineTo(x + 3, yTop - 9); ctx.lineTo(x, yTop - 3); ctx.closePath(); ctx.fill();
          if (s.sargam && (pxPerOct > 360 || ((isSa || isPa) && pxPerOct > 90) || (isSa && pxPerOct > 40))) {
            U.drawSvara(ctx, { svara: root.HMusic.SVARAS[st], octave: o }, x, yTop - 12, 10, isSa ? U.C.sa : 'rgba(255,204,102,0.75)', s.script);
          }
          if (isSa) {
            ctx.strokeStyle = 'rgba(255,204,102,0.28)'; ctx.setLineDash([2, 4]);
            ctx.beginPath(); ctx.moveTo(Math.round(x) + 0.5, yTop - 3); ctx.lineTo(Math.round(x) + 0.5, yBot); ctx.stroke();
            ctx.setLineDash([]);
          }
        }
      }
    },

    _drawSpectrum(ctx, r, db, sc, yOf, x0, x1, yBot) {
      const binHz = r.binHz, n = db.length;
      const pts = [];
      for (let px = x0; px <= x1; px++) {
        const fa = sc.from(px - 0.5), fb = sc.from(px + 0.5);
        const ka = fa / binHz, kb = fb / binHz;
        let v;
        if (kb - ka < 1) {
          const k = (fa + fb) / 2 / binHz, k0 = Math.floor(k), t = k - k0;
          if (k0 + 1 >= n) break;
          v = db[k0] * (1 - t) + db[k0 + 1] * t;
        } else {
          v = -Infinity;
          for (let k = Math.max(0, Math.floor(ka)); k <= Math.min(n - 1, Math.ceil(kb)); k++) if (db[k] > v) v = db[k];
        }
        pts.push(px, yOf(v));
      }
      const grad = ctx.createLinearGradient(0, yOf(0), 0, yBot);
      grad.addColorStop(0, 'rgba(120,170,255,0.38)'); grad.addColorStop(1, 'rgba(120,170,255,0.02)');
      ctx.beginPath(); ctx.moveTo(pts[0], yBot);
      for (let i = 0; i < pts.length; i += 2) ctx.lineTo(pts[i], pts[i + 1]);
      ctx.lineTo(pts[pts.length - 2], yBot); ctx.closePath();
      ctx.fillStyle = grad; ctx.fill();
      ctx.beginPath();
      for (let i = 0; i < pts.length; i += 2) i ? ctx.lineTo(pts[i], pts[i + 1]) : ctx.moveTo(pts[i], pts[i + 1]);
      ctx.strokeStyle = U.C.spectrum; ctx.lineWidth = 1.2; ctx.stroke(); ctx.lineWidth = 1;

      // detection threshold (local floor + threshold), faint dotted
      const fl = r.floor, th = this.app.settings.thresh;
      ctx.beginPath();
      for (let px = x0, first = true; px <= x1; px += 3) {
        const k = Math.round(sc.from(px) / binHz);
        if (k >= fl.length) break;
        const y = yOf(fl[k] + th);
        first ? ctx.moveTo(px, y) : ctx.lineTo(px, y); first = false;
      }
      ctx.setLineDash([1, 3]); ctx.strokeStyle = 'rgba(255,255,255,0.18)'; ctx.stroke(); ctx.setLineDash([]);
    },

    _drawCombs(ctx, frame, sc, yOf, x0, x1, yTop) {
      const s = this.app.settings, peaks = frame.result.peaks;
      frame.voices.forEach((v, row) => {
        const col = v.color, y = 6 + row * COMB_ROW + 9;
        // row label
        ctx.font = `600 10px ${U.SANS}`; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
        const matched = new Map(v.harmonics.map(h => [h.h, h]));
        for (let h = 1; h <= s.maxHarm; h++) {
          const m = matched.get(h);
          const f = m ? m.freq : h * v.f0;
          if (f < sc.fMin || f > sc.fMax) continue;
          const x = sc.to(f);
          // spacing to the neighbouring harmonic decides between numbered badge and dot
          const roomy = sc.to((h + 1) * v.f0) - sc.to(h * v.f0) >= 15 && x - sc.to((h - 1 || 0.5) * v.f0) >= 15;
          if (!roomy) {
            if (m) {
              const p = peaks[m.peakIndex];
              ctx.strokeStyle = U.hexA(col, 0.35); ctx.setLineDash([2, 4]);
              ctx.beginPath(); ctx.moveTo(x, y + 4); ctx.lineTo(x, yOf(p ? p.db : m.db) - 4); ctx.stroke(); ctx.setLineDash([]);
            }
            ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2);
            if (m) { ctx.fillStyle = col; ctx.fill(); } else { ctx.strokeStyle = U.hexA(col, 0.45); ctx.stroke(); }
            continue;
          }
          if (m) {
            const p = peaks[m.peakIndex];
            ctx.strokeStyle = U.hexA(col, 0.5); ctx.setLineDash([3, 3]);
            ctx.beginPath(); ctx.moveTo(x, y + 6); ctx.lineTo(x, yOf(p ? p.db : m.db) - 4); ctx.stroke(); ctx.setLineDash([]);
            ctx.fillStyle = col;
            U.roundRect(ctx, x - 7, y - 6, 14, 12, 3); ctx.fill();
            ctx.fillStyle = '#0b0e14'; ctx.textAlign = 'center';
            ctx.fillText(h, x, y + 0.5);
          } else {
            ctx.strokeStyle = U.hexA(col, 0.45);
            U.roundRect(ctx, x - 6.5, y - 5.5, 13, 11, 3); ctx.stroke();
            ctx.fillStyle = U.hexA(col, 0.55); ctx.textAlign = 'center';
            ctx.fillText(h, x, y + 0.5);
          }
        }
      });
    },

    _drawPeaks(ctx, frame, sc, yOf, x0, x1, yTop) {
      const app = this.app, s = app.settings, ps = app.ps, peaks = frame.result.peaks;
      // owners: which voices claim each peak
      const owners = new Map();
      frame.voices.forEach(v => v.harmonics.forEach(h => {
        if (!owners.has(h.peakIndex)) owners.set(h.peakIndex, []);
        owners.get(h.peakIndex).push({ v, h: h.h });
      }));
      // markers
      peaks.forEach((p, i) => {
        if (p.freq < sc.fMin || p.freq > sc.fMax) return;
        const x = sc.to(p.freq), y = yOf(p.db);
        const own = owners.get(i);
        ctx.beginPath(); ctx.arc(x, y, own ? 3.4 : 2.4, 0, Math.PI * 2);
        ctx.fillStyle = own ? own[0].v.color : 'rgba(220,230,255,0.75)'; ctx.fill();
        if (own && own.length > 1) { // shared partial: coincidence
          ctx.beginPath(); ctx.arc(x, y, 7, 0, Math.PI * 2);
          ctx.strokeStyle = U.C.ok; ctx.lineWidth = 1.6; ctx.stroke(); ctx.lineWidth = 1;
        }
      });
      // labels with greedy collision avoidance; priority: low harmonics of voices, then loudness
      const order = peaks.map((p, i) => i).filter(i => peaks[i].freq >= sc.fMin && peaks[i].freq <= sc.fMax);
      const prio = i => { const o = owners.get(i); return (o ? 100 - Math.min(...o.map(q => q.h)) * 4 : 0) + peaks[i].db * 0.5; };
      order.sort((a, b) => prio(b) - prio(a));
      const placed = [];
      const maxLabels = Math.max(6, Math.floor((x1 - x0) / 46));
      let count = 0;
      for (const i of order) {
        if (count >= maxLabels) break;
        const p = peaks[i], x = sc.to(p.freq), yPeak = yOf(p.db);
        const L = ps.label(p.freq), t = L.tuned;
        const l1 = L.label, l2 = U.fmtCents(t.cents, 0);
        ctx.font = `600 11px ${U.SANS}`;
        const w1 = ctx.measureText(l1).width;
        ctx.font = `10px ${U.MONO}`;
        const w2 = ctx.measureText(l2).width;
        const bw = Math.max(w1, w2, s.sargam ? 18 : 0) + 6;
        const bh = s.sargam ? 38 : 25;
        let y = yPeak - 8 - bh, ok = false;
        for (let tries = 0; tries < 6; tries++) {
          const box = { x: x - bw / 2, y, w: bw, h: bh };
          if (box.y >= yTop && !placed.some(b => b.x < box.x + box.w && box.x < b.x + b.w && b.y < box.y + box.h && box.y < b.y + b.h)) { ok = true; placed.push(box); break; }
          y -= bh * 0.55;
          if (y < yTop) break;
        }
        if (!ok) continue;
        count++;
        const own = owners.get(i);
        const col = own ? own[0].v.color : '#dfe6f3';
        if (y + bh < yPeak - 10) {
          ctx.strokeStyle = U.hexA(col.length === 7 ? col : '#dfe6f3', 0.25);
          ctx.beginPath(); ctx.moveTo(x, y + bh); ctx.lineTo(x, yPeak - 5); ctx.stroke();
        }
        ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
        ctx.font = `600 11px ${U.SANS}`; ctx.fillStyle = col;
        ctx.fillText(l1, x, y + 11);
        ctx.font = `10px ${U.MONO}`; ctx.fillStyle = Math.abs(t.cents) < 3 ? U.C.ok : U.C.text;
        ctx.fillText(l2, x, y + 22);
        if (s.sargam) U.drawSvara(ctx, t, x, y + 35, 11, U.C.sa, s.script);
      }
    },

    _drawRoughStrip(ctx, frame, sc, x0, x1, y) {
      const w = x1 - x0, acc = new Float32Array(Math.ceil(w) + 1);
      const peaks = frame.result.peaks;
      for (const pr of frame.roughPairs) {
        const a = peaks[pr.i], b = peaks[pr.j];
        const xa = sc.to(a.freq) - x0, xb = sc.to(b.freq) - x0;
        const lo = Math.max(0, Math.floor(Math.min(xa, xb)) - 1), hi = Math.min(acc.length - 1, Math.ceil(Math.max(xa, xb)) + 1);
        for (let k = lo; k <= hi; k++) acc[k] += pr.d;
      }
      ctx.fillStyle = 'rgba(255,255,255,0.03)'; ctx.fillRect(x0, y, w, ROUGH_H);
      for (let k = 0; k < acc.length; k++) {
        if (acc[k] <= 0.002) continue;
        const a = Math.min(1, Math.sqrt(acc[k] / 0.25));
        ctx.fillStyle = `rgba(255,95,109,${a.toFixed(3)})`;
        ctx.fillRect(x0 + k, y, 1, ROUGH_H);
      }
      ctx.font = `9px ${U.SANS}`; ctx.fillStyle = U.C.text2; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      ctx.fillText('rough', x0 - 5, y + ROUGH_H / 2);
    },

    _drawPiano(ctx, sc, x0, x1, y, voices) {
      const ps = this.app.ps;
      const { fMin, fMax } = this.range();
      const mLo = Math.floor(ps.midi(fMin)) - 1, mHi = Math.ceil(ps.midi(fMax)) + 1;
      const isBlack = pc => [1, 3, 6, 8, 10].includes(pc);
      const hot = new Map();
      voices.forEach(v => { const n = ps.etNote(v.f0); if (!hot.has(n.midi)) hot.set(n.midi, v.color); });
      ctx.save();
      ctx.beginPath(); ctx.rect(x0, y, x1 - x0, PIANO_H); ctx.clip();
      const edges = m => [sc.to(ps.freqOfMidi(m - 0.5)), sc.to(ps.freqOfMidi(m + 0.5))];
      for (let m = mLo; m <= mHi; m++) {
        const pc = ((m % 12) + 12) % 12;
        const [a, b] = edges(m);
        ctx.fillStyle = hot.get(m) || (isBlack(pc) ? '#1b2130' : '#cfd6e2');
        ctx.fillRect(a + 0.5, y, Math.max(0.5, b - a - 1), PIANO_H);
        if (pc === 0 && b - a > 3) {
          ctx.fillStyle = hot.get(m) ? '#0b0e14' : '#46506a';
          ctx.font = `600 9px ${U.SANS}`; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
          ctx.fillText('C' + (Math.floor(m / 12) - 1), a + 2, y + PIANO_H - 2);
        }
      }
      ctx.restore();
    },

    _drawHzAxis(ctx, sc, x0, x1, y) {
      const ticks = [20, 30, 50, 100, 200, 300, 500, 1000, 2000, 3000, 5000, 10000, 20000];
      ctx.font = `10px ${U.MONO}`; ctx.fillStyle = U.C.text2; ctx.textBaseline = 'top'; ctx.textAlign = 'center';
      for (const f of ticks) {
        if (f < sc.fMin || f > sc.fMax) continue;
        const x = sc.to(f);
        ctx.fillRect(Math.round(x), y, 1, 3);
        ctx.fillText(f >= 1000 ? f / 1000 + 'k' : f, x, y + 3);
      }
      ctx.textAlign = 'right';
      ctx.fillText('Hz', x0 - 5, y + 3);
    },

    _drawHover(ctx, sc, yOf, x0, x1, yTop, yBot) {
      const tt = this.tooltip, m = this.mouse, app = this.app;
      if (!m || m.x < x0 || m.x > x1) { tt.hidden = true; return; }
      const frame = app.frame, ps = app.ps, s = app.settings;
      let f = sc.from(m.x), peak = null, pi = -1;
      if (frame && frame.result) {
        let bd = 8;
        frame.result.peaks.forEach((p, i) => { const d = Math.abs(sc.to(p.freq) - m.x); if (d < bd) { bd = d; peak = p; pi = i; } });
      }
      if (peak) f = peak.freq;
      const x = sc.to(f);
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx.beginPath(); ctx.moveTo(Math.round(x) + 0.5, yTop); ctx.lineTo(Math.round(x) + 0.5, yBot); ctx.stroke();
      const et = ps.etNote(f), t = ps.tuned(f), sh = ps.shruti(f);
      const lines = [];
      lines.push(`<b>${U.fmtHz(f)} Hz</b>${peak ? ` <span class="dim">· ${peak.db.toFixed(1)} dBFS</span>` : ' <span class="dim">(cursor)</span>'}`);
      lines.push(`${et.label} ${U.fmtCents(et.cents, 2)} <span class="dim">vs 12-TET</span>`);
      if (s.tuning !== 'et') lines.push(`${ps.label(f).label} ${U.fmtCents(t.cents, 2)} <span class="dim">vs ${root.HMusic.TUNINGS[s.tuning].short}${t.ratio ? ' ' + root.HMusic.ratioText(t.ratio) : ''}</span>`);
      if (s.sargam) {
        lines.push(`${U.svaraHTML(t, s.script)} <span class="dim">${t.svara.full}</span> ${s.tuning === 'et' ? U.fmtCents(t.cents, 1) : ''}`);
        lines.push(`<span class="dim">shruti ${sh.shruti.index} (${root.HMusic.ratioText(sh.shruti.ratio)}) ${U.fmtCents(sh.cents, 1)}</span>`);
      }
      if (peak && frame) {
        frame.voices.forEach(v => v.harmonics.forEach(h => {
          if (h.peakIndex === pi) lines.push(`<span style="color:${v.color}">harmonic ${h.h} of ${ps.etNote(v.f0).label}</span> <span class="dim">${U.fmtCents(h.dev, 2)} from ${h.h}×f₀</span>`);
        }));
      }
      tt.innerHTML = lines.join('<br>');
      tt.hidden = false;
      const wrap = tt.parentElement.getBoundingClientRect();
      const tw = tt.offsetWidth, th = tt.offsetHeight;
      let left = m.x + 14; if (left + tw > wrap.width - 4) left = m.x - tw - 14;
      let top = m.y + 14; if (top + th > wrap.height - 4) top = m.y - th - 10;
      tt.style.left = Math.max(4, left) + 'px'; tt.style.top = Math.max(4, top) + 'px';
    },
  };

  (root.HViews = root.HViews || {}).spectrum = view;
})(typeof self !== 'undefined' ? self : this);
