/*
 * ui.js — shared drawing & formatting helpers for the views.
 */
(function (root) {
  'use strict';

  const VOICE_COLORS = ['#5fd4ff', '#ffb35c', '#c792ff', '#78e08f', '#ff7aa8', '#ffe066'];
  const PIN_COLOR = '#ffffff';
  const C = {
    grid: 'rgba(255,255,255,0.045)', gridStrong: 'rgba(255,255,255,0.11)', axis: '#6d7891', text: '#a5b0c4',
    text2: '#6d7891', spectrum: '#8fb4ff', ok: '#5ee39a', bad: '#ff5f6d', warn: '#ffcc66', sa: '#ffcc66',
  };
  const MONO = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace';
  const SANS = 'system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans", "Noto Sans Devanagari", sans-serif';

  /** HiDPI canvas that tracks its CSS size. Returns {canvas, ctx, w, h, dpr, dirty}. */
  function managedCanvas(canvas, onResize) {
    const m = { canvas, ctx: canvas.getContext('2d'), w: 0, h: 0, dpr: 1, dirty: true };
    const fit = () => {
      const r = canvas.getBoundingClientRect();
      const dpr = Math.min(root.devicePixelRatio || 1, 2.5);
      const w = Math.max(1, Math.round(r.width)), h = Math.max(1, Math.round(r.height));
      if (w === m.w && h === m.h && dpr === m.dpr) return;
      m.w = w; m.h = h; m.dpr = dpr;
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
      m.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      m.dirty = true;
      if (onResize) onResize(m);
    };
    if (root.ResizeObserver) new ResizeObserver(fit).observe(canvas);
    root.addEventListener('resize', fit);
    fit();
    m.fit = fit;
    m.begin = () => { fit(); m.ctx.setTransform(m.dpr, 0, 0, m.dpr, 0, 0); m.ctx.clearRect(0, 0, m.w, m.h); return m.ctx; };
    return m;
  }

  function fmtCents(c, digits = 1) {
    if (!isFinite(c)) return '';
    const v = c.toFixed(digits);
    if (Math.abs(c) < 0.5 * Math.pow(10, -digits)) return '±' + (0).toFixed(digits) + '¢';
    return (c > 0 ? '+' : '−') + Math.abs(c).toFixed(digits) + '¢';
  }
  function centsClass(c, tol = 3) { return Math.abs(c) <= tol ? 'cents-zero' : c > 0 ? 'cents-pos' : 'cents-neg'; }
  function fmtHz(f) { return f >= 1000 ? f.toFixed(1) : f >= 100 ? f.toFixed(2) : f.toFixed(3); }
  function esc(s) { return String(s).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch])); }

  /** HTML for a svara with komal underline, tivra mark and saptak dots. t = PitchSpace.tuned() result. */
  function svaraHTML(t, script) {
    const s = t.svara;
    const txt = script === 'deva' ? s.deva : s.latin;
    const cls = ['sv'];
    if (s.komal) cls.push('komal');
    if (s.tivra) cls.push('tivra');
    let dots = '';
    if (t.octave < 0) { cls.push('mandra'); dots = '•'.repeat(Math.min(2, -t.octave)); }
    if (t.octave > 0) { cls.push('taar'); dots = '•'.repeat(Math.min(2, t.octave)); }
    return `<span class="${cls.join(' ')}" data-dots="${dots}" title="${esc(s.full)}${t.octave ? (t.octave < 0 ? ' · mandra saptak' : ' · taar saptak') : ''}">${txt}</span>`;
  }

  /** Draw a svara on canvas, centred at x with baseline y. Returns its width. */
  function drawSvara(ctx, t, x, y, size, color, script) {
    const s = t.svara;
    const txt = script === 'deva' ? s.deva : s.latin;
    ctx.save();
    ctx.font = `600 ${size}px ${SANS}`;
    ctx.fillStyle = color; ctx.strokeStyle = color;
    ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    const w = ctx.measureText(txt).width;
    ctx.fillText(txt, x, y);
    ctx.lineWidth = Math.max(1, size / 10);
    if (s.komal) { ctx.beginPath(); ctx.moveTo(x - w / 2, y + size * 0.2); ctx.lineTo(x + w / 2, y + size * 0.2); ctx.stroke(); }
    if (s.tivra) { ctx.beginPath(); ctx.moveTo(x, y - size * 0.82); ctx.lineTo(x, y - size * 1.12); ctx.stroke(); }
    const dots = Math.min(2, Math.abs(t.octave));
    if (dots) {
      const dy = t.octave < 0 ? y + size * (s.komal ? 0.48 : 0.36) : y - size * (s.tivra ? 1.3 : 0.98);
      for (let i = 0; i < dots; i++) {
        ctx.beginPath(); ctx.arc(x + (i - (dots - 1) / 2) * size * 0.32, dy, size * 0.09, 0, Math.PI * 2); ctx.fill();
      }
    }
    ctx.restore();
    return w;
  }

  /** Logarithmic frequency mapping helper. */
  function logScale(fMin, fMax, p0, p1) {
    const l0 = Math.log2(fMin), l1 = Math.log2(fMax);
    return {
      fMin, fMax,
      to: f => p0 + (Math.log2(f) - l0) / (l1 - l0) * (p1 - p0),
      from: p => Math.pow(2, l0 + (p - p0) / (p1 - p0) * (l1 - l0)),
    };
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }

  function hexA(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},${a})`;
  }

  root.HUI = { VOICE_COLORS, PIN_COLOR, C, MONO, SANS, managedCanvas, fmtCents, centsClass, fmtHz, esc, svaraHTML, drawSvara, logScale, roundRect, hexA };
})(typeof self !== 'undefined' ? self : this);
