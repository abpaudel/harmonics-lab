/*
 * Overtone overlap: each detected note gets a lane on a shared vertical log-frequency
 * axis showing its harmonic series. Partials of different notes that coincide are
 * joined in green (fusion — consonance); partials close enough to beat are joined by
 * a red band (roughness — dissonance) labelled with the beat rate.
 */
(function (root) {
  'use strict';
  const U = root.HUI, X = root.HDiss;

  const COINCIDE_CENTS = 6;

  /** Relations between partials of different voices. Exported for interval cards. */
  function relations(voices, maxHarm, sampleRate) {
    const rel = [];
    const parts = voices.map(v => {
      const ref = Math.max(...v.harmonics.map(h => h.db));
      return v.harmonics.filter(h => h.h <= maxHarm).map(h => ({ ...h, amp: Math.pow(10, (h.db - ref) / 20) }));
    });
    for (let a = 0; a < voices.length; a++) {
      for (let b = a + 1; b < voices.length; b++) {
        for (const pa of parts[a]) {
          for (const pb of parts[b]) {
            const c = 1200 * Math.log2(pb.freq / pa.freq);
            // the exact theoretical partials — merged peaks still beat at this rate
            const predicted = Math.abs(pa.h * voices[a].f0 - pb.h * voices[b].f0);
            const shared = pa.peakIndex === pb.peakIndex;
            if (shared || Math.abs(c) < COINCIDE_CENTS) {
              rel.push({ type: 'coincide', a, b, pa, pb, beat: predicted, cents: 1200 * Math.log2((pb.h * voices[b].f0) / (pa.h * voices[a].f0)) });
            } else {
              const d = X.pairRoughness(pa.freq, pa.amp, pb.freq, pb.amp);
              if (d > 0.03) rel.push({ type: 'rough', a, b, pa, pb, d, beat: Math.abs(pb.freq - pa.freq) });
            }
          }
        }
      }
    }
    return rel;
  }

  const view = {
    init(app) {
      this.app = app;
      this.cv = U.managedCanvas(document.getElementById('cvOverlap'));
    },

    render() {
      const app = this.app, s = app.settings, ps = app.ps;
      const ctx = this.cv.begin(), W = this.cv.w, H = this.cv.h;
      const voices = app.frame ? app.frame.voices : [];
      const AX = 58, T = 34, B = 14, RPAD = 12;
      if (!voices.length) {
        ctx.fillStyle = U.C.text2; ctx.font = `13px ${U.SANS}`; ctx.textAlign = 'center';
        ctx.fillText('Play two or more notes (or a chord in the Tone Lab) to see their overtones interlock.', W / 2, H / 2);
        return;
      }
      const f0min = Math.min(...voices.map(v => v.f0));
      const fTop = Math.min(app.sampleRate / 2, Math.max(...voices.map(v => v.f0)) * (s.maxHarm + 0.5), 12000);
      const sc = U.logScale(f0min / 1.06, fTop, H - B, T);
      const n = voices.length;
      const laneW = Math.min(320, (W - AX - RPAD - 90) / n);
      const laneX = i => AX + i * laneW;
      const tickMax = laneW * 0.55;

      // axis: semitone grid & note names
      const mLo = Math.ceil(ps.midi(sc.fMin)), mHi = Math.floor(ps.midi(fTop));
      const pxPerSemi = (H - T - B) / (12 * Math.log2(fTop / sc.fMin));
      const saPc = Math.round(ps.midi(ps.saFreq())) % 12;
      ctx.font = `10px ${U.MONO}`; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      for (let m = mLo; m <= mHi; m++) {
        const pc = ((m % 12) + 12) % 12;
        const y = Math.round(sc.to(ps.freqOfMidi(m))) + 0.5;
        const major = pc === 0 || (s.sargam && pc === saPc);
        if (!major && pxPerSemi < 9) continue;
        ctx.strokeStyle = major ? U.C.gridStrong : U.C.grid;
        ctx.beginPath(); ctx.moveTo(AX - 4, y); ctx.lineTo(AX + n * laneW, y); ctx.stroke();
        if (major || pxPerSemi > 11) {
          const et = ps.etNote(ps.freqOfMidi(m));
          ctx.fillStyle = pc === saPc && s.sargam ? U.C.sa : major ? U.C.text : U.C.text2;
          ctx.fillText(et.label, AX - 8, y);
        }
      }

      // lanes & partials
      const refs = voices.map(v => Math.max(...v.harmonics.map(h => h.db)));
      const tickLen = (v, h) => {
        const rel = Math.max(-60, h.db - refs[voices.indexOf(v)]);
        return 6 + (rel + 60) / 60 * (tickMax - 6);
      };
      voices.forEach((v, i) => {
        const x = laneX(i);
        ctx.fillStyle = 'rgba(255,255,255,0.018)'; ctx.fillRect(x + 4, T - 6, laneW - 8, H - T - B + 6);
        // header
        ctx.font = `600 13px ${U.SANS}`; ctx.fillStyle = v.color; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
        const lab = ps.label(v.f0);
        ctx.fillText(lab.label, x + 10, 16);
        const wl = ctx.measureText(lab.label).width;
        ctx.font = `10px ${U.MONO}`; ctx.fillStyle = U.C.text2;
        ctx.fillText(U.fmtHz(v.f0) + ' Hz', x + 14 + wl, 16);
        if (s.sargam && laneW > 120) U.drawSvara(ctx, lab.tuned, x + laneW - 22, 17, 12, U.C.sa, s.script);
        // theoretical positions (thin) for every harmonic, measured ones as bars
        const matched = new Map(v.harmonics.map(h => [h.h, h]));
        for (let h = 1; h <= s.maxHarm; h++) {
          const m = matched.get(h);
          const f = m ? m.freq : h * v.f0;
          if (f > fTop) break;
          const y = sc.to(f);
          const xs = x + 10;
          if (m) {
            ctx.fillStyle = v.color;
            ctx.fillRect(xs, y - 1.5, tickLen(v, m), 3);
          } else {
            ctx.fillStyle = U.hexA(v.color, 0.22);
            ctx.fillRect(xs, y - 0.5, 10, 1);
          }
          if (pxPerSemi * 12 * Math.log2((h + 1) / h) > 9) {
            ctx.font = `9.5px ${U.MONO}`; ctx.fillStyle = m ? U.hexA(v.color, 0.85) : U.hexA(v.color, 0.35);
            ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
            ctx.fillText(h, xs - 2, y);
          }
        }
      });

      // relations
      const rel = relations(voices, s.maxHarm, app.sampleRate);
      let nCo = 0, nRough = 0;
      const labelsPlaced = [];
      for (const r of rel) {
        const va = voices[r.a], vb = voices[r.b];
        const ya = sc.to(r.pa.freq), yb = sc.to(r.pb.freq);
        if (Math.min(ya, yb) < T - 4) continue;
        const xa = laneX(r.a) + 10 + tickLen(va, r.pa) + 3;
        const xb = laneX(r.b) + 8;
        if (r.type === 'coincide') {
          nCo++;
          ctx.strokeStyle = U.C.ok; ctx.lineWidth = 2.2;
          ctx.beginPath(); ctx.moveTo(xa, ya); ctx.lineTo(xb, yb); ctx.stroke(); ctx.lineWidth = 1;
          ctx.fillStyle = U.C.ok;
          ctx.beginPath(); ctx.arc(xa, ya, 2.5, 0, 7); ctx.arc(xb, yb, 2.5, 0, 7); ctx.fill();
          if (r.beat > 0.05) this._label(ctx, labelsPlaced, (xa + xb) / 2, (ya + yb) / 2 - 7, r.beat.toFixed(r.beat < 10 ? 2 : 1) + ' Hz', U.C.ok);
        } else {
          nRough++;
          if (r.d < 0.08) continue; // counted, but too weak to be worth drawing
          const a = Math.min(0.75, 0.15 + r.d * 0.8);
          ctx.fillStyle = `rgba(255,95,109,${a.toFixed(3)})`;
          ctx.beginPath(); ctx.moveTo(xa, ya - 1); ctx.lineTo(xb, yb - 1); ctx.lineTo(xb, yb + 1); ctx.lineTo(xa, ya + 1); ctx.closePath();
          ctx.fill();
          // zig-zag to suggest beating
          ctx.strokeStyle = `rgba(255,95,109,${Math.min(1, a + 0.2).toFixed(3)})`; ctx.lineWidth = 1.3;
          ctx.beginPath();
          const steps = Math.max(4, Math.floor((xb - xa) / 7));
          for (let k = 0; k <= steps; k++) {
            const t = k / steps, xx = xa + (xb - xa) * t, yy = ya + (yb - ya) * t + (k % 2 ? -2.5 : 2.5);
            k ? ctx.lineTo(xx, yy) : ctx.moveTo(xx, yy);
          }
          ctx.stroke(); ctx.lineWidth = 1;
          if (r.d > 0.2) this._label(ctx, labelsPlaced, (xa + xb) / 2, (ya + yb) / 2 - 7, r.beat.toFixed(1) + ' Hz beat', '#ff8a94');
        }
      }
      // summary
      ctx.font = `12px ${U.SANS}`; ctx.textAlign = 'right'; ctx.textBaseline = 'alphabetic';
      if (n > 1) {
        ctx.fillStyle = U.C.ok; ctx.fillText(`${nCo} coinciding`, W - RPAD, 16);
        ctx.fillStyle = '#ff8a94'; ctx.fillText(`${nRough} beating`, W - RPAD, 31);
      } else {
        ctx.fillStyle = U.C.text2; ctx.fillText('Add a second note to compare series', W - RPAD, 16);
      }
    },

    _label(ctx, placed, x, y, text, color) {
      ctx.font = `10px ${U.MONO}`;
      const w = ctx.measureText(text).width + 6, h = 13;
      const box = { x: x - w / 2, y: y - h / 2, w, h };
      if (placed.some(b => b.x < box.x + box.w && box.x < b.x + b.w && b.y < box.y + box.h && box.y < b.y + b.h)) return;
      placed.push(box);
      ctx.fillStyle = 'rgba(11,14,20,0.85)'; ctx.fillRect(box.x, box.y, w, h);
      ctx.fillStyle = color; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(text, x, y + 0.5);
    },
  };

  view.relations = relations;
  (root.HViews = root.HViews || {}).overlap = view;
})(typeof self !== 'undefined' ? self : this);
