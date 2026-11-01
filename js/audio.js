/*
 * audio.js — Web Audio plumbing.
 *  - A capture tap (AudioWorklet, with ScriptProcessor fallback) copies everything
 *    routed to `engine.input` into a ring buffer that the analyser reads.
 *  - Sources: microphone (all browser processing disabled), the Tone Lab instrument
 *    synthesiser (models in synth.js), and audio files.
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
      if (!this._ready) {
        // Memoised, so concurrent callers all wait for the full setup.
        this._ready = (async () => {
          const AC = root.AudioContext || root.webkitAudioContext;
          this.ctx = new AC({ latencyHint: 'interactive' });
          this.input = this.ctx.createGain();
          this.monitor = this.ctx.createGain(); // to speakers (tone lab / file only)
          this.monitor.connect(this.ctx.destination);
          await this._setupTap();
          const tl = new ToneLab(this.ctx, [this.input, this.monitor]);
          await tl.init();
          this.toneLab = tl;
        })();
      }
      await this._ready;
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
  // The instrument models live in synth.js. Their factory is self-contained, so it is
  // stringified into an AudioWorklet module (synthesis off the main thread); without
  // AudioWorklet the same engine runs in a ScriptProcessor.
  const S = root.HSynth;
  const SYNTH_WORKLET = () => `const HSynth = (${S.factory.toString()})();
    class HarmonicsSynth extends AudioWorkletProcessor {
      constructor() { super(); this.engine = new HSynth.Engine(sampleRate); this.port.onmessage = e => this.engine.handle(e.data); }
      process(inputs, outputs) {
        const out = outputs[0] && outputs[0][0];
        if (out) { out.fill(0); this.engine.render(out, out.length); }
        return true;
      }
    }
    registerProcessor('harmonics-synth', HarmonicsSynth);`;

  class ToneLab {
    constructor(ctx, outputs) {
      this.ctx = ctx;
      this.out = ctx.createGain();
      this.out.gain.value = 1;
      outputs.forEach(o => this.out.connect(o));
      this.notes = new Map(); // id -> {freq}
      this.timbre = 'saw';
      this.nHarm = 12;
      this.inharm = 0;
      this.vibrato = true;
      this.restrike = true;
    }

    async init() {
      const ctx = this.ctx;
      try {
        if (!ctx.audioWorklet) throw new Error('no worklet');
        const src = SYNTH_WORKLET();
        try {
          await ctx.audioWorklet.addModule('data:application/javascript;charset=utf-8,' + encodeURIComponent(src));
        } catch (e) {
          const url = URL.createObjectURL(new Blob([src], { type: 'application/javascript' }));
          try { await ctx.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }
        }
        const node = new AudioWorkletNode(ctx, 'harmonics-synth', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1] });
        node.connect(this.out);
        this.send = m => node.port.postMessage(m);
        this.kind = 'AudioWorklet';
      } catch (err) {
        const engine = new S.Engine(ctx.sampleRate);
        const sp = ctx.createScriptProcessor(1024, 1, 1);
        sp.onaudioprocess = e => { const o = e.outputBuffer.getChannelData(0); o.fill(0); engine.render(o, o.length); };
        // a ScriptProcessor only runs while its input is connected
        const silent = ctx.createConstantSource(); silent.offset.value = 0; silent.connect(sp); silent.start();
        sp.connect(this.out);
        this.send = m => engine.handle(m);
        this.kind = 'ScriptProcessor';
      }
      this.setOptions();
    }

    setOptions() { this.send({ t: 'opts', vibrato: this.vibrato, restrike: this.restrike }); }

    /** Tune the shared sympathetic strings (sitar taraf, sarangi) to these frequencies. */
    setSympathetic(freqs) { this.send({ t: 'symp', freqs }); }

    noteOn(id, freq) {
      if (this.notes.has(id)) { this.setFreq(id, freq); return; }
      this.notes.set(id, { freq });
      this.send({ t: 'on', id, freq, inst: this.timbre, nHarm: this.nHarm, inharm: this.inharm });
    }

    setFreq(id, freq) {
      const n = this.notes.get(id);
      if (!n) return;
      n.freq = freq;
      this.send({ t: 'freq', id, freq });
    }

    noteOff(id) {
      if (!this.notes.delete(id)) return;
      this.send({ t: 'off', id });
    }

    allOff() { [...this.notes.keys()].forEach(id => this.noteOff(id)); }

    /** Rebuild sounding notes after an instrument / harmonics change. */
    refresh() {
      const cur = [...this.notes.entries()].map(([id, n]) => [id, n.freq]);
      cur.forEach(([id]) => this.noteOff(id));
      cur.forEach(([id, f]) => this.noteOn(id, f));
    }
  }

  root.HAudio = { AudioEngine, ToneLab, INSTRUMENTS: S.INSTRUMENTS };
})(typeof self !== 'undefined' ? self : this);
