// Audio visualizer. Reads either MusicForge's own audio graph (local files, previews) or
// a capture of system audio (anything playing: Spotify, YouTube…). Draws on a 2D canvas
// with typed arrays and no per-frame allocation; stops itself when off-screen or hidden.
import { audioGraph } from './player/audio.js';
import { state, emit } from './state.js';
import { engine } from './player/engine.js';

// Steel temper colours, coolest (quiet) to hottest (loud).
export const PALETTES = {
  temper: ['#4364C4', '#7C4594', '#B8662F', '#E0A845', '#F3DE9A'],
  ember: ['#3a1c14', '#8a2d16', '#d4502a', '#f29a3d', '#ffe3a1'],
  frost: ['#1d3b5c', '#2f6f9e', '#4fb0d6', '#9fe0f0', '#f2fbff'],
  mono: ['#4a505e', '#6f7685', '#9aa1ae', '#c9ccd3', '#ece8e1'],
};

let systemCapture = null; // { stream, analyser, node }

export function systemCaptureActive() { return !!systemCapture; }

export async function listInputDevices() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((d) => d.kind === 'audioinput');
  } catch { return []; }
}

export async function startSystemCapture() {
  stopSystemCapture();
  const { ctx } = audioGraph();
  let stream;
  if (state.info.platform === 'win32') {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    stream.getVideoTracks().forEach((t) => t.stop());
    if (!stream.getAudioTracks().length) throw new Error('Windows did not share system audio.');
  } else {
    // Linux: PipeWire / PulseAudio expose "Monitor of …" sources for every output.
    const constraints = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
    const pre = await navigator.mediaDevices.getUserMedia({ audio: true }); // unlocks device labels
    pre.getTracks().forEach((t) => t.stop());
    const inputs = await listInputDevices();
    const want = state.settings.vis.device;
    const dev = inputs.find((d) => d.deviceId === want) || inputs.find((d) => /monitor/i.test(d.label));
    if (!dev) throw new Error('No monitor source found. Pick an input in Settings → Visualizer, or enable a monitor source in pavucontrol.');
    stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: dev.deviceId }, ...constraints } });
  }
  const node = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 4096;
  analyser.smoothingTimeConstant = 0;
  analyser.minDecibels = -90;
  analyser.maxDecibels = -18;
  node.connect(analyser); // never to the speakers
  systemCapture = { stream, node, analyser };
  stream.getAudioTracks()[0].addEventListener('ended', stopSystemCapture);
  emit('capture', true);
  return true;
}

export function stopSystemCapture() {
  if (!systemCapture) return;
  systemCapture.stream.getTracks().forEach((t) => t.stop());
  systemCapture.node.disconnect();
  systemCapture = null;
  emit('capture', false);
}

// Which analyser to read right now (null = nothing to show).
function currentAnalyser() {
  const src = state.settings.vis.source;
  const ownAudio = engine.source === 'local' || engine.source === 'preview';
  if (src === 'player') return ownAudio ? audioGraph().analyser : null;
  if (src === 'system') return systemCapture?.analyser || null;
  if (ownAudio) return audioGraph().analyser;
  return systemCapture?.analyser || null;
}

export function hasSignal() { return !!currentAnalyser(); }

