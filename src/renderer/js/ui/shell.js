import { h, icon, iconBtn, fmtTime, img, clear, debounce } from '../util.js';
import { state, on, emit, mf, isLiked, toggleLike, save } from '../state.js';
import { engine } from '../player/engine.js';
import { go, goBack, goForward, currentRoute, canGoBack, canGoForward } from '../router.js';
import { slider, srcBadge, trackMenu, prompt, toast } from './components.js';
import { LyricsView } from '../lyrics.js';
import { Visualizer } from '../visualizer.js';
import { createPlaylist } from '../playlists.js';
import { onEmbedExpand } from './embed.js';

const NAV = [
  { id: 'home', text: 'Home', icon: 'home' },
  { id: 'search', text: 'Search', icon: 'search' },
  { id: 'library', text: 'Library', icon: 'library' },
  { id: 'nowplaying', text: 'Now playing', icon: 'wave' },
  { id: 'stats', text: 'Stats', icon: 'stats' },
  { id: 'artists', text: 'Artist watch', icon: 'artist' },
];
const NAV_BOTTOM = [
  { id: 'accounts', text: 'Accounts', icon: 'link' },
  { id: 'settings', text: 'Settings', icon: 'settings' },
];

let panelTab = null; // 'queue' | 'lyrics' | null

export function init() {
  buildTitlebar();
  buildSidebar();
  buildPlayerbar();
  buildPanel();
  shortcuts();
  mf.on('player:command', debouncedCommand);
  onEmbedExpand(() => go('nowplaying'));
  document.getElementById('embed-expand').append(icon('expand', 14));
}

// ---------------------------------------------------------------- title bar
function buildTitlebar() {
  const backBtn = document.getElementById('nav-back');
  const fwdBtn = document.getElementById('nav-fwd');
  backBtn.append(icon('back', 18));
  fwdBtn.append(icon('fwd', 18));
  backBtn.onclick = goBack;
  fwdBtn.onclick = goForward;
  document.querySelector('.search-icon').append(icon('search', 16));
  const input = document.getElementById('search-input');
  const run = () => {
    const q = input.value.trim();
    if (!q) return;
    const r = currentRoute();
    go('search', { q }, { replace: r?.name === 'search' });
  };
  input.addEventListener('input', debounce(run, 380));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') run();
    if (e.key === 'Escape') { input.value = ''; input.blur(); }
  });
  on('route', (r) => {
    backBtn.disabled = !canGoBack();
    fwdBtn.disabled = !canGoForward();
    if (r.name === 'search' && r.params.q && input.value !== r.params.q) input.value = r.params.q;
  });
}

// ---------------------------------------------------------------- sidebar
function buildSidebar() {
  const navEl = document.getElementById('nav');
  const navBottom = document.getElementById('nav-bottom');
  const item = (n) => h('li', null, h('button', { dataset: { id: n.id }, onclick: () => go(n.id) }, icon(n.icon, 19), n.text));
  navEl.append(...NAV.map(item));
  navBottom.append(...NAV_BOTTOM.map(item));

  const newBtn = document.getElementById('new-playlist');
  newBtn.append(icon('plus', 16));
  newBtn.onclick = async () => {
    const name = await prompt({ title: 'New playlist', placeholder: 'Playlist name', ok: 'Create' });
    if (name) { const p = createPlaylist(name); go('playlist', { id: p.id }); }
  };

  const plNav = document.getElementById('playlist-nav');
  const renderPlaylists = () => {
    clear(plNav);
    if (!state.playlists.length) {
      plNav.append(h('li', { class: 'sidebar-empty' }, 'Make one with +, or import from Spotify, YouTube or Deezer in Library.'));
      return;
    }
    const r = currentRoute();
    for (const p of state.playlists) {
      const art = p.tracks.find((t) => t.art)?.art;
      const playing = engine.context?.type === 'playlist' && engine.context.id === p.id;
      plNav.append(h('li', null, h('button', {
        class: r?.name === 'playlist' && r.params.id === p.id ? 'active' : '',
        onclick: () => go('playlist', { id: p.id }),
        title: p.name,
      }, art ? img(art) : h('span', { class: 'pl-art-empty' }, icon('note', 15)), h('span', { class: 'nm' }, p.name), playing ? h('span', { class: 'playing-dot', title: 'Playing' }) : null)));
    }
  };
  renderPlaylists();
  on('playlists', renderPlaylists);
  on('change:playlists', renderPlaylists);
  on('queue', debounce(renderPlaylists, 50));

  on('route', (r) => {
    document.querySelectorAll('.nav button').forEach((b) => b.classList.toggle('active', b.dataset.id === r.name || (r.name === 'artist' && b.dataset.id === 'artists')));
    plNav.querySelectorAll('button').forEach((b, i) => b.classList.toggle('active', r.name === 'playlist' && state.playlists[i]?.id === r.params.id));
  });
}

