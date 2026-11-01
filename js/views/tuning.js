/*
 * Tuning explorer: compares where each tuning system places the 12 degrees (cents
 * from Sa), the 22 shrutis, and where the natural harmonics fall inside one octave.
 */
(function (root) {
  'use strict';
  const U = root.HUI, M = root.HMusic;
  const ORDER = ['et', 'just', 'pythagorean', 'meantone', 'werckmeister', 'septimal'];

  function devColor(dev) {
    const a = Math.min(1, Math.abs(dev) / 25);
    if (Math.abs(dev) < 0.5) return '#5ee39a';
    return dev > 0 ? `rgba(255,179,92,${0.45 + 0.55 * a})` : `rgba(95,212,255,${0.45 + 0.55 * a})`;
  }

  const view = {
    init(app) {
      this.app = app;
      this.cv = U.managedCanvas(document.getElementById('cvTuning'));
      this.table = document.getElementById('tuningTable');
      this.about = document.getElementById('tuningAbout');
      this.table.addEventListener('click', e => {
        const td = e.target.closest('td.cell');
        if (td) app.demoInterval(td.dataset.tuning, +td.dataset.step);
      });
    },

    _degrees(key) {
      const ps = new M.PitchSpace({ ...this.app.psOptions(), tuning: key });
      return ps.activeDegrees();
    },

    render() {
      const app = this.app, s = app.settings;
      const ctx = this.cv.begin(), W = this.cv.w, H = this.cv.h;
      const L = 122, R = 16, T = 26;
      const rows = [...ORDER.map(k => ({ key: k, label: M.TUNINGS[k].short })), { key: 'shruti', label: '22 shrutis' }, { key: 'harm', label: 'Harmonics 1–32' }];
      const rowH = (H - T - 6) / rows.length;
      const xOf = c => L + c / 1200 * (W - L - R);
      // header: svaras at ET positions + ET grid
      for (let i = 0; i <= 12; i++) {
        const x = Math.round(xOf(i * 100)) + 0.5;
        ctx.strokeStyle = i % 12 === 0 ? U.C.gridStrong : U.C.grid;
        ctx.beginPath(); ctx.moveTo(x, T - 4); ctx.lineTo(x, H - 4); ctx.stroke();
        if (i < 12 || true) {
          const t = { svara: M.SVARAS[i % 12], octave: i === 12 ? 1 : 0 };
          if (s.sargam) U.drawSvara(ctx, t, x, T - 10, 11, U.C.sa, s.script);
          else {
            ctx.font = `600 11px ${U.SANS}`; ctx.fillStyle = U.C.text; ctx.textAlign = 'center';
            ctx.fillText(M.degreeNoteName(s.tonicPc, i, s.spell === 'flats'), x, T - 10);
          }
        }
      }
      rows.forEach((r, ri) => {
        const y = T + ri * rowH, yc = y + rowH / 2;
        const active = r.key === s.tuning;
        if (active) { ctx.fillStyle = 'rgba(95,212,255,0.07)'; ctx.fillRect(4, y + 1, W - 8, rowH - 2); }
        ctx.font = `${active ? 600 : 400} 11.5px ${U.SANS}`; ctx.fillStyle = active ? U.C.text : U.C.text2;
        ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
        ctx.fillText(r.label, 10, yc);
        ctx.strokeStyle = 'rgba(255,255,255,0.08)';
        ctx.beginPath(); ctx.moveTo(L, Math.round(yc) + 0.5); ctx.lineTo(W - R, Math.round(yc) + 0.5); ctx.stroke();
        let marks;
        if (r.key === 'shruti') marks = M.SHRUTIS.map(sh => ({ c: sh.cents, dev: sh.cents - Math.round(sh.cents / 100) * 100, lab: '' }));
        else if (r.key === 'harm') {
          marks = [];
          for (let h = 1; h <= 32; h++) {
            const d = M.describeHarmonic(h);
            const newPc = ![2, 4, 8, 16, 32].includes(h) && (h % 2 === 1);
            if (h > 1 && !newPc) continue; // even harmonics repeat lower ones an octave up
            marks.push({ c: d.reducedCents, dev: d.etDev, lab: h <= 15 || h === 17 || h === 19 ? String(h) : '', h });
          }
        } else marks = this._degrees(r.key).map(d => ({ c: d.cents, dev: d.cents - Math.round(d.cents / 100) * 100 }));
        for (const m of marks) {
          const x = xOf(m.c);
          ctx.fillStyle = devColor(m.dev);
          const hh = Math.min(rowH * 0.55, 14);
          ctx.fillRect(x - 1.5, yc - hh / 2, 3, hh);
          if (m.lab) {
            ctx.font = `9.5px ${U.MONO}`; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillStyle = U.C.text2;
            ctx.fillText(m.lab, x + 4, yc - hh / 2 + 2);
          }
        }
      });
    },

    renderSlow(force) {
      const app = this.app, s = app.settings;
      const sig = [s.tuning, s.tonicPc, s.sargam, s.script, s.spell, s.a4, s.saFine].join('|');
      if (sig === this._sig && !force) return;
      this._sig = sig;
      const cols = ORDER.map(k => ({ k, deg: this._degrees(k) }));
      const head = `<tr><th class="l">Svara</th><th class="l">Note</th>${cols.map(c => `<th class="${c.k === s.tuning ? 'active-col' : ''}" title="${U.esc(M.TUNINGS[c.k].name)}">${M.TUNINGS[c.k].short}</th>`).join('')}</tr>`;
      const ps = app.ps;
      const body = M.SVARAS.map((sv, i) => {
        const t = { svara: sv, octave: 0 };
        return `<tr><td class="l">${s.sargam ? U.svaraHTML(t, s.script) + ' <span class="muted">' + sv.full + '</span>' : sv.full}</td><td class="l">${M.degreeNoteName(s.tonicPc, i, s.spell === 'flats')}</td>` +
          cols.map(c => {
            const d = c.deg[i];
            const dev = d.cents - i * 100;
            const ratio = d.ratio ? M.ratioText(d.ratio) : '';
            const hz = ps.saFreq() * Math.pow(2, d.cents / 1200);
            return `<td class="cell ${c.k === s.tuning ? 'active-col' : ''}" data-tuning="${c.k}" data-step="${i}" title="${U.fmtHz(hz)} Hz (with current Sa) — click to hear Sa + this degree">
              ${d.cents.toFixed(1)}¢ ${ratio ? `<span class="muted">${ratio}</span>` : ''}<br><span class="${U.centsClass(dev, 0.5)}">${i === 0 ? '' : U.fmtCents(dev, 1)}</span></td>`;
          }).join('') + '</tr>';
      }).join('');
      this.table.innerHTML = head + body;
      const t = M.TUNINGS[s.tuning];
      this.about.innerHTML = `<div><b>${U.esc(t.name)}.</b> ${U.esc(t.about)}</div>` +
        `<div class="muted">22 shrutis: the classical Indian microtonal grid (ratios from 256/243 to 243/128). Harmonics row: where the odd harmonics land when folded into one octave — 3 → Pa, 5 → Ga, 7 → a low komal Ni, 11 → between Ma and tivra Ma, 13 → a high komal Dha.</div>`;
    },
  };

  (root.HViews = root.HViews || {}).tuning = view;
})(typeof self !== 'undefined' ? self : this);
