import { h, icon, songKey, fmtNum } from '../util.js';
import { state, connected, youtubeSearchable } from '../state.js';
import { spotify, youtube, deezer, itunes, soundcloud, local, parseLink, NAMES, api } from '../services.js';
import { engine } from '../player/engine.js';
import { go } from '../router.js';
import { tile, trackList, loadingLine, emptyState, toast } from '../ui/components.js';
import { importPlaylist } from '../playlists.js';

const TABS = [
  { id: 'all', text: 'All' },
  { id: 'library', text: 'Your library' },
  { id: 'spotify', text: 'Spotify' },
  { id: 'youtube', text: 'YouTube' },
  { id: 'deezer', text: 'Deezer' },
  { id: 'itunes', text: 'Apple Music' },
];

function searchLocal(q) {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const out = [];
  for (const t of state.library.tracks) {
    const hay = `${t.title} ${t.artist} ${t.album}`.toLowerCase();
    if (words.every((w) => hay.includes(w))) { out.push(local.map(t)); if (out.length >= 50) break; }
  }
  return out;
}

export function render({ q = '', tab = 'all' } = {}) {
  const view = h('div', { class: 'view' });
  if (!q) {
    view.append(h('h1', { class: 't-display' }, 'Search'),
      emptyState('Search everything at once', 'Type in the box above to search your library, Spotify, Deezer and Apple Music together. Paste a Spotify, YouTube, SoundCloud or Deezer link to open it directly.'));
    setTimeout(() => document.getElementById('search-input').focus(), 0);
    return { el: view };
  }

  const link = parseLink(q);
  if (link) { renderLink(view, link); return { el: view }; }

  const tabs = h('div', { class: 'tabs', role: 'tablist' }, TABS.map((t) => h('button', {
    class: `chip ${t.id === tab ? 'on' : ''}`, role: 'tab', 'aria-selected': t.id === tab,
    onclick: () => go('search', { q, tab: t.id }, { replace: true }),
  }, t.text)));
  view.append(h('div', { class: 'view-head' }, h('h1', { class: 't-display' }, `“${q}”`)), tabs);
  const body = h('div');
  view.append(body);
  runSearch(body, q, tab);
  return { el: view };
}

async function runSearch(body, q, tab) {
  const block = (title, el) => h('section', { class: 'section' }, h('div', { class: 'section-head' }, h('h2', { class: 't-sec' }, title)), el);
  const errorLine = (svc, err) => h('p', { class: 't-meta' }, `${NAMES[svc]}: ${err.message}`);
  body.append(loadingLine());

  if (tab === 'library') {
    const res = searchLocal(q);
    body.replaceChildren(res.length ? trackList(res) : emptyState('Nothing in your library', state.library.folders.length ? 'No local songs match.' : 'Add a music folder in Library to search your own files.'));
    return;
  }
  if (tab === 'youtube') {
    if (!youtubeSearchable()) { body.replaceChildren(emptyState('YouTube search needs a key', 'Add a free YouTube Data API key in Accounts. Each search uses some of your daily quota, so YouTube is searched only from this tab.', h('button', { class: 'btn primary', onclick: () => go('accounts') }, 'Open Accounts'))); return; }
    try {
      const res = await youtube.search(q, { music: false, max: 20 });
      body.replaceChildren(trackList(res, { showAlbum: false }));
    } catch (err) { body.replaceChildren(errorLine('youtube', err)); }
    return;
  }
  if (tab === 'spotify') {
    if (!connected('spotify')) { body.replaceChildren(emptyState('Spotify isn’t linked', 'Link your Spotify account in Accounts to search it here.', h('button', { class: 'btn primary', onclick: () => go('accounts') }, 'Open Accounts'))); return; }
    try {
      const [first, second] = await Promise.all([spotify.search(q), api('spotify', '/search', { query: { q, type: 'track', limit: 10, offset: 10 }, ttl: 300 }).catch(() => null)]);
      const more = (second?.tracks?.items || []).map((t) => spotify.map(t)).filter(Boolean);
      body.replaceChildren(trackList([...first, ...more]));
    } catch (err) { body.replaceChildren(errorLine('spotify', err)); }
    return;
  }
  if (tab === 'deezer') {
    try { body.replaceChildren(trackList(await deezer.search(q, 40))); } catch (err) { body.replaceChildren(errorLine('deezer', err)); }
    return;
  }
  if (tab === 'itunes') {
    try { body.replaceChildren(trackList(await itunes.search(q, 40))); } catch (err) { body.replaceChildren(errorLine('itunes', err)); }
    return;
  }

  // All: library + Spotify + Deezer, merged and de-duplicated; artists from Deezer.
  const [loc, sp, dz, artists] = await Promise.all([
    Promise.resolve(searchLocal(q)),
    connected('spotify') ? spotify.search(q).catch((e) => e) : Promise.resolve([]),
    deezer.search(q, 25).catch((e) => e),
    deezer.searchArtists(q, 8).catch(() => []),
  ]);
  if (!body.isConnected && !body.parentNode) return;
  body.replaceChildren();
  if (artists.length) {
    body.append(block('Artists', h('div', { class: 'tiles scroller' }, artists.map((a) => tile({
      image: a.image, name: a.name, sub: a.fans ? `${fmtNum(a.fans)} fans` : '', round: true,
      onOpen: () => go('artist', { name: a.name, dz: a.id }),
    })))));
  }
  const seen = new Set();
  const merged = [];
  for (const list of [loc, Array.isArray(sp) ? sp : [], Array.isArray(dz) ? dz : []]) {
    for (const t of list) {
      const k = songKey(t.artist, t.title);
      if (seen.has(k)) continue;
      seen.add(k);
      merged.push(t);
    }
  }
  if (merged.length) body.append(block('Songs', trackList(merged.slice(0, 40))));
  else body.append(emptyState('No songs found', 'Try fewer words, or search a single service with the tabs above.'));
  if (sp instanceof Error) body.append(errorLine('spotify', sp));
  if (dz instanceof Error) body.append(errorLine('deezer', dz));
  if (youtubeSearchable()) {
    body.append(h('p', { class: 't-meta', style: { marginTop: '18px' } }, 'Looking for a video or a live version? ',
      h('button', { class: 'link-btn', style: { textDecoration: 'underline' }, onclick: () => go('search', { q, tab: 'youtube' }, { replace: true }) }, 'Search YouTube')));
  }
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
