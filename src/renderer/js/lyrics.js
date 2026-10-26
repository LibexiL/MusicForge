// Lyrics: sidecar .lrc / embedded tags for local files, LRCLIB for everything else.
// LyricsView keeps the active line centred, follows playback smoothly, and seeks on click.
import { mf, state, save } from './state.js';
import { lrclib } from './services.js';
import { engine } from './player/engine.js';
import { h, clear } from './util.js';

const cache = new Map();

export function parseLRC(text) {
  const lines = [];
  let offset = 0;
  for (const raw of text.split(/\r?\n/)) {
    const off = /^\[offset:\s*([+-]?\d+)\]/i.exec(raw);
    if (off) { offset = +off[1] / 1000; continue; }
    const stamps = [...raw.matchAll(/\[(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)\]/g)];
    if (!stamps.length) continue;
    const content = raw.replace(/\[[^\]]*\]/g, '').trim();
    for (const s of stamps) lines.push({ t: +s[1] * 60 + parseFloat(s[2].replace(':', '.')) - offset, text: content });
  }
  lines.sort((a, b) => a.t - b.t);
  return lines;
}

export async function getLyrics(track) {
  if (!track) return null;
  if (cache.has(track.key)) return cache.get(track.key);
  let result = null;
  try {
    if (track.src?.local) {
      const text = await mf.invoke('library:lyrics', track.src.local);
      if (text) {
        const lines = parseLRC(text);
        result = lines.length ? { synced: true, lines, source: 'file' } : { synced: false, plain: text, source: 'file' };
      }
    }
    if (!result) {
      const l = await lrclib.find(track);
      if (l?.instrumental) result = { instrumental: true, source: 'LRCLIB' };
      else if (l?.syncedLyrics) result = { synced: true, lines: parseLRC(l.syncedLyrics), source: 'LRCLIB' };
      else if (l?.plainLyrics) result = { synced: false, plain: l.plainLyrics, source: 'LRCLIB' };
    }
  } catch (err) {
    return { error: err.message };
  }
  if (cache.size > 200) cache.delete(cache.keys().next().value);
  cache.set(track.key, result);
  return result;
}

function findLine(lines, t) {
  let lo = 0; let hi = lines.length - 1; let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].t <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

export class LyricsView {
  constructor(container, { big = false } = {}) {
    this.el = container;
    this.big = big;
    this.lines = null;
    this.nodes = [];
    this.active = -2;
    this.userScrollUntil = 0;
    this.raf = null;
    this.key = null;
    this.el.classList.add('lyrics', big ? 'lyrics-big' : 'lyrics-small');
    this.el.addEventListener('wheel', () => { this.userScrollUntil = performance.now() + 3500; }, { passive: true });
    this.frame = this.frame.bind(this);
  }

  async load(track) {
    if (!track) { this.message('Nothing playing.'); return; }
    if (this.key === track.key && this.lines !== undefined) return;
    this.key = track.key;
    this.lines = undefined;
    this.message('Finding lyrics…', 'muted');
    const res = await getLyrics(track);
    if (this.key !== track.key) return;
    if (!res) { this.lines = null; this.message('No lyrics found for this song.'); return; }
    if (res.error) { this.lines = null; this.message(`Couldn't reach the lyrics service: ${res.error}`); return; }
    if (res.instrumental) { this.lines = null; this.message('Instrumental'); return; }
    clear(this.el);
    if (res.synced) {
      this.lines = res.lines;
      this.nodes = res.lines.map((l, i) => h('p', { class: 'ly-line', dataset: { i }, onclick: () => engine.seek(l.t + 0.05) }, l.text || '♪'));
      this.el.append(h('div', { class: 'ly-pad' }), ...this.nodes, h('div', { class: 'ly-pad' }), h('p', { class: 'ly-credit' }, `Lyrics: ${res.source}`));
      this.active = -2;
      this.start();
    } else {
      this.lines = null;
      this.el.append(h('div', { class: 'ly-plain' }, res.plain), h('p', { class: 'ly-credit' }, `Unsynced lyrics · ${res.source}`));
    }
  }

  message(text, cls = '') { clear(this.el).append(h('p', { class: `ly-msg ${cls}` }, text)); }

  start() { if (!this.raf) this.raf = requestAnimationFrame(this.frame); }
  stop() { cancelAnimationFrame(this.raf); this.raf = null; }

  frame() {
    this.raf = null;
    if (!this.el.isConnected) return;
    if (!this.lines) return;
    this.raf = requestAnimationFrame(this.frame);
    if (document.hidden) return;
    const t = engine.time() + (state.settings.lyricsOffset || 0) + 0.15;
    const i = findLine(this.lines, t);
    if (i === this.active) return;
    this.nodes[this.active]?.classList.remove('on');
    this.nodes.forEach((n, k) => n.classList.toggle('past', k < i));
    this.active = i;
    const node = this.nodes[i];
    if (!node) return;
    node.classList.add('on');
    if (performance.now() > this.userScrollUntil) {
      const target = node.offsetTop - this.el.clientHeight * (this.big ? 0.38 : 0.4) + node.offsetHeight / 2;
      this.el.scrollTo({ top: target, behavior: state.settings.reduceMotion ? 'auto' : 'smooth' });
    }
  }
}

export function nudgeOffset(delta) {
  state.settings.lyricsOffset = Math.round(((state.settings.lyricsOffset || 0) + delta) * 10) / 10;
  save('settings');
  return state.settings.lyricsOffset;
}
