import { h, icon, iconBtn, fmtNum } from '../util.js';
import { state, connected, mf, refreshLibrary } from '../state.js';
import { spotify, deezer, youtube } from '../services.js';
import { engine } from '../player/engine.js';
import { go } from '../router.js';
import { tile, trackList, trackMenu, loadingLine, emptyState } from '../ui/components.js';

function section(title, action, body, { scroll = body?.classList?.contains('scroller') } = {}) {
  // Horizontal rows get arrow buttons, since a mouse wheel scrolls the page, not the row.
  const by = (dir) => () => { const sc = el.querySelector('.scroller'); sc?.scrollBy({ left: dir * sc.clientWidth * 0.8, behavior: 'smooth' }); };
  const arrows = scroll ? h('div', { class: 'row-arrows' },
    iconBtn('back', 'Scroll left', by(-1), { class: 'small', size: 16 }),
    iconBtn('fwd', 'Scroll right', by(1), { class: 'small', size: 16 })) : null;
  const el = h('section', { class: 'section' },
    h('div', { class: 'section-head' }, h('h2', { class: 't-sec' }, title), h('div', { class: 'row', style: { gap: '12px' } }, action || null, arrows)),
    body);
  return el;
}

// A row of songs as tiles; `video` uses 16:9 thumbnails.
function songRow(tracks, { video = false, context } = {}) {
  return h('div', { class: `tiles scroller ${video ? 'videos' : ''}` }, tracks.map((t, i) => {
    const el = tile({ image: video ? (t.artLarge || t.art) : t.art, name: t.title, sub: t.artist, onOpen: () => engine.playList(tracks, i, context), onPlay: () => engine.playList(tracks, i, context) });
    el.addEventListener('contextmenu', (e) => { e.preventDefault(); trackMenu(t, e, { list: tracks, index: i, context }); });
    return el;
  }));
}

async function fill(slot, fn) {
  slot.replaceChildren(loadingLine());
  try {
    const el = await fn();
    if (slot.isConnected || slot.parentNode) slot.replaceChildren(el || '');
  } catch (err) {
    slot.replaceChildren(h('p', { class: 't-meta' }, err.message));
  }
}

