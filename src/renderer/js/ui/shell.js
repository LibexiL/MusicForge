import { h, icon, iconBtn, fmtTime, img, setImg, clear, debounce } from '../util.js';
import { state, on, emit, mf, isLiked, toggleLike, save } from '../state.js';
import { engine } from '../player/engine.js';
import { go, goBack, goForward, currentRoute, canGoBack, canGoForward } from '../router.js';
import { slider, srcBadge, trackMenu, prompt, toast, menu, modal, confirm } from './components.js';
import { LyricsView, nudgeOffset, offsetLabel, pickLyrics, copyLyrics } from '../lyrics.js';
import { Visualizer } from '../visualizer.js';
import { createPlaylist, addToPlaylist, renamePlaylist, deletePlaylist } from '../playlists.js';
import { onEmbedExpand, onEmbedToggle, setEmbedPaused } from './embed.js';
import { sleep, setSleep } from '../sleep.js';

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
  onEmbedToggle(() => engine.toggle());
  on('state', () => setEmbedPaused(engine.state === 'paused'));
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
    // Keep the chosen type/source filters while editing the search text.
    go('search', { ...(r?.name === 'search' ? r.params : {}), q }, { replace: r?.name === 'search' });
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
      const btn = h('button', {
        class: r?.name === 'playlist' && r.params.id === p.id ? 'active' : '',
        onclick: () => go('playlist', { id: p.id }),
        title: `${p.name} · ${p.tracks.length} songs`,
        oncontextmenu: (e) => { e.preventDefault(); playlistMenu(p, e); },
      }, art ? img(art) : h('span', { class: 'pl-art-empty' }, icon('note', 15)), h('span', { class: 'nm' }, p.name), playing ? h('span', { class: 'playing-dot', title: 'Playing' }) : null);
      // Drop songs dragged from any list onto a playlist to add them.
      btn.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('application/x-mf-tracks')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; btn.classList.add('drop'); } });
      btn.addEventListener('dragleave', () => btn.classList.remove('drop'));
      btn.addEventListener('drop', (e) => {
        e.preventDefault();
        btn.classList.remove('drop');
        try {
          const tracks = JSON.parse(e.dataTransfer.getData('application/x-mf-tracks'));
          const n = addToPlaylist(p.id, tracks);
          toast(n ? `Added ${n === 1 ? `“${tracks[0].title}”` : `${n} songs`} to “${p.name}”` : `Already in “${p.name}”`);
          emit('playlist-changed', p.id);
        } catch { /* not ours */ }
      });
      plNav.append(h('li', null, btn));
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
  const tDur = h('button', { class: 'tm tm-btn', title: 'Show remaining time' }, '0:00');
  tDur.onclick = () => { state.settings.remainingTime = !state.settings.remainingTime; save('settings'); lastSec = -1; paintTime(); };
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
  const sleepPill = h('button', { class: 'sleep-pill', hidden: true, title: 'Sleep timer. Click to change.' });
  const moreBtn = iconBtn('more', 'More', (e) => playerMenu(e), { size: 19 });
  sleepPill.onclick = (e) => playerMenu(e);
  const vol = slider({ value: state.settings.volume, max: 1, label: 'Volume', onInput: (v) => engine.setVolume(v), onCommit: (v) => engine.setVolume(v) });
  vol.el.classList.add('pb-vol');
  const right = h('div', { class: 'pb-right' }, visCanvas, sleepPill, lyricsBtn, npBtn, videoBtn, queueBtn, moreBtn, volBtn, vol.el);
  const wheelVol = (e) => { e.preventDefault(); engine.setVolume((state.settings.muted ? 0 : state.settings.volume) + (e.deltaY < 0 ? 0.05 : -0.05)); };
  vol.el.addEventListener('wheel', wheelVol, { passive: false });
  volBtn.addEventListener('wheel', wheelVol, { passive: false });
  const paintSleep = () => {
    const sl = sleep.mode;
    sleepPill.hidden = !sl;
    if (sl === 'track') sleepPill.replaceChildren(icon('moon', 14), 'End of song');
    else if (sl === 'time') sleepPill.replaceChildren(icon('moon', 14), `${Math.max(1, Math.ceil((sleep.until - Date.now()) / 60000))} min`);
  };
  on('sleep', paintSleep);
  setInterval(() => { if (sleep.mode === 'time') paintSleep(); }, 15000);
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
    setImg(art, t?.art);
    clear(srcLine);
    if (engine.source) {
      srcLine.append(srcBadge(engine.source));
      const sp = engine.adapters.spotify;
      if (engine.source === 'spotify' && sp.mode === 'connect' && sp.deviceName) srcLine.lastChild.append(` · on ${sp.deviceName}`);
    }
    paintLike();
    seek.set(engine.time(), engine.duration());
    lastSec = -1;
    paintTime();
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
    if (sec !== lastSec && !seek.dragging) {
      lastSec = sec;
      tCur.textContent = fmtTime(t);
      tDur.textContent = state.settings.remainingTime && d ? `−${fmtTime(Math.max(0, d - t))}` : fmtTime(d);
      tDur.title = state.settings.remainingTime ? 'Show total length' : 'Show remaining time';
    }
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
  const offText = h('span', { class: 'np-offset' }, offsetLabel());
  const lyTools = h('div', { class: 'panel-tools' },
    iconBtn('back', 'Show lyrics earlier ([)', () => nudgeOffset(-0.25), { class: 'small', size: 14 }), offText,
    iconBtn('fwd', 'Show lyrics later (])', () => nudgeOffset(0.25), { class: 'small', size: 14 }),
    h('span', { class: 'spacer' }),
    h('button', { class: 'link-btn', onclick: () => engine.track && pickLyrics(engine.track).then((ok) => ok && lyricsView.load(engine.track, true)) }, 'Wrong lyrics?'),
    iconBtn('copy', 'Copy lyrics', () => engine.track && copyLyrics(engine.track), { class: 'small', size: 15 }));
  on('lyrics-offset', () => { offText.textContent = offsetLabel(); });
  panel.append(h('div', { class: 'panel-head' }, tabQ, tabL, h('span', { class: 'spacer' }), iconBtn('close', 'Close panel', () => setPanel(null), { class: 'small', size: 16 })), lyTools, body, lyr);
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
      body.append(h('div', { class: 'q-label row' }, h('span', null, `Next up · ${upcoming.length}`), h('span', { class: 'spacer' }),
        h('button', { class: 'link-btn', title: 'Save the whole queue as a playlist', onclick: async () => {
          const name = await prompt({ title: 'Save queue as playlist', value: `Queue ${new Date().toLocaleDateString()}`, ok: 'Save' });
          if (name) { const p = createPlaylist(name, engine.queue); toast(`Saved “${p.name}”`); }
        } }, 'Save'),
        h('button', { class: 'link-btn', onclick: () => engine.clearUpcoming() }, 'Clear')));
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
    lyTools.hidden = panelTab !== 'lyrics';
    if (panelTab === 'queue') renderQueue();
    if (panelTab === 'lyrics') lyricsView.load(engine.track, true); else lyricsView.stop();
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
    else if (k === 'n') { const r = currentRoute(); if (r?.name === 'nowplaying') goBack(); else go('nowplaying'); }
    else if (k === 'v') { const r = currentRoute(); go('nowplaying', { vis: !(r?.name === 'nowplaying' && r.params.vis) }, { replace: r?.name === 'nowplaying' }); }
    else if (k === '[') nudgeOffset(-0.25);
    else if (k === ']') nudgeOffset(0.25);
    else if (k === '?') showShortcuts();
    else if (k === 'm') engine.toggleMute();
    else if (k === 's') engine.toggleShuffle();
    else if (k === 'r') engine.cycleRepeat();
  });
}

