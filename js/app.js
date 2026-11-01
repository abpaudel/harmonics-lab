/*
 * app.js — wires audio → analysis → views, owns settings and UI state.
 */
(function (root) {
  'use strict';
  const D = root.HDSP, P = root.HPitch, M = root.HMusic, X = root.HDiss, A = root.HAudio, U = root.HUI, V = root.HViews;
  const $ = id => document.getElementById(id);

  const DEFAULTS = {
    fft: 16384, window: 'hann', thresh: 15, range: 60, gate: -70, poly: true, maxVoices: 4, minF0: 50, smooth: 0.5,
    fMin: 50, fMax: 6000, dbMin: -100, maxHarm: 16, spell: 'sharps', script: 'latin', saFine: 0,
    roughStrip: true, tunedTicks: true, tonicPc: 0, tuning: 'et', a4: 440, sargam: true, device: '',
    tlTimbre: 'saw', tlHarm: 12, tlInh: 0, tlOct: 0, tlMonitor: true,
  };
  const STORE = 'harmonics-lab-settings-v1';

  function loadSettings() {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(STORE) || '{}') || {}; } catch (e) { saved = {}; }
    const s = { ...DEFAULTS };
    for (const k of Object.keys(DEFAULTS)) if (k in saved && typeof saved[k] === typeof DEFAULTS[k]) s[k] = saved[k];
    return s;
  }
  function saveSettings(s) { try { localStorage.setItem(STORE, JSON.stringify(s)); } catch (e) { /* storage unavailable */ } }

  /* ------------------------------------------------------- Voice tracker */
  // Gives detected notes stable identities/colours across frames, with a little
  // hysteresis so a single dropped frame does not make cards flicker.
  class VoiceTracker {
    constructor() { this.tracks = []; this.nextId = 1; }
    update(raw) {
      const used = new Set();
      for (const t of this.tracks) t.matched = false;
      for (const v of raw) {
        let best = null, bd = 70;
        for (const t of this.tracks) {
          if (t.matched) continue;
          const d = Math.abs(1200 * Math.log2(v.f0 / t.voice.f0));
          if (d < bd) { bd = d; best = t; }
        }
        if (best) { best.voice = v; best.matched = true; best.seen++; best.missing = 0; }
        else this.tracks.push({ id: this.nextId++, voice: v, matched: true, seen: 1, missing: 0, color: null });
      }
      for (const t of this.tracks) {
        if (!t.matched) {
          t.missing++;
          // stale: keep showing briefly but detach from the (new) peak list
          t.voice = { ...t.voice, harmonics: t.voice.harmonics.map(h => ({ ...h, peakIndex: -1 })) };
        }
      }
      this.tracks = this.tracks.filter(t => t.missing <= 4);
      const shown = this.tracks.filter(t => t.seen >= 2);
      shown.forEach(t => { if (t.color) used.add(t.color); });
      shown.forEach(t => {
        if (!t.color) {
          t.color = U.VOICE_COLORS.find(c => !used.has(c)) || U.VOICE_COLORS[t.id % U.VOICE_COLORS.length];
          used.add(t.color);
        }
      });
      // release colours of hidden tracks
      this.tracks.filter(t => t.seen < 2).forEach(t => { t.color = null; });
      return shown.map(t => ({ ...t.voice, id: t.id, color: t.color, stale: t.missing > 0 })).sort((a, b) => a.f0 - b.f0);
    }
    clear() { this.tracks = []; }
  }

  /* ------------------------------------------------------------------ App */
  const app = {
    settings: loadSettings(),
    engine: new A.AudioEngine(),
    analyzer: null,
    frame: null,
    frozen: false,
    pins: [],
    tracker: new VoiceTracker(),
    roughHist: new Float32Array(600),
    roughEma: 0,
    activeTab: 'ladder',
    get sampleRate() { return this.engine.sampleRate; },

    psOptions() {
      const s = this.settings;
      return { a4: s.a4, tonicPc: s.tonicPc, tuning: s.tuning, tonicOffsetCents: s.saFine, flats: s.spell === 'flats', script: s.script };
    },
    updatePitchSpace() { this.ps = new M.PitchSpace(this.psOptions()); },

    configureAnalyzer() {
      const s = this.settings;
      this.analyzer = new D.Analyzer({ sampleRate: this.sampleRate, fftSize: s.fft, windowType: s.window });
      this.buf = new Float32Array(this.analyzer.samplesNeeded);
      this.displayDb = null;
      const bin = this.sampleRate / s.fft, dur = this.analyzer.samplesNeeded / this.sampleRate;
      $('resHint').textContent = `Bin spacing ${bin.toFixed(2)} Hz · window ${(s.fft / this.sampleRate * 1000).toFixed(0)} ms (+${(this.analyzer.hop / this.sampleRate * 1000).toFixed(0)} ms phase frame) · ${dur.toFixed(2)} s of audio per reading · sample rate ${this.sampleRate} Hz` + (this.engine.tapKind ? ` · capture: ${this.engine.tapKind}` : '');
    },

    requestRender() { this._needsRender = true; },

    sourcesActive() {
      const e = this.engine;
      return !!(e.mic || e.file || (e.toneLab && e.toneLab.notes.size));
    },

    togglePin(freq) {
      const i = this.pins.findIndex(p => Math.abs(1200 * Math.log2(p / freq)) < 30);
      if (i >= 0) this.pins.splice(i, 1);
      else { this.pins.push(freq); if (this.pins.length > 2) this.pins.shift(); }
      toast(i >= 0 ? 'Pinned series removed.' : `Pinned the harmonic series of ${U.fmtHz(freq)} Hz (white). Click the peak again to remove.`);
      this.requestRender();
    },

    /* --------------------------------------------------------- Analysis */
    analyse() {
      const s = this.settings, an = this.analyzer, e = this.engine;
      if (!an || an.sampleRate !== this.sampleRate) this.configureAnalyzer();
      this.engine.latest(this.analyzer.samplesNeeded, this.buf);
      const nyq = this.sampleRate / 2;
      const r = this.analyzer.process(this.buf, {
        minFreq: 25, maxFreq: Math.min(nyq * 0.95, Math.max(s.fMax * 1.05, 12000)),
        thresholdDb: s.thresh, rangeDb: s.range + 10, maxPeaks: 150,
      });
      const silent = r.rmsDb < s.gate || !this.sourcesActive();
      const peaks = silent ? [] : r.peaks;
      // display spectrum (smoothed copy)
      if (!this.displayDb || this.displayDb.length !== r.db.length) this.displayDb = Float32Array.from(r.db);
      else {
        const a = s.smooth, d = this.displayDb, src = r.db;
        for (let k = 0; k < d.length; k++) d[k] = a * d[k] + (1 - a) * src[k];
      }
      const raw = P.detectVoices(peaks, { polyphonic: s.poly, maxVoices: s.maxVoices, minF0: s.minF0, dynamicDb: s.range, maxHarmonics: Math.max(32, s.maxHarm) });
      let voices = this.tracker.update(raw);
      voices = voices.concat(this.pinnedVoices(peaks, voices));
      // roughness of the whole sound, amplitudes relative to the loudest partial
      let maxAmp = 0;
      for (const p of peaks) if (p.amp > maxAmp) maxAmp = p.amp;
      const parts = peaks.map(p => ({ freq: p.freq, amp: maxAmp ? p.amp / maxAmp : 0 }));
      const total = parts.length ? X.totalRoughness(parts) : 0;
      this.roughEma = this.roughEma * 0.85 + total * 0.15;
      this.roughHist.copyWithin(0, 1); this.roughHist[this.roughHist.length - 1] = this.roughEma;
      this.frame = {
        result: { ...r, peaks }, displayDb: this.displayDb, voices, silent,
        roughness: this.roughEma, roughPairs: parts.length ? X.roughPairs(parts, 80, 0.005) : [],
        level: r.peakAbs,
      };
    },

    pinnedVoices(peaks, auto) {
      const s = this.settings;
      return this.pins.map((pf, idx) => {
        // follow the pinned partial if it drifts slightly (not onto another note's partial)
        let f0 = pf;
        const near = peaks.reduce((b, p) => (Math.abs(1200 * Math.log2(p.freq / pf)) < 8 && (!b || p.db > b.db) ? p : b), null);
        if (near) { f0 = near.freq; this.pins[idx] = f0; }
        const harmonics = [];
        for (let h = 1; h <= Math.max(32, s.maxHarm); h++) {
          let bi = -1, bd = 30;
          peaks.forEach((p, i) => { const d = Math.abs(1200 * Math.log2(p.freq / (h * f0))); if (d < bd) { bd = d; bi = i; } });
          if (bi >= 0) harmonics.push({ h, freq: peaks[bi].freq, db: peaks[bi].db, peakIndex: bi, dev: 1200 * Math.log2(peaks[bi].freq / (h * f0)) });
        }
        if (!harmonics.length) harmonics.push({ h: 1, freq: f0, db: -120, peakIndex: -1, dev: 0 });
        const dup = auto.some(v => Math.abs(1200 * Math.log2(v.f0 / f0)) < 30);
        return { f0, harmonics, salience: 0, id: 'pin' + idx, color: dup ? '#e8ecf3' : U.PIN_COLOR, pinned: true, missingFundamental: !harmonics.some(h => h.h === 1) };
      });
    },

    /* ------------------------------------------------------------ Loop */
    tick(ts) {
      requestAnimationFrame(t => this.tick(t));
      const active = this.engine.ctx && this.sourcesActive();
      const fresh = active && !this.frozen;
      // After the last source stops, keep analysing long enough for the analysis window to
      // fill with silence and the smoothed curve to settle, so the old spectrum fades out.
      if (active) this._idleSince = null;
      else if (this.engine.ctx && this._idleSince == null) this._idleSince = ts;
      const winMs = this.analyzer ? this.analyzer.samplesNeeded / this.sampleRate * 1000 : 0;
      const tail = this._idleSince != null && ts - this._idleSince < winMs + 2000;
      if (fresh || (this.engine.ctx && !this.frozen && ((this.frame && !this.frame.silent) || tail))) {
        this.analyse();
        if (!this._lastPush || ts - this._lastPush >= 16) { V.spectrogram.push(this.frame); this._lastPush = ts; }
        this._needsRender = true;
      }
      $('emptyState').hidden = !!(active || !$('toneLab').hidden || this.frame && !this.frame.silent);
      if (this._needsRender) {
        this._needsRender = false;
        V.spectrum.render();
        const tabView = V[this.activeTab];
        if (tabView && tabView.render) tabView.render();
        this.renderRough();
      }
      if (!this._lastSlow || ts - this._lastSlow > 120) {
        this._lastSlow = ts;
        this.renderSide();
        const tabView = V[this.activeTab];
        if (tabView && tabView.renderSlow) tabView.renderSlow();
      }
    },

    /* -------------------------------------------------------- Side panel */
    renderSide() {
      const f = this.frame, s = this.settings, ps = this.ps;
      const lvl = f ? Math.max(0, Math.min(1, (20 * Math.log10(f.level + 1e-9) + 60) / 60)) : 0;
      $('levelMeter').firstElementChild.style.width = (lvl * 100).toFixed(1) + '%';
      const voices = f ? f.voices : [];
      // legend
      $('spectrumLegend').innerHTML = voices.map(v => `<span><i style="background:${v.color}"></i>${ps.label(v.f0).label}${v.pinned ? ' (pinned)' : ''}</span>`).join('');
      // note cards
      const cards = $('noteCards');
      if (!voices.length) {
        cards.innerHTML = `<p class="muted">${this.sourcesActive() ? (f && f.silent ? 'Listening… (input below gate)' : 'Listening…') : 'Waiting for sound…'}</p>`;
      } else {
        cards.innerHTML = voices.map(v => {
          const L = ps.label(v.f0), et = ps.etNote(v.f0), t = L.tuned;
          const pos = 50 + Math.max(-50, Math.min(50, t.cents));
          const sh = ps.shruti(v.f0);
          const meta = [];
          if (s.tuning !== 'et') meta.push(`12-TET: ${et.label} ${U.fmtCents(et.cents, 1)}`);
          meta.push(`${v.harmonics.length} partials`);
          if (v.missingFundamental) meta.push('fundamental absent (heard via harmonics)');
          if (s.sargam) meta.push(`shruti ${sh.shruti.index} ${M.ratioText(sh.shruti.ratio)} ${U.fmtCents(sh.cents, 0)}`);
          if (v.pinned) meta.push('pinned');
          return `<div class="note-card" style="${v.stale ? 'opacity:.6' : ''}">
            <span class="bar" style="background:${v.color}"></span>
            <div class="name">${L.name}<small>${L.octave}</small></div>
            <div class="svara" style="color:var(--warn)">${s.sargam ? U.svaraHTML(t, s.script) : ''}</div>
            <div class="freq">${U.fmtHz(v.f0)} Hz</div>
            <div class="freq ${U.centsClass(t.cents, 3)}" style="text-align:right">${U.fmtCents(t.cents, 1)}</div>
            <div class="cents-meter" title="Deviation from the ${M.TUNINGS[s.tuning].short} degree (±50¢)">
              <span class="track"></span>
              ${[0, 25, 75, 100].map(p => `<span class="tick" style="left:${p}%"></span>`).join('')}
              <span class="tick mid" style="left:50%"></span>
              <span class="needle" style="left:${pos}%;background:${v.color}"></span>
            </div>
            <div class="meta">${meta.map(m => `<span>${m}</span>`).join('')}</div>
          </div>`;
        }).join('');
      }
      // interval cards
      const ic = $('intervalCards');
      if (voices.length < 2) ic.innerHTML = '<p class="muted">Play two or more notes.</p>';
      else {
        const html = [];
        for (let i = 0; i < voices.length && html.length < 6; i++) {
          for (let j = i + 1; j < voices.length && html.length < 6; j++) html.push(this.intervalCard(voices[i], voices[j]));
        }
        ic.innerHTML = html.join('');
      }
      $('roughVal').textContent = f ? f.roughness.toFixed(2) : '–';
    },

    intervalCard(a, b) {
      const ps = this.ps, s = this.settings;
      const iv = M.describeInterval(a.f0, b.f0);
      const R = b.f0 / a.f0;
      // simplest ratio P:Q within 30 cents → harmonic P of a meets harmonic Q of b
      let best = null;
      for (let q = 1; q <= 16; q++) {
        const p = Math.round(R * q);
        if (p < 1 || p > 32) continue;
        const dev = 1200 * Math.log2(R / (p / q));
        if (Math.abs(dev) < 30 && (!best || p * q < best.p * best.q - 0.5 && Math.abs(dev) < 30)) best = { p, q, dev };
      }
      // cross-roughness between the two notes' partials
      const refA = Math.max(...a.harmonics.map(h => h.db)), refB = Math.max(...b.harmonics.map(h => h.db));
      const ref = Math.max(refA, refB);
      let cross = 0;
      for (const ha of a.harmonics) for (const hb of b.harmonics) {
        if (ha.peakIndex >= 0 && ha.peakIndex === hb.peakIndex) continue;
        cross += X.pairRoughness(ha.freq, Math.pow(10, (ha.db - ref) / 20), hb.freq, Math.pow(10, (hb.db - ref) / 20));
      }
      const just = iv.just, jr = M.ratioText(iv.justFull);
      let beat = '';
      if (best && best.p <= 32) {
        const bf = Math.abs(best.p * a.f0 - best.q * b.f0);
        const g = (x, y) => (y ? g(y, x % y) : x);
        const gg = g(best.p, best.q);
        const P = best.p / gg, Q = best.q / gg;
        beat = `<div class="beat">Harmonic <b style="color:${a.color}">${P}</b> of ${ps.etNote(a.f0).label} ≈ harmonic <b style="color:${b.color}">${Q}</b> of ${ps.etNote(b.f0).label}: ` +
          (Math.abs(best.dev) < 0.5 && bf < 0.2 ? '<span class="ok">coincide — no beating</span>' : `beat <b class="${bf < 1.5 ? 'ok' : bf < 15 ? '' : 'bad'}">${bf.toFixed(2)} Hz</b>`) + '</div>';
      }
      return `<div class="interval-card">
        <div class="top"><span class="iname">${iv.etName}</span><span class="pair"><span class="dot" style="background:${a.color}"></span>${ps.label(a.f0).label} → <span class="dot" style="background:${b.color}"></span>${ps.label(b.f0).label}</span></div>
        <div class="nums">${iv.cents.toFixed(2)}¢ · ET ${U.fmtCents(iv.etDev, 2)} · ${jr} ${U.fmtCents(just.dev, 2)}</div>
        ${beat}
        <div class="beat">Cross-roughness <b class="${cross < 0.15 ? 'ok' : cross > 0.6 ? 'bad' : ''}">${cross.toFixed(2)}</b> <span class="muted">between the two notes' partials</span></div>
      </div>`;
    },

    renderRough() {
      if (!this.roughCv) this.roughCv = U.managedCanvas($('cvRough'));
      const m = this.roughCv, ctx = m.begin(), W = m.w, H = m.h, h = this.roughHist;
      const max = Math.max(1, ...h);
      ctx.strokeStyle = U.C.grid;
      ctx.beginPath(); ctx.moveTo(0, H - 0.5); ctx.lineTo(W, H - 0.5); ctx.stroke();
      ctx.beginPath();
      for (let i = 0; i < h.length; i++) {
        const x = i / (h.length - 1) * W, y = H - 2 - h[i] / max * (H - 6);
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      }
      ctx.strokeStyle = '#ff8a94'; ctx.lineWidth = 1.5; ctx.stroke(); ctx.lineWidth = 1;
      ctx.lineTo(W, H); ctx.lineTo(0, H); ctx.closePath();
      ctx.fillStyle = 'rgba(255,95,109,0.12)'; ctx.fill();
      ctx.font = `10px ${U.MONO}`; ctx.fillStyle = U.C.text2; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      ctx.fillText('last 10 s · max ' + max.toFixed(1), 4, 2);
    },

    /* ----------------------------------------------------------- Tone Lab */
    keyFreq(step) { return this.ps.degreeFreq(step, this.settings.tlOct); },

    buildKeyboard() {
      const kb = $('keyboard'), s = this.settings, ps = this.ps;
      const keysMap = ['a', 'w', 's', 'e', 'd', 'f', 't', 'g', 'y', 'h', 'u', 'j', 'k'];
      const isBlack = pc => [1, 3, 6, 8, 10].includes(pc);
      const steps = 25;
      const whites = [];
      for (let st = 0; st < steps; st++) if (!isBlack((s.tonicPc + st) % 12)) whites.push(st);
      const ww = 100 / whites.length;
      const on = this.engine.toneLab ? new Set(this.engine.toneLab.notes.keys()) : new Set();
      let html = '';
      for (let st = 0; st < steps; st++) {
        const pc = (s.tonicPc + st) % 12, black = isBlack(pc);
        const t = { svara: M.SVARAS[st % 12], octave: Math.floor(st / 12) + s.tlOct };
        const f = this.keyFreq(st);
        let left, width;
        if (!black) { left = whites.indexOf(st) * ww; width = ww; }
        else { const prevWhite = whites.filter(w => w < st).length; left = prevWhite * ww - ww * 0.32; width = ww * 0.64; }
        const kc = keysMap[st] ? `<span class="kc">${keysMap[st].toUpperCase()}</span>` : '';
        html += `<div class="key ${black ? 'black' : 'white'} ${on.has(st) ? 'on' : ''}" data-step="${st}" style="left:${left}%;width:${width}%">
          ${s.sargam ? `<span class="ks">${U.svaraHTML(t, s.script)}</span>` : ''}<span>${M.degreeNoteName(s.tonicPc, st, s.spell === 'flats')}</span><span class="kf">${f.toFixed(1)}</span>${kc}</div>`;
      }
      kb.innerHTML = html;
    },

    async toggleStep(step, force) {
      await this.engine.ensure();
      this.syncToneLab();
      const tl = this.engine.toneLab;
      const isOn = tl.notes.has(step);
      const want = force === undefined ? !isOn : force;
      if (want && !isOn) tl.noteOn(step, this.keyFreq(step));
      if (!want && isOn) tl.noteOff(step);
      this.afterToneChange();
    },

    afterToneChange() {
      const tl = this.engine.toneLab;
      document.querySelectorAll('#keyboard .key').forEach(k => k.classList.toggle('on', tl.notes.has(+k.dataset.step)));
      $('btnTone').setAttribute('aria-pressed', String(!$('toneLab').hidden));
      if (!tl.notes.size) this.tracker.clear();
      this.requestRender();
    },

    syncToneLab() {
      const tl = this.engine.toneLab, s = this.settings;
      if (!tl) return;
      const changed = tl.timbre !== s.tlTimbre || tl.nHarm !== s.tlHarm || tl.inharm !== s.tlInh * 2.5e-5;
      tl.timbre = s.tlTimbre; tl.nHarm = s.tlHarm; tl.inharm = s.tlInh * 2.5e-5;
      if (changed) tl.refresh();
      this.engine.setMonitor(s.tlMonitor);
    },

    retuneToneLab() {
      const tl = this.engine.toneLab;
      if (!tl) return;
      for (const id of tl.notes.keys()) tl.setFreq(id, this.keyFreq(id));
    },

    async setChord(steps) {
      await this.engine.ensure();
      this.syncToneLab();
      const tl = this.engine.toneLab;
      tl.allOff();
      steps.forEach(st => tl.noteOn(st, this.keyFreq(st)));
      this.afterToneChange();
    },

    openToneLab(open = true) {
      $('toneLab').hidden = !open;
      if (open) this.buildKeyboard();
      $('btnTone').setAttribute('aria-pressed', String(open));
    },

    demoInterval(tuning, step) {
      this.settings.tuning = tuning;
      $('selTuning').value = tuning;
      this.onTonalChange();
      this.openToneLab(true);
      this.setChord(step === 0 ? [0, 12] : [0, step]);
      toast(`${M.TUNINGS[tuning].name}: Sa + ${M.SVARAS[step].full}. Watch the Overtone overlap / Intervals for beats.`);
    },

    onTonalChange() {
      this.updatePitchSpace();
      this.retuneToneLab();
      if (!$('toneLab').hidden) this.buildKeyboard();
      saveSettings(this.settings);
      if (V.tuning.renderSlow) V.tuning.renderSlow(true);
      if (V.ladder.renderSlow) V.ladder.renderSlow(true);
      this.requestRender();
    },
  };

  /* --------------------------------------------------------------- Toast */
  let toastTimer = 0;
  function toast(msg, isError) {
    const t = $('toast');
    t.textContent = msg;
    t.className = 'toast' + (isError ? ' error' : '');
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, isError ? 8000 : 3500);
  }

  /* ------------------------------------------------------------- Wiring */
  function bindTopbar() {
    const s = app.settings;
    const selKey = $('selKey');
    selKey.innerHTML = M.SHARP_NAMES.map((n, i) => `<option value="${i}">${n === M.FLAT_NAMES[i] ? n : n + ' / ' + M.FLAT_NAMES[i]}</option>`).join('');
    selKey.value = s.tonicPc;
    selKey.addEventListener('change', () => { s.tonicPc = +selKey.value; app.onTonalChange(); });
    const selT = $('selTuning');
    selT.innerHTML = Object.entries(M.TUNINGS).map(([k, t]) => `<option value="${k}">${t.name}</option>`).join('');
    selT.value = s.tuning;
    selT.addEventListener('change', () => { s.tuning = selT.value; app.onTonalChange(); });
    const a4 = $('inpA4');
    a4.value = s.a4;
    a4.addEventListener('change', () => {
      const v = parseFloat(a4.value);
      if (v >= 400 && v <= 480) { s.a4 = v; app.onTonalChange(); } else a4.value = s.a4;
    });
    const sg = $('chkSargam');
    sg.checked = s.sargam;
    sg.addEventListener('change', () => { s.sargam = sg.checked; app.onTonalChange(); });

    $('btnMic').addEventListener('click', toggleMic);
    $('btnTone').addEventListener('click', async () => {
      const open = $('toneLab').hidden;
      app.openToneLab(open);
      if (open) { await app.engine.ensure(); app.syncToneLab(); }
    });
    $('btnFreeze').addEventListener('click', toggleFreeze);
    const fileInput = $('fileInput');
    fileInput.closest('label').addEventListener('click', e => {
      if (app.engine.file) { e.preventDefault(); app.engine.stopFile(); $('fileLabel').textContent = 'File'; fileInput.closest('label').setAttribute('aria-pressed', 'false'); }
    });
    fileInput.addEventListener('change', async () => {
      const f = fileInput.files[0];
      if (!f) return;
      try {
        await app.engine.playFile(f);
        app.engine.setFilePaused(app.frozen); // a file opened while frozen waits for unfreeze
        app.engine.setMonitor(true);
        $('fileLabel').textContent = '■ ' + (f.name.length > 18 ? f.name.slice(0, 16) + '…' : f.name);
        fileInput.closest('label').setAttribute('aria-pressed', 'true');
        toast(`Playing “${f.name}” on loop. Click the file button again to stop.`);
      } catch (err) { toast('Could not decode this file: ' + err.message, true); }
      fileInput.value = '';
    });
    $('btnSettings').addEventListener('click', () => {
      const d = $('settings'); d.hidden = !d.hidden;
      $('btnSettings').setAttribute('aria-expanded', String(!d.hidden));
    });
    document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => {
      const id = b.dataset.close;
      if (id === 'toneLab') app.openToneLab(false); else $(id).hidden = true;
    }));
    document.querySelectorAll('.empty-actions [data-action]').forEach(b => b.addEventListener('click', () => {
      if (b.dataset.action === 'mic') toggleMic(); else $('btnTone').click();
    }));
  }

  async function toggleMic() {
    const btn = $('btnMic');
    if (app.engine.mic) {
      app.engine.stopMic();
      btn.setAttribute('aria-pressed', 'false');
      return;
    }
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('This browser does not allow microphone access here. Open the page via http://localhost (see README) or https.');
      const st = await app.engine.startMic(app.settings.device || undefined);
      btn.setAttribute('aria-pressed', 'true');
      app.configureAnalyzer();
      const proc = ['echoCancellation', 'noiseSuppression', 'autoGainControl'].filter(k => st[k] === true);
      $('micInfo').innerHTML = proc.length
        ? `⚠ The browser kept <b>${proc.join(', ')}</b> on — overtone levels may be altered.`
        : 'Mic processing (echo cancellation, noise suppression, auto gain) is <b>off</b> — clean signal.';
      toast(proc.length ? `Microphone on, but the browser kept ${proc.join(', ')} enabled.` : 'Microphone on — raw signal, no processing.');
      listDevices();
    } catch (err) {
      const msg = err && err.name === 'NotAllowedError' ? 'Microphone permission was denied. Allow it in the address bar and try again.' : (err.message || String(err));
      toast(msg, true);
    }
  }

  async function listDevices() {
    try {
      const devs = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audioinput');
      const sel = $('setDevice');
      sel.innerHTML = '<option value="">Default</option>' + devs.map(d => `<option value="${U.esc(d.deviceId)}">${U.esc(d.label || 'Microphone ' + d.deviceId.slice(0, 5))}</option>`).join('');
      sel.value = app.settings.device;
    } catch (e) { /* not available */ }
  }

  function toggleFreeze() {
    app.frozen = !app.frozen;
    $('btnFreeze').setAttribute('aria-pressed', String(app.frozen));
    $('btnFreeze').querySelector('span').textContent = app.frozen ? 'Frozen' : 'Freeze';
    app.engine.setFilePaused(app.frozen);
    app.requestRender();
  }

  function bindSettings() {
    const s = app.settings;
    const bind = (id, key, { num = false, check = false, out, fmt, after } = {}) => {
      const el = $(id);
      if (check) el.checked = s[key]; else el.value = s[key];
      const show = () => { if (out) $(out).textContent = fmt ? fmt(s[key]) : s[key]; };
      show();
      el.addEventListener(el.type === 'range' ? 'input' : 'change', () => {
        s[key] = check ? el.checked : num ? +el.value : el.value;
        show();
        saveSettings(s);
        if (after) after();
        app.requestRender();
      });
    };
    const reanalyse = () => app.configureAnalyzer();
    bind('setFFT', 'fft', { num: true, after: reanalyse });
    bind('setWindow', 'window', { after: reanalyse });
    bind('setThresh', 'thresh', { num: true, out: 'outThresh', fmt: v => v + ' dB' });
    bind('setRange', 'range', { num: true, out: 'outRange', fmt: v => v + ' dB' });
    bind('setGate', 'gate', { num: true, out: 'outGate', fmt: v => '−' + Math.abs(v) + ' dBFS' });
    bind('setPoly', 'poly', { check: true });
    bind('setVoices', 'maxVoices', { num: true, out: 'outVoices' });
    bind('setMinF0', 'minF0', { num: true });
    bind('setSmooth', 'smooth', { num: true, out: 'outSmooth', fmt: v => v.toFixed(2) });
    bind('setFMin', 'fMin', { num: true, after: () => { s.fMin = Math.max(20, Math.min(s.fMin, s.fMax / 1.5)); $('setFMin').value = s.fMin; V.spectrum.view = null; } });
    bind('setFMax', 'fMax', { num: true, after: () => { s.fMax = Math.min(20000, Math.max(s.fMax, s.fMin * 1.5)); $('setFMax').value = s.fMax; V.spectrum.view = null; } });
    bind('setDbMin', 'dbMin', { num: true, out: 'outDbMin', fmt: v => '−' + Math.abs(v) + ' dB' });
    bind('setHarm', 'maxHarm', { num: true, out: 'outHarm', after: () => V.ladder.renderSlow(true) });
    bind('setSpell', 'spell', { after: () => app.onTonalChange() });
    bind('setScript', 'script', { after: () => app.onTonalChange() });
    bind('setSaFine', 'saFine', { num: true, out: 'outSaFine', fmt: v => (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v) + ' ¢', after: () => app.onTonalChange() });
    bind('setRoughStrip', 'roughStrip', { check: true });
    bind('setTunedTicks', 'tunedTicks', { check: true });
    bind('setDevice', 'device', { after: () => { if (app.engine.mic) { app.engine.stopMic(); $('btnMic').setAttribute('aria-pressed', 'false'); toggleMic(); } } });
    $('btnReset').addEventListener('click', () => {
      try { localStorage.removeItem(STORE); } catch (e) { /* ignore */ }
      location.reload();
    });
  }

  function bindTabs() {
    const tabs = document.querySelectorAll('.tabs [data-tab]');
    tabs.forEach(b => b.addEventListener('click', () => {
      app.activeTab = b.dataset.tab;
      tabs.forEach(x => x.setAttribute('aria-selected', String(x === b)));
      document.querySelectorAll('.tab').forEach(t => { t.hidden = t.dataset.tab !== app.activeTab; });
      const v = V[app.activeTab];
      if (v) { if (v.cv) v.cv.fit(); if (v.renderSlow) v.renderSlow(true); }
      app.requestRender();
    }));
  }

  function bindToneLab() {
    const s = app.settings;
    const selT = $('tlTimbre');
    selT.innerHTML = Object.entries(A.TIMBRES).map(([k, t]) => `<option value="${k}">${t.label}</option>`).join('');
    selT.value = s.tlTimbre;
    selT.addEventListener('change', () => { s.tlTimbre = selT.value; app.syncToneLab(); saveSettings(s); });
    const h = $('tlHarm'); h.value = s.tlHarm; $('tlHarmOut').textContent = s.tlHarm;
    h.addEventListener('input', () => { s.tlHarm = +h.value; $('tlHarmOut').textContent = s.tlHarm; });
    h.addEventListener('change', () => { app.syncToneLab(); saveSettings(s); });
    const ih = $('tlInh'); ih.value = s.tlInh;
    const inhTxt = () => { $('tlInhOut').textContent = s.tlInh ? (s.tlInh * 2.5e-5).toExponential(1) : '0'; };
    inhTxt();
    ih.addEventListener('input', () => { s.tlInh = +ih.value; inhTxt(); });
    ih.addEventListener('change', () => { app.syncToneLab(); saveSettings(s); });
    const oc = $('tlOct'); oc.value = s.tlOct;
    oc.addEventListener('change', () => { s.tlOct = +oc.value; app.retuneToneLab(); app.buildKeyboard(); saveSettings(s); });
    const mon = $('tlMonitor'); mon.checked = s.tlMonitor;
    mon.addEventListener('change', () => { s.tlMonitor = mon.checked; app.syncToneLab(); saveSettings(s); });
    $('tlCollapse').addEventListener('click', () => {
      const tl = $('toneLab'), c = tl.classList.toggle('collapsed');
      $('tlCollapse').textContent = c ? '▴' : '▾';
      $('tlCollapse').setAttribute('aria-expanded', String(!c));
    });
    $('tlAllOff').addEventListener('click', () => { if (app.engine.toneLab) { app.engine.toneLab.allOff(); app.afterToneChange(); } });

    const presets = [
      ['Sa drone', [0]], ['Sa–Pa drone', [0, 7, 12]], ['Octave', [0, 12]], ['Fifth', [0, 7]], ['Fourth', [0, 5]],
      ['Major 3rd', [0, 4]], ['Minor 3rd', [0, 3]], ['Major 6th', [0, 9]], ['Tritone', [0, 6]], ['Minor 2nd', [0, 1]],
      ['Major 2nd', [0, 2]], ['Major triad', [0, 4, 7]], ['Minor triad', [0, 3, 7]], ['Dominant 7th', [0, 4, 7, 10]], ['Cluster', [0, 1, 2]],
    ];
    $('tlPresets').innerHTML = presets.map(([n], i) => `<button data-p="${i}">${n}</button>`).join('');
    $('tlPresets').addEventListener('click', e => {
      const b = e.target.closest('button[data-p]');
      if (b) app.setChord(presets[+b.dataset.p][1]);
    });
    $('keyboard').addEventListener('pointerdown', e => {
      const k = e.target.closest('.key');
      if (k) { e.preventDefault(); app.toggleStep(+k.dataset.step); }
    });
  }

  function bindKeys() {
    const map = { a: 0, w: 1, s: 2, e: 3, d: 4, f: 5, t: 6, g: 7, y: 8, h: 9, u: 10, j: 11, k: 12 };
    document.addEventListener('keydown', e => {
      if (e.target.matches('input, select, textarea') || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
      if (e.code === 'Space') { e.preventDefault(); toggleFreeze(); return; }
      if (!$('toneLab').hidden && e.key.toLowerCase() in map) { app.toggleStep(map[e.key.toLowerCase()]); return; }
      if (e.key === 'm' || e.key === 'M') toggleMic();
      if (e.key === 't' || e.key === 'T') $('btnTone').click();
      if (e.key === 'Escape') { $('settings').hidden = true; }
    });
  }

  function init() {
    app.updatePitchSpace();
    bindTopbar(); bindSettings(); bindTabs(); bindToneLab(); bindKeys();
    for (const k of ['spectrum', 'ladder', 'overlap', 'curve', 'spectrogram', 'tuning']) V[k].init(app);
    app.configureAnalyzer();
    app.engine.onstate = () => app.requestRender();
    V.tuning.renderSlow(true);
    app.requestRender();
    requestAnimationFrame(t => app.tick(t));
    root.HarmonicsLab = app; // handy for debugging from the console
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})(typeof self !== 'undefined' ? self : this);
