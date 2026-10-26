import { h, icon, iconBtn, fmtNum, clear } from '../util.js';
import { state, on, mf, connected, refreshLibrary } from '../state.js';
import { spotify, youtube, apple, local } from '../services.js';
import { engine } from '../player/engine.js';
import { go } from '../router.js';
import { tile, trackList, loadingLine, emptyState, toast, prompt } from '../ui/components.js';
import { importPlaylist } from '../playlists.js';

const TABS = [
  { id: 'songs', text: 'Songs' },
  { id: 'albums', text: 'Albums' },
  { id: 'artists', text: 'Artists' },
  { id: 'liked', text: 'Liked' },
  { id: 'playlists', text: 'Playlists' },
  { id: 'spotify', text: 'Spotify' },
  { id: 'youtube', text: 'YouTube' },
  { id: 'apple', text: 'Apple Music' },
  { id: 'folders', text: 'Folders' },
];

export function render({ tab } = {}) {
  tab ||= state.library.tracks.length ? 'songs' : 'playlists';
  const view = h('div', { class: 'view' });
  const body = h('div');
  view.append(
    h('div', { class: 'view-head' }, h('h1', { class: 't-display' }, 'Library')),
    h('div', { class: 'tabs', role: 'tablist' }, TABS.map((t) => h('button', {
      class: `chip ${t.id === tab ? 'on' : ''}`, role: 'tab', 'aria-selected': t.id === tab,
      onclick: () => go('library', { tab: t.id }, { replace: true }),
    }, t.text))),
    body);
  const offs = [];
  const draw = () => {
    clear(body);
    const fn = { songs, albums, artists, liked, playlists, spotify: spotifyTab, youtube: youtubeTab, apple: appleTab, folders }[tab];
    fn(body, offs);
  };
  draw();
  if (['songs', 'albums', 'artists', 'folders'].includes(tab)) offs.push(on('library', draw));
  if (tab === 'liked') offs.push(on('likes', draw));
  if (tab === 'playlists') offs.push(on('playlists', draw));
  if (['spotify', 'youtube', 'apple'].includes(tab)) offs.push(on('auth', draw));
  return { el: view, cleanup: () => offs.forEach((f) => f()) };
}

const addFolderBtn = (label = 'Add a music folder') => h('button', {
  class: 'btn primary',
  onclick: async () => {
    const before = state.library.folders.length;
    await mf.invoke('library:addFolder');
    await refreshLibrary();
    if (state.library.folders.length > before) { toast('Scanning your music…'); mf.invoke('library:scan'); }
  },
}, icon('folder', 16), label);

function songs(body, offs) {
  const tracks = state.library.tracks;
  if (!tracks.length) {
    body.append(emptyState('No local music yet', 'Add a folder with MP3, FLAC, M4A, OGG, Opus or WAV files. MusicForge reads tags, cover art and lyrics (embedded or a .lrc file next to the song).', addFolderBtn()));
    return;
  }
  let sort = 'artist';
  let filter = '';
  const listSlot = h('div');
  const sorters = {
    artist: (a, b) => (a.albumArtist || a.artist).localeCompare(b.albumArtist || b.artist) || a.album.localeCompare(b.album) || (a.disc - b.disc) || (a.no - b.no),
    title: (a, b) => a.title.localeCompare(b.title),
    album: (a, b) => a.album.localeCompare(b.album) || (a.disc - b.disc) || (a.no - b.no),
    recent: (a, b) => b.mtime - a.mtime,
  };
  let list = null;
  let rows = [];
  const draw = () => {
    list?._cleanup?.();
    const words = filter.toLowerCase().split(/\s+/).filter(Boolean);
    rows = tracks.filter((t) => !words.length || words.every((w) => `${t.title} ${t.artist} ${t.album}`.toLowerCase().includes(w)))
      .sort(sorters[sort]).map(local.map);
    list = trackList(rows, { context: { type: 'library' } });
    listSlot.replaceChildren(list);
  };
  const sortSel = h('select', { class: 'input', style: { width: '150px' }, onchange: (e) => { sort = e.target.value; draw(); } },
    [['artist', 'Artist'], ['album', 'Album'], ['title', 'Title'], ['recent', 'Recently added']].map(([v, t]) => h('option', { value: v }, t)));
  const filterIn = h('input', { class: 'coll-filter', placeholder: 'Filter songs', oninput: (e) => { filter = e.target.value; clearTimeout(filterIn.t); filterIn.t = setTimeout(draw, 120); } });
  body.append(
    h('div', { class: 'coll-actions' },
      h('button', { class: 'btn primary', onclick: () => { if (engine.shuffle) engine.toggleShuffle(); engine.playList(rows, 0, { type: 'library' }); } }, icon('play', 16), 'Play all'),
      h('button', { class: 'btn ghost', onclick: () => { if (!engine.shuffle) engine.toggleShuffle(); engine.playList(rows, Math.floor(Math.random() * rows.length), { type: 'library' }); } }, icon('shuffle', 16), 'Shuffle'),
      h('span', { class: 't-meta' }, `${tracks.length.toLocaleString()} songs`),
      h('span', { class: 'spacer' }), sortSel, filterIn),
    listSlot);
  draw();
  offs.push(() => list?._cleanup?.());
}

