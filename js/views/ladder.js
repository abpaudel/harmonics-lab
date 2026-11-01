/*
 * Harmonic ladder: the partials of one detected note as bars (h = 1..N) plus a table
 * that relates every harmonic to the nearest note, the tuning, sargam and the exact
 * multiple n·f0.
 */
(function (root) {
  'use strict';
  const U = root.HUI, M = root.HMusic;
  const SHORT = ['U', 'm2', 'M2', 'm3', 'M3', 'P4', 'TT', 'P5', 'm6', 'M6', 'm7', 'M7'];

  function intervalShort(h) {
    if (h === 1) return 'f₀';
    const d = M.describeHarmonic(h);
    const semis = Math.round(d.reducedCents / 100) % 12;
    if (semis === 0) return '8ve';
    return SHORT[semis];
  }
  function intervalLong(h) {
    if (h === 1) return 'fundamental';
    const d = M.describeHarmonic(h);
    const semis = Math.round(d.reducedCents / 100);
    const oct = d.octaves + (semis === 12 ? 1 : 0);
    const base = semis % 12 === 0 ? '' : ['', 'min 2nd', 'maj 2nd', 'min 3rd', 'maj 3rd', 'perf 4th', 'tritone', 'perf 5th', 'min 6th', 'maj 6th', 'min 7th', 'maj 7th'][semis % 12];
    const o = oct === 1 ? '8ve' : oct + ' 8ves';
    return base ? `${o} + ${base}` : o;
  }

  const view = {
    init(app) {
      this.app = app;
      this.cv = U.managedCanvas(document.getElementById('cvLadder'));
      this.table = document.getElementById('ladderTable');
      this.picker = document.getElementById('ladderVoices');
      this.selId = null; // follow a note by identity, not list position
      this.picker.addEventListener('click', e => {
        const b = e.target.closest('button[data-v]');
        if (b) { this.selId = b.dataset.v; app.requestRender(); this.renderSlow(true); }
      });
    },

    voice() {
      const v = this.app.frame ? this.app.frame.voices : [];
      if (!v.length) return null;
      return v.find(x => String(x.id) === this.selId) || v[0];
    },

    render() {
      const ctx = this.cv.begin(), W = this.cv.w, H = this.cv.h, s = this.app.settings;
      const v = this.voice();
      const L = 34, R = 8, T = 16, B = 44;
      const n = s.maxHarm;
      const slot = (W - L - R) / n;
      const yOf = db => T + (-db / 60) * (H - T - B);
      // grid
      ctx.font = `10px ${U.MONO}`; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      for (let db = 0; db >= -60; db -= 20) {
        const y = Math.round(yOf(db)) + 0.5;
        ctx.strokeStyle = U.C.grid; ctx.beginPath(); ctx.moveTo(L, y); ctx.lineTo(W - R, y); ctx.stroke();
        ctx.fillStyle = U.C.text2; ctx.fillText(db + '', L - 5, y);
      }
      ctx.save(); ctx.translate(10, (T + H - B) / 2); ctx.rotate(-Math.PI / 2); ctx.textAlign = 'center';
      ctx.fillText('dB rel. strongest', 0, 0); ctx.restore();

      if (!v) {
        ctx.fillStyle = U.C.text2; ctx.font = `13px ${U.SANS}`; ctx.textAlign = 'center';
        ctx.fillText('No note detected yet — play a sustained note.', W / 2, H / 2);
        return;
      }
      const matched = new Map(v.harmonics.map(h => [h.h, h]));
      const ref = Math.max(...v.harmonics.map(h => h.db));
      const ps = this.app.ps;
      for (let h = 1; h <= n; h++) {
        const xc = L + (h - 0.5) * slot, bw = Math.max(3, Math.min(26, slot * 0.62));
        const m = matched.get(h);
        // natural ET offset of the harmonic: colour hint
        if (m) {
          const rel = m.db - ref;
          const y = yOf(Math.max(-60, rel));
          const g = ctx.createLinearGradient(0, y, 0, H - B);
          g.addColorStop(0, v.color); g.addColorStop(1, U.hexA(v.color, 0.25));
          ctx.fillStyle = g;
          ctx.fillRect(xc - bw / 2, y, bw, H - B - y);
          if (slot > 22) {
            ctx.fillStyle = U.C.text; ctx.font = `9.5px ${U.MONO}`; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
            ctx.fillText(rel.toFixed(0), xc, y - 2);
          }
        } else {
          ctx.strokeStyle = 'rgba(255,255,255,0.12)'; ctx.setLineDash([2, 3]);
          ctx.strokeRect(xc - bw / 2 + 0.5, yOf(-60) - 6.5, bw - 1, 6);
          ctx.setLineDash([]);
        }
        // labels: h, interval, note
        ctx.textAlign = 'center'; ctx.textBaseline = 'top';
        ctx.font = `600 11px ${U.SANS}`; ctx.fillStyle = m ? v.color : U.C.text2;
        ctx.fillText(h, xc, H - B + 4);
        if (slot > 18) {
          ctx.font = `10px ${U.SANS}`; ctx.fillStyle = U.C.text2;
          ctx.fillText(intervalShort(h), xc, H - B + 17);
          const lab = ps.label(m ? m.freq : h * v.f0);
          ctx.fillStyle = m ? U.C.text : U.C.text2;
          if (slot > 26) ctx.fillText(lab.label, xc, H - B + 29);
        }
      }
    },

    renderSlow(force) {
      const app = this.app, s = app.settings, ps = app.ps;
      const voices = app.frame ? app.frame.voices : [];
      // picker
      const v = this.voice();
      const cur = v ? String(v.id) : '';
      const sig = voices.map(x => x.id + x.color + ps.etNote(x.f0).label).join('|') + cur;
      if (sig !== this._pickSig || force) {
        this._pickSig = sig;
        this.picker.innerHTML = voices.map(x => { const on = String(x.id) === cur; return `<button data-v="${x.id}" aria-pressed="${on}" style="${on ? `background:${x.color};border-color:${x.color}` : `color:${x.color}`}">${ps.etNote(x.f0).label}${x.pinned ? ' 📌' : ''}</button>`; }).join('');
      }
      if (!v) { this.table.innerHTML = '<tr><td class="l muted">No note detected.</td></tr>'; return; }
      const matched = new Map(v.harmonics.map(h => [h.h, h]));
      const ref = Math.max(...v.harmonics.map(h => h.db));
      const rows = [];
      rows.push(`<tr><th>n</th><th class="l">Interval above f₀</th><th>Ratio</th><th title="The harmonic's built-in offset from the nearest equal-tempered note">Natural ¢ vs ET</th>
        <th>n·f₀ (Hz)</th><th>Measured (Hz)</th><th title="Measured partial vs exact multiple: inharmonicity">Δ n·f₀</th><th class="l">Note</th><th>¢ vs ${M.TUNINGS[s.tuning].short}</th>${s.sargam ? '<th class="l">Svara</th>' : ''}<th>Level</th></tr>`);
      for (let h = 1; h <= s.maxHarm; h++) {
        const m = matched.get(h);
        const exp = h * v.f0;
        if (exp > app.sampleRate / 2) break;
        const d = M.describeHarmonic(h);
        const f = m ? m.freq : exp;
        const lab = ps.label(f);
        rows.push(`<tr class="${m ? '' : 'absent'}">
          <td style="color:${m ? v.color : ''}"><b>${h}</b></td>
          <td class="l">${intervalLong(h)}</td>
          <td>${d.ratioText}</td>
          <td class="${m ? U.centsClass(d.etDev, 2) : ''}">${U.fmtCents(d.etDev, 1)}</td>
          <td>${U.fmtHz(exp)}</td>
          <td>${m ? U.fmtHz(m.freq) : '—'}</td>
          <td class="${m ? U.centsClass(m.dev, 1) : ''}">${m ? U.fmtCents(m.dev, 2) : ''}</td>
          <td class="l">${lab.label}</td>
          <td class="${m ? U.centsClass(lab.cents, 3) : ''}">${U.fmtCents(lab.cents, 1)}</td>
          ${s.sargam ? `<td class="l">${U.svaraHTML(lab.tuned, s.script)}</td>` : ''}
          <td>${m ? (m.db - ref).toFixed(1) + ' dB' : 'absent'}</td></tr>`);
      }
      this.table.innerHTML = rows.join('');
    },
  };

  (root.HViews = root.HViews || {}).ladder = view;
})(typeof self !== 'undefined' ? self : this);
