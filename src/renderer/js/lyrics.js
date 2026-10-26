// Lyrics: sidecar .lrc / embedded tags for local files, LRCLIB for everything else.
// LyricsView follows playback: synced lyrics keep the current line centred; unsynced lyrics
// scroll along with the song's progress. Scrolling by hand pauses following until you press
// "Back to current line" (or it resumes by itself after a few seconds).
import { mf, state, save, emit } from './state.js';
import { lrclib, api } from './services.js';
import { engine } from './player/engine.js';
import { h, clear, icon, fmtTime } from './util.js';
import { modal, toast } from './ui/components.js';

const cache = new Map();
const RESUME_MS = 6000;

export function parseLRC(text) {
  const lines = [];
  let offset = 0;
  for (const raw of text.split(/\r?\n/)) {
    const off = /^\[offset:\s*([+-]?\d+)\]/i.exec(raw);
    if (off) { offset = +off[1] / 1000; continue; }
    const stamps = [...raw.matchAll(/\[(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)\]/g)];
    if (!stamps.length) continue;
    // Strip line stamps and enhanced-LRC word stamps like <00:12.34>.
    const content = raw.replace(/\[[^\]]*\]/g, '').replace(/<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>/g, '').replace(/\s{2,}/g, ' ').trim();
    for (const s of stamps) lines.push({ t: +s[1] * 60 + parseFloat(s[2].replace(':', '.')) - offset, text: content });
  }
  lines.sort((a, b) => a.t - b.t);
  return lines;
}

function fromRecord(l, source = 'LRCLIB') {
  if (!l) return null;
  if (l.instrumental) return { instrumental: true, source };
  if (l.syncedLyrics) return { synced: true, lines: parseLRC(l.syncedLyrics), plain: l.plainLyrics || null, source };
  if (l.plainLyrics) return { synced: false, plain: l.plainLyrics, source };
  return null;
}

export async function getLyrics(track) {
  if (!track) return null;
  if (cache.has(track.key)) return cache.get(track.key);
  let result = null;
  try {
    const picked = state.lyricsPicks?.[track.key];
    if (picked) result = fromRecord(await api('lrclib', `/get/${picked}`, { ttl: 86400 }).catch(() => null));
    if (!result && track.src?.local) {
      const text = await mf.invoke('library:lyrics', track.src.local);
      if (text) {
        const lines = parseLRC(text);
        result = lines.length ? { synced: true, lines, source: 'file' } : { synced: false, plain: text, source: 'file' };
      }
    }
    if (!result) result = fromRecord(await lrclib.find(track));
  } catch (err) {
    return { error: err.message };
  }
  if (cache.size > 200) cache.delete(cache.keys().next().value);
  cache.set(track.key, result);
  return result;
}

export function lyricsText(res) {
  if (!res) return '';
  if (res.synced) return res.lines.map((l) => l.text).join('\n');
  return res.plain || '';
}

function findLine(lines, t) {
  let lo = 0; let hi = lines.length - 1; let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].t <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

// Lyrics time = playback time minus the user's offset (positive offset = lines show later).
const lyricTime = () => engine.time() - (state.settings.lyricsOffset || 0) + 0.15;

