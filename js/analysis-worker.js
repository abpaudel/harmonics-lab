/*
 * analysis-worker.js — runs the analysis pipeline (analysis.js) off the main thread.
 * Audio arrives on a MessagePort, straight from the capture worklet when there is one.
 */
/* global importScripts */
importScripts('dsp.js', 'pitch.js', 'dissonance.js', 'analysis.js');

const core = new self.HAnalysis.Core((frame, transfer) => self.postMessage(frame, transfer));

self.onmessage = e => {
  const m = e.data;
  if (m.type === 'port') m.port.onmessage = ev => core.push(ev.data);
  else if (m.type === 'configure') core.configure(m.cfg);
  else if (m.type === 'params') core.setParams(m.params);
};
