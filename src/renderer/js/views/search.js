// Search: everything at once, laid out as grids. Filter by type (songs, artists, albums,
// playlists, videos) and by source; songs can be shown as a grid or a list.
import { h, icon, songKey, fmtNum } from '../util.js';
import { state, connected, youtubeSearchable } from '../state.js';
import { spotify, youtube, deezer, itunes, soundcloud, local, parseLink, NAMES, api } from '../services.js';
import { engine } from '../player/engine.js';
import { go } from '../router.js';
import { tile, trackList, trackGrid, trackCollection, viewToggle, topCard, loadingLine, emptyState, toast } from '../ui/components.js';
import { importPlaylist } from '../playlists.js';

const TYPES = [['all', 'All'], ['songs', 'Songs'], ['artists', 'Artists'], ['albums', 'Albums'], ['playlists', 'Playlists'], ['videos', 'Videos']];
const SOURCES = [['everywhere', 'Everywhere'], ['library', 'Your library'], ['spotify', 'Spotify'], ['deezer', 'Deezer'], ['itunes', 'Apple Music']];

function searchLocal(q, max = 60) {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const out = [];
  for (const t of state.library.tracks) {
    const hay = `${t.title} ${t.artist} ${t.album}`.toLowerCase();
    if (words.every((w) => hay.includes(w))) { out.push(local.map(t)); if (out.length >= max) break; }
  }
  return out;
}

const dedupe = (lists) => {
  const seen = new Set();
  const out = [];
  for (const list of lists) for (const t of list || []) {
    const k = songKey(t.artist, t.title);
    if (!seen.has(k)) { seen.add(k); out.push(t); }
  }
  return out;
};
const ok = (v) => (Array.isArray(v) ? v : []);

export function render({ q = '', type, tab, src = 'everywhere' } = {}) {
  // Older links used "tab"; map them onto type/source.
  if (!type) {
    if (tab === 'youtube') type = 'videos';
    else if (tab && tab !== 'all') { type = 'songs'; src = tab; } else type = 'all';
  }
  const view = h('div', { class: 'view' });
  if (!q) {
    view.append(h('h1', { class: 't-display' }, 'Search'),
      emptyState('Search everything at once', 'Type in the box above to search your library, Spotify, Deezer and Apple Music together, with songs, artists, albums and playlists laid out side by side. Paste a Spotify, YouTube, SoundCloud or Deezer link to open it directly.'));
    setTimeout(() => document.getElementById('search-input').focus(), 0);
    return { el: view };
  }
  const link = parseLink(q);
  if (link) { renderLink(view, link); return { el: view }; }

  const cleanups = [];
  const body = h('div');
  const reroute = (patch) => go('search', { q, type, src, ...patch }, { replace: true });
  const typeChips = h('div', { class: 'tabs', role: 'tablist', style: { marginBottom: 0 } }, TYPES.map(([id, text]) => h('button', {
    class: `chip ${id === type ? 'on' : ''}`, role: 'tab', 'aria-selected': id === type, onclick: () => reroute({ type: id }),
  }, text)));
  const srcSel = ['songs', 'albums', 'artists'].includes(type) ? h('select', { class: 'input', style: { width: '160px' }, 'aria-label': 'Source', onchange: (e) => reroute({ src: e.target.value }) },
    SOURCES.filter(([id]) => !(type !== 'songs' && id === 'library')).map(([id, text]) => h('option', { value: id, selected: id === src }, text))) : null;
  const toggle = ['all', 'songs'].includes(type) ? viewToggle('search', 'grid', () => draw()) : null;
  view.append(
    h('div', { class: 'view-head' }, h('h1', { class: 't-display' }, `“${q}”`)),
    h('div', { class: 'search-bar' }, typeChips, h('span', { class: 'spacer' }), srcSel, toggle),
    body);

  let data = null;
  const draw = () => {
    cleanups.splice(0).forEach((f) => f());
    if (data) paint(body, data, { q, type, src, cleanups, reroute });
  };
  body.append(loadingLine());
  fetchFor(q, type, src).then((d) => { data = d; if (body.isConnected || body.parentNode) { body.replaceChildren(); draw(); } })
    .catch((err) => body.replaceChildren(emptyState('Search failed', err.message)));
  return { el: view, cleanup: () => cleanups.forEach((f) => f()) };
}