export function persistPanel() { save('settings'); }

// ---------------------------------------------------------------- menus and dialogs
function playlistMenu(p, e) {
  menu([
    { text: 'Play', icon: 'play', run: () => { if (engine.shuffle) engine.toggleShuffle(); engine.playList(p.tracks, 0, { type: 'playlist', id: p.id }); } },
    { text: 'Shuffle play', icon: 'shuffle', run: () => { if (!engine.shuffle) engine.toggleShuffle(); engine.playList(p.tracks, Math.floor(Math.random() * p.tracks.length), { type: 'playlist', id: p.id }); } },
    { text: 'Add to queue', icon: 'queue', run: () => engine.enqueue(p.tracks) },
    '-',
    { text: 'Rename', icon: 'settings', run: async () => { const n = await prompt({ title: 'Rename playlist', value: p.name }); if (n) renamePlaylist(p.id, n); } },
    { text: 'Delete', icon: 'trash', run: async () => {
      if (!(await confirm({ title: `Delete “${p.name}”?`, text: 'This removes the playlist from MusicForge. Songs and your accounts are not affected.', ok: 'Delete' }))) return;
      deletePlaylist(p.id);
      const r = currentRoute();
      if (r?.name === 'playlist' && r.params.id === p.id) go('library', { tab: 'playlists' }, { replace: true });
    } },
  ], e.clientX, e.clientY);
}

