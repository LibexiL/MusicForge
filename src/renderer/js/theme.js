// Accent colour follows the album art (or a fixed colour from Settings).
import { mf, state } from './state.js';

const root = document.documentElement;
const cache = new Map();

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return [233, 185, 73];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b); const min = Math.min(r, g, b);
  let hh = 0; let s = 0; const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    hh = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    hh /= 6;
  }
  return [hh, s, l];
}

function hslToRgb(hh, s, l) {
  if (s === 0) return [l * 255, l * 255, l * 255].map(Math.round);
  const f = (p, q, t) => {
    if (t < 0) t += 1; if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [f(p, q, hh + 1 / 3), f(p, q, hh), f(p, q, hh - 1 / 3)].map((v) => Math.round(v * 255));
}

export function applyAccent(rgb) {
  const [r, g, b] = rgb;
  root.style.setProperty('--accent', `rgb(${r} ${g} ${b})`);
  root.style.setProperty('--accent-rgb', `${r} ${g} ${b}`);
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  root.style.setProperty('--accent-ink', lum > 0.55 ? '#1b1e25' : '#ffffff');
}

export function resetAccent() { applyAccent(hexToRgb(state.settings.accent)); }

// Most vivid colour in the artwork, lifted so it reads on a dark background.
async function extract(url) {
  let blob;
  if (url.startsWith(location.origin)) blob = await (await fetch(url)).blob();
  else {
    const { type, data } = await mf.invoke('api:image', url);
    blob = new Blob([data], { type });
  }
  const bmp = await createImageBitmap(blob, { resizeWidth: 40, resizeHeight: 40, resizeQuality: 'low' });
  const c = new OffscreenCanvas(40, 40);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  const px = ctx.getImageData(0, 0, 40, 40).data;
  const buckets = new Map();
  for (let i = 0; i < px.length; i += 4) {
    const [hh, s, l] = rgbToHsl(px[i], px[i + 1], px[i + 2]);
    if (l < 0.12 || l > 0.92) continue;
    const key = Math.round(hh * 24);
    const w = s * s * (1 - Math.abs(l - 0.5) * 1.4);
    const b = buckets.get(key) || { w: 0, h: 0, s: 0, l: 0 };
    b.w += w; b.h += hh * w; b.s += s * w; b.l += l * w;
    buckets.set(key, b);
  }
  let best = null;
  for (const b of buckets.values()) if (!best || b.w > best.w) best = b;
  if (!best || best.w < 0.6) return null; // greyscale art → keep the resting accent
  const hh = best.h / best.w;
  const s = Math.min(0.85, Math.max(0.45, best.s / best.w));
  const l = Math.min(0.72, Math.max(0.6, best.l / best.w));
  return hslToRgb(hh, s, l);
}

let lastUrl = null;
export async function accentFromArt(url) {
  if (!state.settings.dynamicAccent || !url) { lastUrl = null; resetAccent(); return; }
  lastUrl = url;
  try {
    let rgb = cache.get(url);
    if (rgb === undefined) {
      rgb = await extract(url);
      if (cache.size > 300) cache.delete(cache.keys().next().value);
      cache.set(url, rgb);
    }
    if (lastUrl !== url) return;
    if (rgb) applyAccent(rgb); else resetAccent();
  } catch {
    if (lastUrl === url) resetAccent();
  }
}

export function applyMotion() {
  document.body.classList.toggle('reduce-motion', !!state.settings.reduceMotion);
}
