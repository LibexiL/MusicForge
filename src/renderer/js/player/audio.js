// One <audio> element routed through Web Audio: element → analyser (visualizer, pre-volume)
//                                                  → gain (volume) → output device.
const el = new Audio();
el.preload = 'auto';
el.crossOrigin = 'anonymous';

let graph = null;

export function audioEl() { return el; }

export function audioGraph() {
  if (graph) return graph;
  const ctx = new AudioContext({ latencyHint: 'playback' });
  const source = ctx.createMediaElementSource(el);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 4096;
  analyser.smoothingTimeConstant = 0;
  analyser.minDecibels = -90;
  analyser.maxDecibels = -18;
  const gain = ctx.createGain();
  source.connect(analyser);
  source.connect(gain);
  gain.connect(ctx.destination);
  graph = { ctx, source, analyser, gain };
  return graph;
}

export function setGain(v) {
  const g = audioGraph();
  g.gain.gain.setTargetAtTime(v, g.ctx.currentTime, 0.02);
}

export async function setOutputDevice(id) {
  const g = audioGraph();
  if (typeof g.ctx.setSinkId === 'function') {
    try { await g.ctx.setSinkId(id || ''); return true; } catch { return false; }
  }
  return false;
}