function playerMenu(e) {
  const r = e.currentTarget.getBoundingClientRect();
  const s = state.settings;
  menu([
    { label: sleep.mode === 'time' ? `Sleep timer · ${Math.max(1, Math.ceil((sleep.until - Date.now()) / 60000))} min left` : sleep.mode === 'track' ? 'Sleep timer · end of this song' : 'Sleep timer' },
    ...[15, 30, 45, 60, 90].map((m) => ({ text: `${m} minutes`, icon: 'moon', run: () => { setSleep(m); toast(`Pausing in ${m} minutes`); } })),
    { text: 'End of this song', icon: 'moon', run: () => { setSleep('track'); toast('Stopping after this song'); } },
    sleep.mode ? { text: 'Turn off sleep timer', icon: 'close', run: () => { setSleep(null); toast('Sleep timer off'); } } : null,
    '-',
    { text: s.notify ? 'Turn off song notifications' : 'Notify me when the song changes', icon: 'bell', run: () => { s.notify = !s.notify; save('settings'); toast(s.notify ? 'Song notifications on' : 'Song notifications off'); } },
    { text: 'Keyboard shortcuts', icon: 'keyboard', run: showShortcuts },
  ], r.left - 160, r.top);
}

const SHORTCUTS = [
  ['Space', 'Play / pause'], ['Ctrl + → / ←', 'Next / previous song'], ['→ / ←', 'Seek 5 s (Shift: 15 s)'],
  ['Ctrl + ↑ / ↓', 'Volume'], ['M', 'Mute'], ['S', 'Shuffle'], ['R', 'Repeat: off, all, one'],
  ['L', 'Lyrics panel'], ['Q', 'Queue panel'], ['N', 'Now playing (again to go back)'], ['V', 'Visualizer only'],
  ['[ / ]', 'Lyrics earlier / later'], ['Ctrl + K or /', 'Search'], ['Alt + ← / →', 'Back / forward'], ['F11', 'Full screen'], ['?', 'This list'],
];
export function showShortcuts() {
  modal((close) => h('div', null,
    h('div', { class: 'modal-body' }, h('h2', null, 'Keyboard shortcuts'),
      h('div', { class: 'shortcut-grid' }, SHORTCUTS.map(([k, d]) => [h('kbd', null, k), h('span', null, d)]))),
    h('div', { class: 'modal-actions' }, h('button', { class: 'btn primary', autofocus: true, onclick: () => close() }, 'Done'))));
}