// ---------------------------------------------------------------- player bar
function buildPlayerbar() {
  const bar = document.getElementById('playerbar');
  const art = img(null, '', 'pb-art');
  art.onclick = () => go('nowplaying');
  const title = h('div', { class: 'pb-title', onclick: () => go('nowplaying') }, 'Nothing playing');
  const artist = h('div', { class: 'pb-artist' });
  const srcLine = h('div', { class: 'pb-src' });
  const likeBtn = iconBtn('heart', 'Like', () => {
    if (!engine.track) return;
    const l = toggleLike(engine.track);
    toast(l ? 'Added to Liked' : 'Removed from Liked');
    paintLike();
    emit('likes');
  }, { class: 'small', size: 18 });
  const paintLike = () => {
    const l = isLiked(engine.track);
    likeBtn.replaceChildren(icon(l ? 'heartFill' : 'heart', 18));
    likeBtn.classList.toggle('on', l);
    likeBtn.title = l ? 'Remove from Liked' : 'Like';
  };
  on('likes', paintLike);
  const now = h('div', { class: 'pb-now', oncontextmenu: (e) => { if (engine.track) { e.preventDefault(); trackMenu(engine.track, e); } } },
    art, h('div', { class: 'pb-meta' }, title, artist, srcLine), likeBtn);

  const shuffleBtn = iconBtn('shuffle', 'Shuffle (S)', () => engine.toggleShuffle(), { size: 18 });
  const prevBtn = iconBtn('prev', 'Previous (Ctrl+Left)', () => engine.prev(), { size: 18 });
  const playBtn = h('button', { class: 'pb-play', title: 'Play (Space)', 'aria-label': 'Play', onclick: () => engine.toggle() }, icon('play', 18));
  const nextBtn = iconBtn('next', 'Next (Ctrl+Right)', () => engine.next(), { size: 18 });
  const repeatBtn = iconBtn('repeat', 'Repeat (R)', () => engine.cycleRepeat(), { size: 18 });
  const tCur = h('span', { class: 'tm' }, '0:00');
  const tDur = h('span', { class: 'tm' }, '0:00');
  const seek = slider({ value: 0, max: 1, label: 'Seek', format: fmtTime, onInput: (v) => { tCur.textContent = fmtTime(v); }, onCommit: (v) => engine.seek(v) });
  const center = h('div', { class: 'pb-center' },
    h('div', { class: 'pb-controls' }, shuffleBtn, prevBtn, playBtn, nextBtn, repeatBtn),
    h('div', { class: 'pb-seek' }, tCur, seek.el, tDur));

  const visCanvas = h('canvas', { class: 'pb-vis', 'aria-hidden': 'true' });
  const lyricsBtn = iconBtn('lyrics', 'Lyrics (L)', () => togglePanel('lyrics'), { size: 19 });
  const npBtn = iconBtn('expand', 'Now playing (N)', () => go('nowplaying'), { size: 18 });
  const videoBtn = iconBtn('video', 'Music video', () => go('video'), { size: 19 });
  const queueBtn = iconBtn('queue', 'Queue (Q)', () => togglePanel('queue'), { size: 19 });
  const volBtn = iconBtn('volume', 'Mute (M)', () => engine.toggleMute(), { size: 19 });
  const vol = slider({ value: state.settings.volume, max: 1, label: 'Volume', onInput: (v) => engine.setVolume(v), onCommit: (v) => engine.setVolume(v) });
  vol.el.classList.add('pb-vol');
  const right = h('div', { class: 'pb-right' }, visCanvas, lyricsBtn, npBtn, videoBtn, queueBtn, volBtn, vol.el);
  bar.append(now, center, right);

  const mini = new Visualizer(visCanvas, { bars: 18, style: 'bars', compact: true, fpsCap: 30 });
  mini.start();

  const paintVol = () => {
    const s = state.settings;
    const v = s.muted ? 0 : s.volume;
    vol.set(v);
    volBtn.replaceChildren(icon(s.muted || v === 0 ? 'mute' : v < 0.45 ? 'volumeLow' : 'volume', 19));
  };
  paintVol();
  on('volume', paintVol);

  const paintTrack = () => {
    const t = engine.track;
    title.textContent = t ? t.title : 'Nothing playing';
    title.title = t?.title || '';
    clear(artist);
    if (t?.artist) artist.append(h('span', { style: { cursor: 'pointer' }, onclick: () => go('artist', { name: t.artist.split(',')[0].trim() }) }, t.artist));
    if (t?.art) art.src = t.art; else { art.removeAttribute('src'); }
    clear(srcLine);
    if (engine.source) {
      srcLine.append(srcBadge(engine.source));
      const sp = engine.adapters.spotify;
      if (engine.source === 'spotify' && sp.mode === 'connect' && sp.deviceName) srcLine.lastChild.append(` · on ${sp.deviceName}`);
    }
    paintLike();
    seek.set(engine.time(), engine.duration());
    tDur.textContent = fmtTime(engine.duration());
    document.title = t ? `${t.title} · ${t.artist} — MusicForge` : 'MusicForge';
  };
  const paintState = () => {
    const s = engine.state;
    playBtn.classList.toggle('loading', s === 'loading');
    playBtn.replaceChildren(icon(s === 'playing' ? 'pause' : 'play', 18));
    playBtn.title = s === 'playing' ? 'Pause (Space)' : 'Play (Space)';
    playBtn.setAttribute('aria-label', s === 'playing' ? 'Pause' : 'Play');
    if (s === 'playing') mini.start();
  };
  const paintQueue = () => {
    shuffleBtn.classList.toggle('on', engine.shuffle);
    repeatBtn.classList.toggle('on', engine.repeat !== 'off');
    repeatBtn.replaceChildren(icon(engine.repeat === 'one' ? 'repeatOne' : 'repeat', 18));
    repeatBtn.title = `Repeat: ${engine.repeat} (R)`;
  };
  let lastSec = -1;
  const paintTime = () => {
    const t = engine.time();
    const d = engine.duration();
    if (!seek.dragging) seek.set(t, d);
    const sec = Math.floor(t);
    if (sec !== lastSec && !seek.dragging) { lastSec = sec; tCur.textContent = fmtTime(t); tDur.textContent = fmtTime(d); }
  };
  on('track', paintTrack);
  on('state', paintState);
  on('queue', paintQueue);
  on('time', paintTime);
  paintTrack(); paintState(); paintQueue();

  on('panel', () => {
    lyricsBtn.classList.toggle('on', panelTab === 'lyrics');
    queueBtn.classList.toggle('on', panelTab === 'queue');
  });
  on('route', (r) => {
    npBtn.classList.toggle('on', r.name === 'nowplaying');
    videoBtn.classList.toggle('on', r.name === 'video');
  });
}