async function fetchFor(q, type, src) {
  const useSp = connected('spotify') && (src === 'everywhere' || src === 'spotify');
  const useDz = src === 'everywhere' || src === 'deezer';
  const errors = [];
  const guard = (svc, p) => p.catch((e) => { errors.push(`${NAMES[svc]}: ${e.message}`); return null; });
  if (type === 'videos') {
    if (!youtubeSearchable()) return { needsYouTube: true };
    return { videos: await guard('youtube', youtube.search(q, { music: false, max: 24 })) || [], errors };
  }
  if (type === 'playlists') return { playlists: ok(await guard('deezer', deezer.searchPlaylists(q, 40))), errors };
  const want = (t) => type === 'all' || type === t;
  const [sp, dzTracks, dzArtists, dzAlbums, dzPlaylists, itTracks] = await Promise.all([
    useSp ? guard('spotify', spotify.searchAll(q)) : null,
    useDz && want('songs') ? guard('deezer', deezer.search(q, type === 'songs' ? 60 : 30)) : null,
    useDz && want('artists') ? guard('deezer', deezer.searchArtists(q, type === 'artists' ? 30 : 10)) : null,
    useDz && want('albums') ? guard('deezer', deezer.searchAlbums(q, type === 'albums' ? 40 : 14)) : null,
    type === 'all' ? guard('deezer', deezer.searchPlaylists(q, 12)) : null,
    src === 'itunes' && want('songs') ? guard('itunes', itunes.search(q, 50)) : null,
  ]);
  const localTracks = (src === 'everywhere' || src === 'library') && want('songs') ? searchLocal(q) : [];
  const songs = src === 'itunes' ? ok(itTracks) : dedupe([localTracks, sp?.tracks, dzTracks]);
  const artists = [...ok(dzArtists)];
  for (const a of ok(sp?.artists)) if (!artists.some((x) => x.name.toLowerCase() === a.name.toLowerCase())) artists.push(a);
  const albums = [];
  const seenAl = new Set();
  for (const a of [...ok(sp?.albums), ...ok(dzAlbums)]) {
    const k = `${a.title}|${a.artist}`.toLowerCase();
    if (!seenAl.has(k)) { seenAl.add(k); albums.push(a); }
  }
  return { songs, localCount: localTracks.length, artists, albums, playlists: ok(dzPlaylists), errors };
}

function section(title, el, more) {
  return h('section', { class: 'section' }, h('div', { class: 'section-head' }, h('h2', { class: 't-sec' }, title), more || null), el);
}
const seeAll = (fn) => h('button', { class: 'link-btn', onclick: fn }, 'See all');

const artistTile = (a) => tile({ image: a.image, name: a.name, sub: a.fans ? `${fmtNum(a.fans)} fans` : a.genres?.slice(0, 2).join(', ') || 'Artist', round: true, onOpen: () => go('artist', { name: a.name, dz: a.service === 'spotify' ? null : a.id }) });
const albumTile = (a) => tile({
  image: a.cover, name: a.title, sub: [a.artist, a.year || a.type].filter(Boolean).join(' · '),
  onOpen: () => go('album', { kind: a.service, id: a.id }),
  onPlay: async () => { const al = a.service === 'spotify' ? await spotify.albumInfo(a.id) : await deezer.album(a.id); engine.playList(al.tracks, 0, { type: 'album', id: `${a.service}:${a.id}` }); },
});
const playlistTile = (p) => tile({
  image: p.image, name: p.name, sub: [p.owner, p.count ? `${p.count} songs` : null].filter(Boolean).join(' · '),
  onOpen: () => go('remote', { service: 'deezer', id: p.id, name: p.name, image: p.image, url: p.url }),
  onPlay: async () => { const pl = await deezer.playlist(p.id); engine.playList(pl.tracks, 0, { type: 'remote', id: `deezer:${p.id}` }); },
});