export class Visualizer {
  constructor(canvas, { bars, style, compact = false, fpsCap = 60 } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: true, desynchronized: true });
    this.compact = compact;
    this.fixedBars = bars;
    this.fixedStyle = style;
    this.frameMs = 1000 / fpsCap;
    this.running = false;
    this.visible = true;
    this.last = 0;
    this.freq = new Uint8Array(2048);
    this.wave = new Uint8Array(2048);
    this.levels = new Float32Array(256);
    this.peaks = new Float32Array(256);
    this.peakHold = new Float32Array(256);
    this.bands = null;
    this.gradient = null;
    this.sizeKey = '';
    this.io = new IntersectionObserver((e) => { this.visible = e[0].isIntersecting; this.kick(); });
    this.io.observe(canvas);
    this.loop = this.loop.bind(this);
    this.onVis = () => this.kick();
    document.addEventListener('visibilitychange', this.onVis);
  }

  get style() { return this.fixedStyle || state.settings.vis.style; }
  get count() { return this.fixedBars || state.settings.vis.bars; }

  start() { this.running = true; this.kick(); }
  stop() { this.running = false; }
  destroy() {
    this.running = false;
    this.io.disconnect();
    document.removeEventListener('visibilitychange', this.onVis);
  }
  kick() {
    if (this.running && this.visible && !document.hidden && !this.raf) this.raf = requestAnimationFrame(this.loop);
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
    const hgt = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    const key = `${w}x${hgt}|${state.settings.vis.palette}|${this.style}`;
    if (this.canvas.width !== w || this.canvas.height !== hgt) { this.canvas.width = w; this.canvas.height = hgt; }
    if (key !== this.sizeKey) {
      this.sizeKey = key;
      const pal = PALETTES[state.settings.vis.palette] || PALETTES.temper;
      const g = this.style === 'radial'
        ? this.ctx.createRadialGradient(w / 2, hgt / 2, Math.min(w, hgt) * 0.16, w / 2, hgt / 2, Math.min(w, hgt) * 0.5)
        : this.ctx.createLinearGradient(0, hgt, 0, this.style === 'mirror' ? hgt / 2 : 0);
      pal.forEach((c, i) => g.addColorStop(i / (pal.length - 1), c));
      if (this.style === 'mirror') {
        const g2 = this.ctx.createLinearGradient(0, 0, 0, hgt);
        const n = pal.length - 1;
        pal.forEach((c, i) => { g2.addColorStop(0.5 - (i / n) * 0.5, c); g2.addColorStop(0.5 + (i / n) * 0.5, c); });
        this.gradient = g2;
      } else this.gradient = g;
    }
    return { w, h: hgt, dpr };
  }

  // Log-spaced frequency bands 32 Hz – 16 kHz.
  buildBands(n, binCount, sampleRate) {
    const key = `${n}|${binCount}|${sampleRate}`;
    if (this.bandKey === key) return;
    this.bandKey = key;
    const lo = 32; const hi = 16000;
    const hz = sampleRate / 2 / binCount;
    this.bands = new Uint16Array((n + 1));
    for (let i = 0; i <= n; i++) {
      const f = lo * Math.pow(hi / lo, i / n);
      this.bands[i] = Math.min(binCount - 1, Math.max(1, Math.round(f / hz)));
    }
    for (let i = 1; i <= n; i++) if (this.bands[i] <= this.bands[i - 1]) this.bands[i] = Math.min(binCount - 1, this.bands[i - 1] + 1);
  }

  loop(now) {
    this.raf = null;
    if (!this.running || !this.visible || document.hidden) return;
    this.raf = requestAnimationFrame(this.loop);
    if (now - this.last < this.frameMs - 1) return;
    const dt = Math.min(0.1, (now - this.last) / 1000 || 0.016);
    this.last = now;

    const { w, h: hh, dpr } = this.resize();
    const ctx = this.ctx;
    ctx.clearRect(0, 0, w, hh);
    const an = currentAnalyser();
    const n = Math.min(this.count, 256);
    const playing = engine.state === 'playing';

    if (an) {
      if (this.freq.length !== an.frequencyBinCount) {
        this.freq = new Uint8Array(an.frequencyBinCount);
        this.wave = new Uint8Array(an.fftSize);
      }
      if (this.style === 'wave') an.getByteTimeDomainData(this.wave);
      else {
        an.getByteFrequencyData(this.freq);
        this.buildBands(n, an.frequencyBinCount, an.context.sampleRate);
      }
    }

    // Smooth levels: fast attack, gravity fall (cava-like).
    const smooth = state.settings.vis.smoothing;
    const sens = state.settings.vis.sensitivity || 1;
    if (this.style !== 'wave') {
      for (let i = 0; i < n; i++) {
        let v = 0;
        if (an && playing) {
          const a = this.bands[i]; const b = Math.max(a + 1, this.bands[i + 1]);
          let m = 0;
          for (let k = a; k < b; k++) if (this.freq[k] > m) m = this.freq[k];
          // tilt: lift highs a little so the right side is not always empty
          v = Math.min(1, (m / 255) * sens * (0.85 + 0.35 * (i / n)));
          v = v * v * (3 - 2 * v); // smoothstep for contrast
        }
        const prev = this.levels[i];
        this.levels[i] = v > prev ? prev + (v - prev) * (1 - smooth * 0.6) : Math.max(v, prev - dt * (1.6 - smooth));
        if (this.levels[i] >= this.peaks[i]) { this.peaks[i] = this.levels[i]; this.peakHold[i] = 0.35; }
        else if ((this.peakHold[i] -= dt) <= 0) this.peaks[i] = Math.max(0, this.peaks[i] - dt * 0.9);
      }
    }

    ctx.fillStyle = this.gradient;
    ctx.strokeStyle = this.gradient;
    if (this.style === 'bars') this.drawBars(ctx, n, w, hh, dpr);
    else if (this.style === 'mirror') this.drawMirror(ctx, n, w, hh, dpr);
    else if (this.style === 'radial') this.drawRadial(ctx, n, w, hh, dpr);
    else this.drawWave(ctx, w, hh, dpr, an && playing);

    // Nothing to read: let the loop idle down once the bars have fallen.
    if (!an || !playing) {
      let any = false;
      for (let i = 0; i < n; i++) if (this.levels[i] > 0.002 || this.peaks[i] > 0.002) { any = true; break; }
      if (!any || this.style === 'wave') { cancelAnimationFrame(this.raf); this.raf = null; clearTimeout(this.idleTimer); this.idleTimer = setTimeout(() => this.kick(), 400); }
    }
  }

  drawBars(ctx, n, w, hh, dpr) {
    const gap = this.compact ? 1 * dpr : Math.max(1, Math.round(w / n * 0.22));
    const bw = (w - gap * (n - 1)) / n;
    const peaks = state.settings.vis.peaks && !this.compact;
    const minH = this.compact ? 1.5 * dpr : 2 * dpr;
    for (let i = 0; i < n; i++) {
      const x = i * (bw + gap);
      const bh = Math.max(minH, this.levels[i] * hh);
      ctx.fillRect(x, hh - bh, bw, bh);
      if (peaks && this.peaks[i] > 0.02) ctx.fillRect(x, hh - this.peaks[i] * hh - 3 * dpr, bw, 2 * dpr);
    }
  }

  drawMirror(ctx, n, w, hh, dpr) {
    const gap = Math.max(1, Math.round(w / n * 0.25));
    const bw = (w - gap * (n - 1)) / n;
    const mid = hh / 2;
    for (let i = 0; i < n; i++) {
      const x = i * (bw + gap);
      const bh = Math.max(1.5 * dpr, this.levels[i] * mid * 0.96);
      ctx.fillRect(x, mid - bh, bw, bh * 2);
    }
  }

  drawRadial(ctx, n, w, hh, dpr) {
    const cx = w / 2; const cy = hh / 2;
    const r0 = Math.min(w, hh) * 0.2;
    const span = Math.min(w, hh) * 0.28;
    ctx.lineWidth = Math.max(2 * dpr, (Math.PI * 2 * r0) / n * 0.55);
    ctx.lineCap = 'round';
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 - Math.PI / 2;
      const len = 2 * dpr + this.levels[i] * span;
      const cos = Math.cos(a); const sin = Math.sin(a);
      ctx.moveTo(cx + cos * r0, cy + sin * r0);
      ctx.lineTo(cx + cos * (r0 + len), cy + sin * (r0 + len));
    }
    ctx.stroke();
  }

  drawWave(ctx, w, hh, dpr, live) {
    const data = this.wave;
    const len = data.length;
    ctx.lineWidth = 2 * dpr;
    ctx.lineJoin = 'round';
    const pal = PALETTES[state.settings.vis.palette] || PALETTES.temper;
    ctx.strokeStyle = pal[3];
    ctx.beginPath();
    const step = Math.max(1, Math.floor(len / (w / dpr)));
    for (let i = 0, x = 0; i < len; i += step, x += (w / len) * step) {
      const v = live ? (data[i] - 128) / 128 : 0;
      const y = hh / 2 + v * hh * 0.42 * (state.settings.vis.sensitivity || 1);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
}