// ---------------------------------------------------------------- side panel (queue + lyrics)
let lyricsView = null;
function buildPanel() {
  const panel = document.getElementById('panel');
  const tabQ = h('button', { class: 'panel-tab', onclick: () => setPanel('queue') }, 'Queue');
  const tabL = h('button', { class: 'panel-tab', onclick: () => setPanel('lyrics') }, 'Lyrics');
  const body = h('div', { class: 'panel-body' });
  const lyr = h('div', { class: 'panel-body' });
  panel.append(h('div', { class: 'panel-head' }, tabQ, tabL, h('span', { class: 'spacer' }), iconBtn('close', 'Close panel', () => setPanel(null), { class: 'small', size: 16 })), body, lyr);
  lyricsView = new LyricsView(lyr);

  const renderQueue = () => {
    if (panelTab !== 'queue') return;
    clear(body);
    const q = engine.queue;
    if (!q.length) {
      body.append(h('p', { class: 'sidebar-empty', style: { padding: '16px 8px' } }, 'The queue is empty. Play something, or right-click a song and choose Add to queue.'));
      return;
    }
    const item = (t, i) => {
      const el = h('div', {
        class: `q-item ${i === engine.index ? 'now' : ''}`, draggable: i !== engine.index, dataset: { i },
        ondblclick: () => engine.jump(i),
        oncontextmenu: (e) => { e.preventDefault(); trackMenu(t, e, { list: q, index: i }); },
      }, img(t.art), h('div', { class: 'tt' }, h('div', { class: 't' }, t.title), h('div', { class: 'a' }, t.artist)),
      i !== engine.index ? iconBtn('close', 'Remove from queue', () => engine.removeAt(i), { class: 'small', size: 15 }) : null);
      el.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/q', String(i)); el.classList.add('dragging'); });
      el.addEventListener('dragend', () => el.classList.remove('dragging'));
      el.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('text/q')) { e.preventDefault(); el.classList.add('drop-before'); } });
      el.addEventListener('dragleave', () => el.classList.remove('drop-before'));
      el.addEventListener('drop', (e) => {
        e.preventDefault();
        el.classList.remove('drop-before');
        const from = +e.dataTransfer.getData('text/q');
        let to = i;
        if (from < to) to--;
        engine.move(from, Math.max(engine.index + 1, to));
      });
      return el;
    };
    body.append(h('div', { class: 'q-label' }, 'Now playing'), item(q[engine.index] || q[0], Math.max(0, engine.index)));
    const upcoming = q.slice(engine.index + 1);
    if (upcoming.length) {
      body.append(h('div', { class: 'q-label row' }, h('span', null, `Next up · ${upcoming.length}`), h('span', { class: 'spacer' }), h('button', { class: 'link-btn', onclick: () => engine.clearUpcoming() }, 'Clear')));
      upcoming.slice(0, 300).forEach((t, k) => body.append(item(t, engine.index + 1 + k)));
      if (upcoming.length > 300) body.append(h('p', { class: 'sidebar-empty' }, `…and ${upcoming.length - 300} more`));
    } else if (engine.repeat !== 'all') {
      body.append(h('p', { class: 'sidebar-empty', style: { padding: '12px 8px' } }, 'Nothing after this song.'));
    }
  };

  const show = () => {
    panel.hidden = !panelTab;
    tabQ.classList.toggle('on', panelTab === 'queue');
    tabL.classList.toggle('on', panelTab === 'lyrics');
    body.hidden = panelTab !== 'queue';
    lyr.hidden = panelTab !== 'lyrics';
    if (panelTab === 'queue') renderQueue();
    if (panelTab === 'lyrics') { lyricsView.key = null; lyricsView.load(engine.track); } else lyricsView.stop();
    emit('panel', panelTab);
    window.dispatchEvent(new Event('resize'));
  };
  setPanel = (tab) => { panelTab = tab; show(); };
  on('queue', renderQueue);
  on('track', () => { renderQueue(); if (panelTab === 'lyrics') lyricsView.load(engine.track); });
}
let setPanel = () => {};
export function togglePanel(tab) { setPanel(panelTab === tab ? null : tab); }