export class LyricsView {
  constructor(container, { big = false } = {}) {
    this.el = container;
    this.big = big;
    this.res = undefined;
    this.lines = null;
    this.nodes = [];
    this.active = -2;
    this.key = null;
    this.loadingKey = null;
    this.following = true;
    this.lastUser = 0;
    this.raf = null;
    this.waits = 0;
    this.el.classList.add('lyrics', big ? 'lyrics-big' : 'lyrics-small');
    this.back = h('button', { class: 'ly-back', hidden: true, onclick: () => this.follow() }, icon('down', 14), 'Back to current line');
    const userScroll = () => { this.lastUser = performance.now(); if (this.res && !this.res.error) this.unfollow(); };
    this.el.addEventListener('wheel', userScroll, { passive: true });
    this.el.addEventListener('touchmove', userScroll, { passive: true });
    this.el.addEventListener('keydown', (e) => { if (['PageUp', 'PageDown', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) userScroll(); });
    this.ro = new ResizeObserver(() => { if (this.following) this.scrollToCurrent(true); });
    this.ro.observe(this.el);
    this.frame = this.frame.bind(this);
  }

  async load(track, force = false) {
    if (!track) { this.key = null; this.res = null; this.message('Nothing playing.'); this.stop(); return; }
    if (!force && (this.key === track.key || this.loadingKey === track.key)) return;
    this.loadingKey = track.key;
    this.key = track.key;
    this.res = undefined;
    this.lines = null;
    this.stop();
    this.message('Finding lyrics…', 'muted');
    const res = await getLyrics(track);
    if (this.loadingKey !== track.key) return;
    this.loadingKey = null;
    this.res = res;
    this.following = true;
    this.render(track);
    emit('lyrics-loaded', { key: track.key, res });
  }

  render(track) {
    const res = this.res;
    clear(this.el);
    if (!res) { this.messageWithPick('No lyrics found for this song.', track); return; }
    if (res.error) { this.message(`Couldn't reach the lyrics service. ${res.error}`); return; }
    if (res.instrumental) { this.messageWithPick('Instrumental.', track); return; }
    if (res.synced) {
      this.lines = res.lines;
      this.nodes = res.lines.map((l) => h('p', { class: 'ly-line', onclick: () => { engine.seek(l.t + (state.settings.lyricsOffset || 0) + 0.05); this.follow(); } }, l.text || '♪'));
      this.el.append(h('div', { class: 'ly-pad' }), ...this.nodes, h('div', { class: 'ly-pad' }), h('p', { class: 'ly-credit' }, res.source === 'file' ? 'Lyrics from the file' : `Lyrics: ${res.source}`));
    } else {
      this.lines = null;
      this.plainBox = h('div', { class: 'ly-plain' }, res.plain);
      this.el.append(this.plainBox, h('p', { class: 'ly-credit' }, `Not time-synced, so this scrolls with the song · ${res.source === 'file' ? 'from the file' : res.source}`));
    }
    this.el.append(this.back);
    this.back.hidden = true;
    this.active = -2;
    this.el.scrollTop = 0;
    this.start();
  }

  message(text, cls = '') { clear(this.el).append(h('p', { class: `ly-msg ${cls}` }, text)); }
  messageWithPick(text, track) {
    clear(this.el).append(h('div', { class: 'ly-msg' }, h('p', null, text),
      h('button', { class: 'btn small ghost', onclick: () => pickLyrics(track).then((ok) => ok && this.load(track, true)) }, icon('search', 14), 'Find lyrics')));
  }

  unfollow() {
    if (!this.following) return;
    this.following = false;
    this.back.hidden = false;
  }
  follow() {
    this.following = true;
    this.back.hidden = true;
    this.scrollToCurrent(false);
  }

  start() { this.waits = 0; if (!this.raf) this.raf = requestAnimationFrame(this.frame); }
  stop() { cancelAnimationFrame(this.raf); this.raf = null; }
  destroy() { this.stop(); this.ro.disconnect(); }

  frame() {
    this.raf = null;
    if (!this.res || this.res.error || this.res.instrumental) return;
    // The view may not be attached yet (screens render before they're shown); keep waiting briefly.
    if (!this.el.isConnected) { if (++this.waits < 300) this.raf = requestAnimationFrame(this.frame); return; }
    this.waits = 0;
    this.raf = requestAnimationFrame(this.frame);
    if (document.hidden || !this.el.clientHeight) return;
    if (!this.following && performance.now() - this.lastUser > RESUME_MS) this.follow();

    if (this.lines) {
      const i = findLine(this.lines, lyricTime());
      if (i === this.active) return;
      const prev = this.active;
      this.active = i;
      this.nodes[prev]?.classList.remove('on');
      if (i > prev && prev >= -1) for (let k = Math.max(0, prev); k < i; k++) this.nodes[k].classList.add('past');
      else this.nodes.forEach((n, k) => n.classList.toggle('past', k < i));
      this.nodes[i]?.classList.add('on');
      if (this.following) this.scrollToCurrent(false);
    } else if (this.following && engine.state === 'playing') {
      this.scrollToCurrent(false);
    }
  }

  scrollToCurrent(instant) {
    const behavior = instant || state.settings.reduceMotion ? 'auto' : 'smooth';
    if (this.lines) {
      const node = this.nodes[this.active];
      if (!node) { this.el.scrollTo({ top: 0, behavior }); return; }
      const target = node.offsetTop - this.el.clientHeight * (this.big ? 0.4 : 0.42) + node.offsetHeight / 2;
      this.el.scrollTo({ top: Math.max(0, target), behavior });
    } else if (this.plainBox) {
      // Unsynced: keep the part of the text matching the song's progress around the upper third.
      const d = engine.duration();
      if (!d) return;
      const p = Math.min(1, Math.max(0, (engine.time() - 8) / Math.max(1, d - 20)));
      const target = this.plainBox.offsetTop + p * this.plainBox.offsetHeight - this.el.clientHeight * 0.35;
      if (Math.abs(this.el.scrollTop - target) > 2) this.el.scrollTo({ top: Math.max(0, target), behavior: 'auto' });
    }
  }
}

export function nudgeOffset(delta) {
  state.settings.lyricsOffset = Math.round(((state.settings.lyricsOffset || 0) + delta) * 100) / 100;
  save('settings');
  emit('lyrics-offset', state.settings.lyricsOffset);
  return state.settings.lyricsOffset;
}

export function offsetLabel() {
  const o = state.settings.lyricsOffset || 0;
  return o === 0 ? 'In sync' : `${o > 0 ? '+' : '−'}${Math.abs(o).toFixed(2).replace(/0$/, '')} s`;
}

export async function copyLyrics(track) {
  const text = lyricsText(await getLyrics(track));
  if (!text) { toast('No lyrics to copy', 'error'); return; }
  await navigator.clipboard.writeText(text);
  toast('Lyrics copied');
}

// Let the user choose a different LRCLIB match (or search when nothing was found).
export function pickLyrics(track) {
  if (!track) return Promise.resolve(false);
  return modal((close) => {
    const input = h('input', { class: 'input', value: `${(track.artist || '').split(',')[0]} ${track.title}`.trim() });
    const list = h('div', { class: 'pick-list' });
    const run = async () => {
      list.replaceChildren(h('p', { class: 't-meta' }, 'Searching LRCLIB…'));
      try {
        const res = await api('lrclib', '/search', { query: { q: input.value.trim() }, ttl: 3600 });
        if (!Array.isArray(res) || !res.length) { list.replaceChildren(h('p', { class: 't-meta' }, 'No matches. Try fewer words.')); return; }
        const d = track.duration || 0;
        res.sort((a, b) => (b.syncedLyrics ? 1 : 0) - (a.syncedLyrics ? 1 : 0) || (d ? Math.abs(a.duration - d) - Math.abs(b.duration - d) : 0));
        list.replaceChildren(...res.slice(0, 25).map((r) => h('button', {
          onclick: () => {
            state.lyricsPicks = { ...(state.lyricsPicks || {}), [track.key]: r.id };
            save('lyricsPicks');
            cache.delete(track.key);
            close(true);
          },
        }, h('div', null,
          h('div', { class: 't' }, `${r.trackName} — ${r.artistName}`),
          h('div', { class: 'a' }, [r.albumName, r.duration ? fmtTime(r.duration) : null, r.instrumental ? 'Instrumental' : r.syncedLyrics ? 'Synced' : 'Not synced',
            d && r.duration ? (Math.abs(r.duration - d) < 3 ? 'same length' : `${Math.round(r.duration - d) > 0 ? '+' : ''}${Math.round(r.duration - d)} s`) : null].filter(Boolean).join(' · '))))));
      } catch (err) {
        list.replaceChildren(h('p', { class: 't-meta' }, err.message));
      }
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });
    setTimeout(run, 0);
    const resetBtn = state.lyricsPicks?.[track.key] ? h('button', { class: 'btn ghost', onclick: () => {
      const next = { ...state.lyricsPicks }; delete next[track.key]; state.lyricsPicks = next; save('lyricsPicks'); cache.delete(track.key); close(true);
    } }, 'Use automatic match') : null;
    return h('div', null,
      h('div', { class: 'modal-body' }, h('h2', null, 'Choose lyrics'), h('p', null, `For “${track.title}”. Pick the version that matches; MusicForge remembers it.`),
        h('div', { class: 'key-row' }, input, h('button', { class: 'btn ghost', onclick: run }, 'Search')), list),
      h('div', { class: 'modal-actions' }, resetBtn, h('button', { class: 'btn ghost', onclick: () => close(false) }, 'Cancel')));
  });
}
