/*
 * audio.js — Web Audio plumbing.
 *  - A capture tap (AudioWorklet, with ScriptProcessor fallback) copies everything
 *    routed to `engine.input` into a ring buffer that the analyser reads.
 *  - Sources: microphone (all browser processing disabled), the Tone Lab additive
 *    synthesiser, and audio files.
 */
(function (root) {
  'use strict';

  const RING = 1 << 17; // 131072 samples (~2.7 s at 48 kHz)

  const TAP_WORKLET = `
    class Tap extends AudioWorkletProcessor {
      constructor() { super(); this.buf = new Float32Array(1024); this.n = 0; }
      process(inputs) {
        // With nothing connected the input has zero channels; record silence anyway so the
        // ring buffer does not keep the last sound forever.
        const ch = inputs[0] && inputs[0][0];
        const len = ch ? ch.length : 128;
        for (let i = 0; i < len; i++) {
          this.buf[this.n++] = ch ? ch[i] : 0;
          if (this.n === this.buf.length) {
            this.port.postMessage(this.buf, [this.buf.buffer]);
            this.buf = new Float32Array(1024); this.n = 0;
          }
        }
        return true;
      }
    }
    registerProcessor('harmonics-tap', Tap);`;

  class AudioEngine {
    constructor() {
      this.ctx = null;
      this.ring = new Float32Array(RING);
      this.writePos = 0;
      this.totalWritten = 0;
      this.mic = null;
      this.file = null;
      this.onstate = () => {};
    }

    get sampleRate() { return this.ctx ? this.ctx.sampleRate : 48000; }

    async ensure() {
      if (!this.ctx) {
        const AC = root.AudioContext || root.webkitAudioContext;
        this.ctx = new AC({ latencyHint: 'interactive' });
        this.input = this.ctx.createGain();
        this.monitor = this.ctx.createGain(); // to speakers (tone lab / file only)
        this.monitor.connect(this.ctx.destination);
        await this._setupTap();
        this.toneLab = new ToneLab(this.ctx, [this.input, this.monitor]);
      }
      if (this.ctx.state === 'suspended') await this.ctx.resume();
    }

    async _setupTap() {
      const ctx = this.ctx;
      const sink = ctx.createGain();
      sink.gain.value = 0;
      sink.connect(ctx.destination);
      const push = data => {
        const n = data.length, r = this.ring;
        let p = this.writePos;
        for (let i = 0; i < n; i++) { r[p] = data[i]; p = (p + 1) & (RING - 1); }
        this.writePos = p;
        this.totalWritten += n;
      };
      try {
        if (!ctx.audioWorklet) throw new Error('no worklet');
        // Blob URLs are refused on file:// pages in Chrome (null origin); a data: URL works there.
        try {
          await ctx.audioWorklet.addModule('data:application/javascript;charset=utf-8,' + encodeURIComponent(TAP_WORKLET));
        } catch (e) {
          const url = URL.createObjectURL(new Blob([TAP_WORKLET], { type: 'application/javascript' }));
          try { await ctx.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }
        }
        const node = new AudioWorkletNode(ctx, 'harmonics-tap', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: 'explicit' });
        node.port.onmessage = e => push(e.data);
        this.input.connect(node);
        node.connect(sink);
        this.tapKind = 'AudioWorklet';
      } catch (err) {
        this.tapError = String(err && err.message || err);
        const sp = ctx.createScriptProcessor(2048, 1, 1);
        sp.onaudioprocess = e => push(e.inputBuffer.getChannelData(0));
        this.input.connect(sp);
        sp.connect(sink);
        this.tapKind = 'ScriptProcessor';
      }
    }

    /** Copy the most recent n samples into `out` (Float32Array of length >= n). */
    latest(n, out) {
      const r = this.ring;
      let p = (this.writePos - n + RING) & (RING - 1);
      for (let i = 0; i < n; i++) { out[i] = r[p]; p = (p + 1) & (RING - 1); }
      return out;
    }

    clearRing() { this.ring.fill(0); }

    async startMic(deviceId) {
      await this.ensure();
      this.stopMic();
      const constraints = {
        audio: {
          echoCancellation: false, noiseSuppression: false, autoGainControl: false,
          channelCount: 1,
          ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
        },
      };
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      const src = this.ctx.createMediaStreamSource(stream);
      src.connect(this.input);
      this.mic = { stream, src };
      const track = stream.getAudioTracks()[0];
      this.micSettings = track && track.getSettings ? track.getSettings() : {};
      this.onstate();
      return this.micSettings;
    }

    stopMic() {
      if (!this.mic) return;
      this.mic.src.disconnect();
      this.mic.stream.getTracks().forEach(t => t.stop());
      this.mic = null;
      this.onstate();
    }

    async playFile(file) {
      await this.ensure();
      this.stopFile();
      const buf = await this.ctx.decodeAudioData(await file.arrayBuffer());
      this.file = { buf, src: null, name: file.name, duration: buf.duration, offset: 0, startedAt: 0, paused: false };
      this._startFileSource();
      this.onstate();
    }

    _startFileSource() {
      const f = this.file, src = this.ctx.createBufferSource();
      src.buffer = f.buf;
      src.loop = true;
      src.connect(this.input);
      src.connect(this.monitor);
      src.start(0, f.offset);
      f.src = src;
      f.startedAt = this.ctx.currentTime - f.offset;
    }

    _stopFileSource() {
      const f = this.file;
      if (!f || !f.src) return;
      try { f.src.stop(); } catch (e) { /* already stopped */ }
      f.src.disconnect();
      f.src = null;
    }

    /** Pause/resume the looping file, keeping its position. */
    setFilePaused(paused) {
      const f = this.file;
      if (!f || f.paused === paused) return;
      if (paused) {
        f.offset = (this.ctx.currentTime - f.startedAt) % f.duration;
        this._stopFileSource();
      } else {
        this._startFileSource();
      }
      f.paused = paused;
      this.onstate();
    }

    stopFile() {
      if (!this.file) return;
      this._stopFileSource();
      this.file = null;
      this.onstate();
    }

    setMonitor(on) { if (this.monitor) this.monitor.gain.setTargetAtTime(on ? 1 : 0, this.ctx.currentTime, 0.02); }
  }

  /* ------------------------------------------------------------- Tone Lab */
  // Harmonic amplitude recipes. `f` is the note frequency (for formant timbres).
  const TIMBRES = {
    sine: { label: 'Sine (pure tone)', amp: h => (h === 1 ? 1 : 0) },
    saw: { label: 'Bright / bowed string (1/n)', amp: h => 1 / h },
    reed: { label: 'Reed / harmonium (rich)', amp: h => Math.pow(h, -0.6) },
    square: { label: 'Clarinet-like (odd only)', amp: h => (h % 2 ? 1 / h : 0) },
    triangle: { label: 'Soft flute (odd, 1/n²)', amp: h => (h % 2 ? 1 / (h * h) : 0) },
    voice: {
      label: 'Voice "aah" (formants)',
      amp: (h, f) => {
        const fr = h * f;
        const bump = (fc, bw, g) => g * Math.exp(-0.5 * Math.pow(Math.log2(fr / fc) / bw, 2));
        return (0.15 + bump(730, 0.35, 1) + bump(1090, 0.3, 0.6) + bump(2440, 0.25, 0.25)) / Math.sqrt(h);
      },
    },
    pluck: { label: 'Plucked string (1/n²·sin)', amp: h => Math.abs(Math.sin(Math.PI * h * 0.2)) / (h * 0.8 + 0.2) },
  };

  class ToneLab {
    constructor(ctx, outputs) {
      this.ctx = ctx;
      this.out = ctx.createGain();
      this.out.gain.value = 0.8;
      outputs.forEach(o => this.out.connect(o));
      this.notes = new Map(); // id -> {freq, master, oscs:[{osc, gain, h}]}
      this.timbre = 'saw';
      this.nHarm = 12;
      this.inharm = 0;
    }

    amps(freq) {
      const t = TIMBRES[this.timbre] || TIMBRES.saw;
      const a = [];
      for (let h = 1; h <= this.nHarm; h++) {
        const f = h * freq * Math.sqrt(1 + this.inharm * h * h);
        a.push(f < this.ctx.sampleRate / 2 - 200 ? t.amp(h, freq) : 0);
      }
      const sum = a.reduce((s, x) => s + x, 0) || 1;
      return a.map(x => x / sum);
    }

    noteOn(id, freq) {
      if (this.notes.has(id)) { this.setFreq(id, freq); return; }
      const ctx = this.ctx, now = ctx.currentTime;
      const master = ctx.createGain();
      master.gain.setValueAtTime(0, now);
      master.gain.linearRampToValueAtTime(0.22, now + 0.04);
      master.connect(this.out);
      const amps = this.amps(freq);
      const oscs = [];
      amps.forEach((a, i) => {
        const h = i + 1;
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.value = h * freq * Math.sqrt(1 + this.inharm * h * h);
        const g = ctx.createGain();
        g.gain.value = a;
        osc.connect(g); g.connect(master);
        osc.start(now);
        oscs.push({ osc, gain: g, h });
      });
      this.notes.set(id, { freq, master, oscs });
    }

    setFreq(id, freq) {
      const n = this.notes.get(id);
      if (!n) return;
      n.freq = freq;
      const t = this.ctx.currentTime;
      const amps = this.amps(freq);
      n.oscs.forEach(o => {
        o.osc.frequency.setTargetAtTime(o.h * freq * Math.sqrt(1 + this.inharm * o.h * o.h), t, 0.015);
        o.gain.gain.setTargetAtTime(amps[o.h - 1] || 0, t, 0.015);
      });
    }

    noteOff(id) {
      const n = this.notes.get(id);
      if (!n) return;
      this.notes.delete(id);
      const t = this.ctx.currentTime;
      n.master.gain.cancelScheduledValues(t);
      n.master.gain.setValueAtTime(n.master.gain.value, t);
      n.master.gain.linearRampToValueAtTime(0, t + 0.08);
      n.oscs.forEach(o => o.osc.stop(t + 0.1));
      setTimeout(() => n.master.disconnect(), 300);
    }

    allOff() { [...this.notes.keys()].forEach(id => this.noteOff(id)); }

    /** Rebuild sounding notes after a timbre change. */
    refresh() {
      const cur = [...this.notes.entries()].map(([id, n]) => [id, n.freq]);
      cur.forEach(([id]) => this.noteOff(id));
      cur.forEach(([id, f]) => this.noteOn(id, f));
    }
  }

  root.HAudio = { AudioEngine, ToneLab, TIMBRES };
})(typeof self !== 'undefined' ? self : this);