// ---------------------------------------------------------------- keyboard + remote commands
let lastCmd = { c: '', t: 0 };
function debouncedCommand(cmd) {
  const now = performance.now();
  if (lastCmd.c === cmd && now - lastCmd.t < 350) return;
  lastCmd = { c: cmd, t: now };
  if (cmd === 'toggle') engine.toggle();
  else if (cmd === 'next') engine.next();
  else if (cmd === 'prev') engine.prev();
  else if (cmd === 'pause') engine.pause();
}

function shortcuts() {
  document.addEventListener('keydown', (e) => {
    const typing = e.target.closest('input, textarea, select, [contenteditable]');
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && e.key.toLowerCase() === 'k') { e.preventDefault(); document.getElementById('search-input').select(); return; }
    if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); goBack(); return; }
    if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); goForward(); return; }
    if (e.key === 'F11') { e.preventDefault(); mf.invoke('win:fullscreen'); return; }
    if (typing || document.querySelector('dialog[open]')) return;
    if (e.target.closest('.slider')) return;
    const k = e.key;
    if (k === ' ' && !e.target.closest('button')) { e.preventDefault(); engine.toggle(); }
    else if (k === ' ' && e.target.closest('button')) return;
    else if (ctrl && k === 'ArrowRight') { e.preventDefault(); engine.next(); }
    else if (ctrl && k === 'ArrowLeft') { e.preventDefault(); engine.prev(); }
    else if (ctrl && k === 'ArrowUp') { e.preventDefault(); engine.setVolume(state.settings.volume + 0.05); }
    else if (ctrl && k === 'ArrowDown') { e.preventDefault(); engine.setVolume(state.settings.volume - 0.05); }
    else if (k === 'ArrowRight' && !e.target.closest('.tl')) engine.seek(engine.time() + (e.shiftKey ? 15 : 5));
    else if (k === 'ArrowLeft' && !e.target.closest('.tl')) engine.seek(engine.time() - (e.shiftKey ? 15 : 5));
    else if (ctrl || e.altKey) return;
    else if (k === '/') { e.preventDefault(); document.getElementById('search-input').select(); }
    else if (k === 'l') togglePanel('lyrics');
    else if (k === 'q') togglePanel('queue');
    else if (k === 'n') go('nowplaying');
    else if (k === 'v') go('nowplaying', { vis: true });
    else if (k === 'm') engine.toggleMute();
    else if (k === 's') engine.toggleShuffle();
    else if (k === 'r') engine.cycleRepeat();
  });
}

export function persistPanel() { save('settings'); }