function paint(body, d, { q, type, src, cleanups, reroute }) {
  const keep = (el) => { if (el?._cleanup) cleanups.push(el._cleanup); return el; };
  const errLine = () => (d.errors?.length ? h('p', { class: 't-meta', style: { marginTop: '18px' } }, d.errors.join(' · ')) : null);

  if (d.needsYouTube) {
    body.append(emptyState('Video search needs a YouTube key', 'Add a free YouTube Data API key in Accounts. Each search uses some of your daily quota, so videos are only searched on this tab.', h('button', { class: 'btn primary', onclick: () => go('accounts') }, 'Open Accounts')));
    return;
  }
  if (type === 'videos') {
    body.append(d.videos.length ? keep(trackGrid(d.videos, { video: true, context: { type: 'search' } })) : emptyState('No videos found', 'Try different words.'), errLine() || '');
    return;
  }
  if (type === 'playlists') {
    body.append(d.playlists.length ? h('div', { class: 'tiles' }, d.playlists.map(playlistTile)) : emptyState('No playlists found', 'Try different words.'), errLine() || '');
    return;
  }
  if (type === 'artists') {
    body.append(d.artists.length ? h('div', { class: 'tiles' }, d.artists.map(artistTile)) : emptyState('No artists found', 'Try a different spelling.'), errLine() || '');
    return;
  }
  if (type === 'albums') {
    body.append(d.albums.length ? h('div', { class: 'tiles' }, d.albums.map(albumTile)) : emptyState('No albums found', 'Try different words.'), errLine() || '');
    return;
  }
  if (type === 'songs') {
    body.append(d.songs.length ? keep(trackCollection(d.songs, { context: { type: 'search' } }, 'search', 'grid')) : emptyState('No songs found', src === 'library' ? 'Nothing in your local files matches.' : 'Try fewer words or another source.'), errLine() || '');
    return;
  }

  // ---- All
  const { songs, artists, albums, playlists } = d;
  if (!songs.length && !artists.length && !albums.length && !playlists.length) {
    body.append(emptyState('Nothing found', 'Try fewer words, check the spelling, or search one type at a time.'), errLine() || '');
    return;
  }
  const ql = q.trim().toLowerCase();
  const artistHit = artists.find((a) => a.name.toLowerCase() === ql) || (artists[0] && ql.startsWith(artists[0].name.toLowerCase()) ? artists[0] : null);
  const top = artistHit
    ? topCard({ image: artistHit.imageLarge || artistHit.image, round: true, name: artistHit.name, meta: artistHit.fans ? `Artist · ${fmtNum(artistHit.fans)} fans` : 'Artist', onOpen: () => go('artist', { name: artistHit.name, dz: artistHit.service === 'spotify' ? null : artistHit.id }) })
    : songs[0] ? topCard({ image: songs[0].artLarge || songs[0].art, name: songs[0].title, meta: `Song · ${songs[0].artist}`, onOpen: () => engine.playList(songs, 0, { type: 'search' }), onPlay: () => engine.playList(songs, 0, { type: 'search' }) }) : null;
  if (top) {
    const firstSongs = songs.slice(0, 4);
    body.append(h('div', { class: 'search-top' },
      section('Top result', top),
      firstSongs.length ? section('Songs', trackList(firstSongs, { showAlbum: false, onPlay: (i) => engine.playList(songs, i, { type: 'search' }) }), seeAll(() => reroute({ type: 'songs' }))) : h('div')));
  }
  if (artists.length) body.append(section('Artists', h('div', { class: 'tiles scroller' }, artists.slice(0, 12).map(artistTile)), artists.length > 6 ? seeAll(() => reroute({ type: 'artists' })) : null));
  const rest = songs.slice(4, 28);
  if (rest.length) body.append(section('More songs', keep(trackCollection(rest, { context: { type: 'search' }, onPlay: (i) => engine.playList(songs, i + 4, { type: 'search' }) }, 'search', 'grid')), seeAll(() => reroute({ type: 'songs' }))));
  if (albums.length) body.append(section('Albums', h('div', { class: 'tiles' }, albums.slice(0, 12).map(albumTile)), albums.length > 12 ? seeAll(() => reroute({ type: 'albums' })) : null));
  if (playlists.length) body.append(section('Playlists', h('div', { class: 'tiles' }, playlists.slice(0, 6).map(playlistTile)), seeAll(() => reroute({ type: 'playlists' }))));
  const e = errLine();
  if (e) body.append(e);
  if (youtubeSearchable()) body.append(h('p', { class: 't-meta', style: { marginTop: '18px' } }, 'Looking for a music video or a live version? ', h('button', { class: 'link-btn', style: { textDecoration: 'underline' }, onclick: () => reroute({ type: 'videos' }) }, 'Search YouTube videos')));
}