export function render() {
  const linked = ['spotify', 'youtube', 'lastfm', 'apple'].filter((s) => connected(s));
  const names = { spotify: 'Spotify', youtube: 'YouTube', lastfm: 'Last.fm', apple: 'Apple Music' };
  const nLocal = state.library.tracks.length;
  const sub = [
    linked.length ? `${linked.map((s) => names[s]).join(', ')} linked` : 'No accounts linked yet',
    nLocal ? `${nLocal.toLocaleString()} local songs` : null,
  ].filter(Boolean).join(' · ');

  const view = h('div', { class: 'view' },
    h('div', { class: 'view-head' }, h('div', null, h('h1', { class: 't-display' }, 'Home'), h('p', { class: 't-sub' }, sub))));

  // First run: show the two things that make the app useful.
  if (!linked.length && !nLocal && !state.history.length) {
    view.append(emptyState(
      'Bring your music in',
      'Link Spotify, YouTube, Last.fm or Apple Music to pull in your playlists and stats, or point MusicForge at a folder of music files. Deezer charts, previews and lyrics work without an account.',
      h('div', { class: 'row' },
        h('button', { class: 'btn primary', onclick: () => go('accounts') }, icon('link', 16), 'Link accounts'),
        h('button', { class: 'btn ghost', onclick: async () => { await mf.invoke('library:addFolder'); await refreshLibrary(); mf.invoke('library:scan'); go('library', { tab: 'songs' }); } }, icon('folder', 16), 'Add a music folder')),
    ));
  }

  // Jump back in: recent distinct songs from listening history.
  const seen = new Set();
  const recent = [];
  for (let i = state.history.length - 1; i >= 0 && recent.length < 14; i--) {
    const e = state.history[i];
    if (seen.has(e.key)) continue;
    seen.add(e.key);
    recent.push(e);
  }
  if (recent.length) {
    const lookup = (e) => state.liked.find((t) => t.key === e.key) || findInPlaylists(e.key) || findInQueue(e.key) || fromHistory(e);
    view.append(section('Jump back in', null, h('div', { class: 'tiles scroller' }, recent.map((e) => {
      const t = lookup(e);
      return tile({ image: e.art, name: e.title, sub: e.artist, onOpen: () => engine.playOne(t), onPlay: () => engine.playOne(t) });
    }))));
  }

  if (state.playlists.length) {
    view.append(section('Your playlists', h('button', { class: 'link-btn', onclick: () => go('library', { tab: 'playlists' }) }, 'See all'),
      h('div', { class: 'tiles scroller' }, state.playlists.slice(0, 16).map((p) => tile({
        image: p.tracks.find((t) => t.art)?.art, name: p.name, sub: `${p.tracks.length} songs`,
        onOpen: () => go('playlist', { id: p.id }), onPlay: () => engine.playList(p.tracks, 0, { type: 'playlist', id: p.id }),
      })))));
  }

  if (connected('spotify')) {
    const slot = h('div');
    view.append(section('Recently on Spotify', null, slot, { scroll: true }));
    fill(slot, async () => {
      const items = await spotify.recent();
      const uniq = [];
      const keys = new Set();
      for (const t of items) if (!keys.has(t.key)) { keys.add(t.key); uniq.push(t); }
      return h('div', { class: 'tiles scroller' }, uniq.slice(0, 16).map((t, i) => tile({ image: t.art, name: t.title, sub: t.artist, onOpen: () => engine.playList(uniq, i), onPlay: () => engine.playList(uniq, i) })));
    });
  }

  if (connected('youtube')) {
    const likedSlot = h('div');
    view.append(section('Liked on YouTube', h('button', { class: 'link-btn', onclick: () => go('remote', { service: 'youtube', id: 'liked', name: 'Liked videos' }) }, 'See all'), likedSlot, { scroll: true }));
    fill(likedSlot, async () => {
      const liked = await youtube.liked(100);
      if (!liked.length) return h('p', { class: 't-meta' }, 'No liked videos yet. Like songs on YouTube or YouTube Music and they show up here.');
      const music = liked.filter((t) => t.music);
      const list = music.length >= 6 ? music : liked;
      return songRow(list.slice(0, 30), { video: true, context: { type: 'remote', id: 'youtube:liked' } });
    });
    const plSlot = h('div');
    view.append(section('Your YouTube playlists', h('button', { class: 'link-btn', onclick: () => go('library', { tab: 'youtube' }) }, 'See all'), plSlot, { scroll: true }));
    fill(plSlot, async () => {
      const lists = await youtube.playlists();
      if (!lists.length) return h('p', { class: 't-meta' }, 'You have no YouTube playlists yet.');
      return h('div', { class: 'tiles scroller' }, lists.slice(0, 20).map((p) => tile({ image: p.image, name: p.name, sub: `${p.count} videos`, onOpen: () => go('remote', { service: 'youtube', id: p.id, name: p.name, image: p.image, url: p.url }) })));
    });
  }

  if (connected('spotify')) {
    const plSlot = h('div');
    view.append(section('Your Spotify playlists', h('button', { class: 'link-btn', onclick: () => go('library', { tab: 'spotify' }) }, 'See all'), plSlot, { scroll: true }));
    fill(plSlot, async () => {
      const lists = await spotify.playlists();
      return h('div', { class: 'tiles scroller' }, [{ id: 'liked', name: 'Liked Songs', sub: 'Your Spotify likes', image: null }, ...lists.slice(0, 20)].map((p) => tile({ image: p.image, name: p.name, sub: p.sub || `${p.count} songs`, onOpen: () => go('remote', { service: 'spotify', id: p.id, name: p.name, image: p.image, url: p.url }) })));
    });
  }

  if (state.watchlist.length) {
    view.append(section('Artists you watch', h('button', { class: 'link-btn', onclick: () => go('artists') }, 'Open Artist watch'),
      h('div', { class: 'tiles scroller' }, state.watchlist.slice(0, 12).map((a) => {
        const last = a.snaps?.[a.snaps.length - 1];
        return tile({ image: a.image, name: a.name, sub: last?.fans ? `${fmtNum(last.fans)} fans` : '', round: true, onOpen: () => go('artist', { name: a.name, dz: a.id }) });
      }))));
  }

  const chartSlot = h('div');
  view.append(section('Trending worldwide', h('span', { class: 't-meta' }, 'Deezer chart'), chartSlot));
  fill(chartSlot, async () => {
    const { tracks } = await deezer.chart();
    return trackList(tracks.slice(0, 20), { showAlbum: false, context: { type: 'chart' } });
  });

  return { el: view };
}

function findInPlaylists(key) {
  for (const p of state.playlists) { const t = p.tracks.find((x) => x.key === key); if (t) return t; }
  return null;
}
function findInQueue(key) { return engine.queue.find((t) => t.key === key) || null; }
function fromHistory(e) {
  // Minimal track rebuilt from history; the engine resolves a source by title/artist.
  const [prefix, ...rest] = e.key.split(':');
  const id = rest.join(':');
  const src = {};
  if (prefix === 'sp') src.spotify = `spotify:track:${id}`;
  if (prefix === 'yt') src.youtube = id;
  if (prefix === 'lo') src.local = id;
  if (prefix === 'sc') src.soundcloud = id;
  if (prefix === 'dz') src.deezer = id;
  const origin = { sp: 'spotify', yt: 'youtube', lo: 'local', sc: 'soundcloud', dz: 'deezer', it: 'itunes', am: 'apple' }[prefix] || 'deezer';
  return { key: e.key, title: e.title, artist: e.artist, album: e.album, art: e.art, artLarge: e.art, duration: 0, src, origin };
}