function groupAlbums() {
  const map = new Map();
  for (const t of state.library.tracks) {
    const artist = t.albumArtist || t.artist || 'Unknown artist';
    const k = `${artist}\u0000${t.album || 'Unknown album'}`;
    let a = map.get(k);
    if (!a) { a = { key: k, artist, album: t.album || 'Unknown album', tracks: [], cover: null, year: 0 }; map.set(k, a); }
    a.tracks.push(t);
    if (!a.cover && t.cover) a.cover = t.id;
    if (t.year) a.year = t.year;
  }
  return [...map.values()].sort((a, b) => a.artist.localeCompare(b.artist) || a.year - b.year);
}

function albums(body) {
  const list = groupAlbums();
  if (!list.length) { body.append(emptyState('No albums yet', 'Albums appear here once you add a music folder.', addFolderBtn())); return; }
  body.append(h('div', { class: 'tiles' }, list.map((a) => {
    const tracks = () => a.tracks.slice().sort((x, y) => (x.disc - y.disc) || (x.no - y.no)).map(local.map);
    return tile({
      image: a.cover ? local.map(a.tracks.find((t) => t.id === a.cover)).art : null,
      name: a.album, sub: `${a.artist}${a.year ? ` · ${a.year}` : ''}`,
      onOpen: () => go('album', { kind: 'local', key: a.key }),
      onPlay: () => engine.playList(tracks(), 0, { type: 'album', id: a.key }),
    });
  })));
}