async function renderLink(view, link) {
  view.append(h('div', { class: 'view-head' }, h('div', null, h('h1', { class: 't-display' }, `${NAMES[link.service]} link`), h('p', { class: 't-sub' }, 'Opening…'))));
  const body = h('div', null, loadingLine());
  view.append(body);
  const sub = view.querySelector('.t-sub');
  try {
    let tracks = [];
    let remote = null;
    if (link.service === 'spotify') {
      if (!connected('spotify')) throw new Error('Link Spotify in Accounts to open Spotify links.');
      if (link.type === 'track') tracks = [await spotify.track(link.id)];
      else if (link.type === 'album') tracks = await spotify.album(link.id);
      else { remote = { id: link.id, name: 'Spotify playlist' }; tracks = await spotify.playlistTracks(link.id); }
    } else if (link.service === 'youtube') {
      if (link.type === 'video') {
        const t = youtubeSearchable() ? await youtube.video(link.id) : null;
        tracks = [t || { key: `yt:${link.id}`, title: 'YouTube video', artist: '', album: '', duration: 0, art: `https://i.ytimg.com/vi/${link.id}/mqdefault.jpg`, artLarge: `https://i.ytimg.com/vi/${link.id}/hqdefault.jpg`, src: { youtube: link.id }, origin: 'youtube', url: `https://www.youtube.com/watch?v=${link.id}` }];
      } else {
        if (!youtubeSearchable()) throw new Error('Add a YouTube API key in Accounts to open playlists.');
        remote = { id: link.id, name: 'YouTube playlist' };
        tracks = await youtube.playlistTracks(link.id);
      }
    } else if (link.service === 'soundcloud') {
      if (link.type === 'set') throw new Error('SoundCloud sets aren’t supported yet. Paste a single track link.');
      tracks = [await soundcloud.fromUrl(link.url)];
    } else if (link.service === 'deezer') {
      if (link.type === 'playlist') { const p = await deezer.playlist(link.id); remote = { id: link.id, name: p.name }; tracks = p.tracks; }
      else if (link.type === 'album') tracks = (await deezer.album(link.id)).tracks;
      else if (link.type === 'artist') { go('artist', { dz: link.id, name: '' }, { replace: true }); return; }
      else if (link.type === 'track') tracks = [deezer.map(await api('deezer', `/track/${link.id}`))];
    }
    tracks = tracks.filter(Boolean);
    sub.textContent = `${tracks.length} song${tracks.length === 1 ? '' : 's'}`;
    const actions = h('div', { class: 'coll-actions' },
      h('button', { class: 'btn primary', onclick: () => engine.playList(tracks, 0) }, icon('play', 16), 'Play'),
      remote ? h('button', { class: 'btn ghost', onclick: async (e) => {
        e.currentTarget.disabled = true;
        try { const r = await importPlaylist(link.service, remote); toast(`Imported “${r.playlist.name}”`); go('playlist', { id: r.playlist.id }); } catch (err) { toast(err.message, 'error'); }
      } }, icon('import', 16), 'Import as playlist') : null);
    body.replaceChildren(actions, trackList(tracks));
    if (tracks.length === 1 && link.type !== 'playlist') engine.playOne(tracks[0]);
  } catch (err) {
    sub.textContent = '';
    body.replaceChildren(emptyState("Couldn't open that link", err.message));
  }
}