function artists(body) {
  const map = new Map();
  for (const t of state.library.tracks) {
    const a = (t.albumArtist || t.artist || 'Unknown artist');
    const e = map.get(a) || { name: a, n: 0, cover: null };
    e.n++;
    if (!e.cover && t.cover) e.cover = t.id;
    map.set(a, e);
  }
  const list = [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
  if (!list.length) { body.append(emptyState('No artists yet', 'Artists appear here once you add a music folder.', addFolderBtn())); return; }
  body.append(h('div', { class: 'tiles' }, list.map((a) => tile({
    image: a.cover ? local.map(state.library.tracks.find((t) => t.id === a.cover)).art : null,
    name: a.name, sub: `${a.n} song${a.n === 1 ? '' : 's'}`, round: true,
    onOpen: () => go('artist', { name: a.name }),
    onPlay: () => engine.playList(state.library.tracks.filter((t) => (t.albumArtist || t.artist) === a.name).map(local.map), 0),
  }))));
}

function liked(body) {
  if (!state.liked.length) { body.append(emptyState('Nothing liked yet', 'Tap the heart on any song, from any service. Liked songs live here together.')); return; }
  body.append(
    h('div', { class: 'coll-actions' },
      h('button', { class: 'btn primary', onclick: () => engine.playList(state.liked, 0, { type: 'liked' }) }, icon('play', 16), 'Play'),
      h('span', { class: 't-meta' }, `${state.liked.length} songs`)),
    trackList(state.liked, { context: { type: 'liked' } }));
}

function playlists(body) {
  const newBtn = h('button', { class: 'btn ghost', onclick: async () => {
    const name = await prompt({ title: 'New playlist', placeholder: 'Playlist name', ok: 'Create' });
    if (name) { const { createPlaylist } = await import('../playlists.js'); const p = createPlaylist(name); go('playlist', { id: p.id }); }
  } }, icon('plus', 16), 'New playlist');
  if (!state.playlists.length) {
    body.append(emptyState('No playlists yet', 'Create one here, or import your playlists from the Spotify, YouTube and Apple Music tabs. You can also paste a Deezer, Spotify or YouTube playlist link into search.', newBtn));
    return;
  }
  body.append(h('div', { class: 'coll-actions' }, newBtn),
    h('div', { class: 'tiles' }, state.playlists.map((p) => tile({
      image: p.tracks.find((t) => t.art)?.art, name: p.name,
      sub: `${p.tracks.length} songs${p.source ? ` · from ${{ spotify: 'Spotify', youtube: 'YouTube', deezer: 'Deezer', apple: 'Apple Music' }[p.source.service]}` : ''}`,
      onOpen: () => go('playlist', { id: p.id }),
      onPlay: () => engine.playList(p.tracks, 0, { type: 'playlist', id: p.id }),
    }))));
}

// -------- service tabs: browse live, import with one click
function remoteGrid(body, service, loader, extras = []) {
  const slot = h('div', null, loadingLine());
  body.append(slot);
  loader().then((lists) => {
    const importAll = h('button', { class: 'btn ghost', onclick: async (e) => {
      e.currentTarget.disabled = true;
      let n = 0;
      for (const p of lists) {
        try { await importPlaylist(service, p); n++; } catch (err) { toast(`${p.name}: ${err.message}`, 'error'); }
      }
      toast(`Imported ${n} playlist${n === 1 ? '' : 's'}`);
      e.target.disabled = false;
    } }, icon('import', 16), 'Import all playlists');
    const tiles = [...extras, ...lists].map((p) => tile({
      image: p.image, name: p.name, sub: p.count != null ? `${p.count} songs` : (p.sub || ''),
      onOpen: () => go('remote', { service, id: p.id, name: p.name, image: p.image, url: p.url }),
    }));
    slot.replaceChildren(h('div', { class: 'coll-actions' }, importAll, h('span', { class: 't-meta' }, `${lists.length} playlists. Opening one doesn't import it; use Import inside to keep a copy in MusicForge.`)), h('div', { class: 'tiles' }, tiles));
  }).catch((err) => slot.replaceChildren(emptyState("Couldn't load playlists", err.message)));
}

const linkFirst = (body, name) => body.append(emptyState(`${name} isn't linked`, `Link ${name} in Accounts to browse and import your playlists here.`, h('button', { class: 'btn primary', onclick: () => go('accounts') }, 'Open Accounts')));

function spotifyTab(body) {
  if (!connected('spotify')) return linkFirst(body, 'Spotify');
  remoteGrid(body, 'spotify', () => spotify.playlists(), [{ id: 'liked', name: 'Liked Songs', sub: 'Your Spotify likes', image: null }]);
}
function youtubeTab(body) {
  if (!connected('youtube')) {
    return body.append(emptyState('YouTube account isn’t linked', state.auth.youtube.hasKey
      ? 'Your API key covers search and videos. To browse your own playlists and liked videos, add an OAuth client in Accounts and sign in.'
      : 'Link YouTube in Accounts to browse your playlists and liked videos.', h('button', { class: 'btn primary', onclick: () => go('accounts') }, 'Open Accounts')));
  }
  remoteGrid(body, 'youtube', () => youtube.playlists(), [{ id: 'liked', name: 'Liked videos', sub: 'Your YouTube likes', image: null }]);
}
function appleTab(body) {
  if (!connected('apple')) return linkFirst(body, 'Apple Music');
  remoteGrid(body, 'apple', () => apple.playlists());
}

function folders(body, offs) {
  const lib = state.library;
  const progress = h('span', { class: 't-meta' }, lib.scanning ? 'Scanning…' : `${lib.tracks.length.toLocaleString()} songs indexed`);
  offs.push(on('library-progress', (p) => {
    progress.textContent = p.finished ? `${p.total.toLocaleString()} songs indexed · ${p.parsed} new or changed · ${(p.ms / 1000).toFixed(1)} s` : `Scanning… ${p.done.toLocaleString()} of ${p.total.toLocaleString()}`;
  }));
  body.append(
    h('div', { class: 'coll-actions' },
      addFolderBtn('Add folder'),
      h('button', { class: 'btn ghost', disabled: !lib.folders.length, onclick: () => { progress.textContent = 'Scanning…'; mf.invoke('library:scan'); } }, icon('refresh', 16), 'Rescan'),
      progress),
    lib.folders.length
      ? h('div', { class: 'svc-list' }, lib.folders.map((f) => h('div', { class: 'svc' }, h('div', { class: 'svc-row', style: { gridTemplateColumns: '20px 1fr auto' } },
        icon('folder', 18), h('div', { class: 'selectable', style: { overflowWrap: 'anywhere' } }, f),
        h('button', { class: 'btn small ghost', onclick: async () => { await mf.invoke('library:removeFolder', f); await refreshLibrary(); toast('Folder removed from library'); } }, 'Remove')))))
      : emptyState('No folders yet', 'Add the folders where you keep music. MusicForge only re-reads files that changed, so rescans are quick.'));
}

export { groupAlbums, fmtNum, iconBtn };
