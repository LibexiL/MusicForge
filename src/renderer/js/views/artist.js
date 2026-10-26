import { h, icon, img, fmtFull, fmtLong } from '../util.js';
import { state, mf } from '../state.js';
import { deezer, lastfm, local } from '../services.js';
import { engine } from '../player/engine.js';
import { go } from '../router.js';
import { tile, trackList, loadingLine, emptyState, toast } from '../ui/components.js';
import { isWatched, watch, unwatch } from './artists.js';

const stat = (v, k) => h('div', { class: 'fact' }, h('div', { class: 'v' }, v), h('div', { class: 'k' }, k));

export function render({ name = '', dz = null } = {}) {
  const view = h('div', { class: 'view' }, loadingLine());
  load(view, name, dz);
  return { el: view };
}

async function load(view, name, dzId) {
  let artist = null;
  try {
    if (dzId) artist = await deezer.artist(dzId);
    else if (name) {
      const res = await deezer.searchArtists(name, 5);
      artist = res.find((a) => a.name.toLowerCase() === name.toLowerCase()) || res[0] || null;
    }
  } catch { /* offline or not found; fall back to local data */ }
  const displayName = artist?.name || name;
  const lf = lastfm.enabled() ? await lastfm.artist(displayName).catch(() => null) : null;

  // Your own numbers from MusicForge history.
  const lower = displayName.toLowerCase();
  const mine = state.history.filter((e) => (e.artist || '').toLowerCase().split(',')[0].trim() === lower);
  const myMs = mine.reduce((a, e) => a + e.ms, 0);
  const localTracks = state.library.tracks.filter((t) => (t.albumArtist || t.artist || '').toLowerCase() === lower || (t.artist || '').toLowerCase() === lower).map(local.map);

  const watchBtn = artist ? h('button', { class: `btn ${isWatched(artist.id) ? 'ghost' : 'primary'}` }) : null;
  const paintWatch = () => {
    if (!watchBtn) return;
    const w = isWatched(artist.id);
    watchBtn.className = `btn ${w ? 'ghost' : 'primary'}`;
    watchBtn.replaceChildren(icon(w ? 'check' : 'eye', 16), w ? 'Watching' : 'Watch stats');
  };
  if (watchBtn) watchBtn.onclick = () => { if (isWatched(artist.id)) { unwatch(artist.id); toast(`Stopped watching ${artist.name}`); } else { watch(artist); toast(`Watching ${artist.name}`); } paintWatch(); };
  paintWatch();

  const stats = h('div', { class: 'artist-stats' },
    artist?.fans != null ? stat(fmtFull(artist.fans), 'Deezer fans') : null,
    lf ? stat(fmtFull(lf.listeners), 'Last.fm listeners') : null,
    lf ? stat(fmtFull(lf.playcount), 'Last.fm plays') : null,
    lf?.userPlaycount != null ? stat(fmtFull(lf.userPlaycount), 'your scrobbles') : null,
    mine.length ? stat(fmtLong(myMs / 1000), `your time in MusicForge · ${mine.length} plays`) : null);

  view.replaceChildren(h('div', { class: 'artist-hero' },
    img(artist?.imageLarge || artist?.image, '', 'pic'),
    h('div', { style: { minWidth: 0 } },
      h('div', { class: 'coll-kind' }, 'Artist'),
      h('h1', { class: 'coll-title' }, displayName || 'Unknown artist'),
      stats,
      h('div', { class: 'row', style: { marginTop: '18px' } }, watchBtn,
        artist?.url ? h('button', { class: 'btn ghost', onclick: () => mf.invoke('shell:open', artist.url) }, icon('external', 16), 'Deezer') : null,
        lf?.url ? h('button', { class: 'btn ghost', onclick: () => mf.invoke('shell:open', lf.url) }, icon('external', 16), 'Last.fm') : null),
      lf?.tags?.length ? h('div', { class: 'tagline' }, lf.tags.slice(0, 6).map((t) => h('span', { class: 'tag' }, t))) : null)));

  if (!artist && !localTracks.length && !lf) {
    view.append(emptyState('Artist not found', 'Deezer has no artist by that name, and there’s nothing local or on Last.fm.'));
    return;
  }

  const section = (title, el) => h('section', { class: 'section' }, h('div', { class: 'section-head' }, h('h2', { class: 't-sec' }, title)), el);
  if (artist) {
    const topSlot = h('div', null, loadingLine());
    view.append(section('Popular', topSlot));
    deezer.artistTop(artist.id, 10).then((tracks) => topSlot.replaceChildren(trackList(tracks, { context: { type: 'artist', id: artist.id } }))).catch((err) => topSlot.replaceChildren(h('p', { class: 't-meta' }, err.message)));
  }
  if (localTracks.length) view.append(section('In your library', trackList(localTracks)));
  if (lf?.bio) view.append(section('About', h('p', { class: 'artist-bio' }, lf.bio)));
  if (artist) {
    const albumSlot = h('div', null, loadingLine());
    const relSlot = h('div');
    view.append(section('Releases', albumSlot), section('Similar artists', relSlot));
    deezer.artistAlbums(artist.id).then((albums) => {
      const seen = new Set();
      const uniq = albums.filter((a) => (seen.has(a.title.toLowerCase()) ? false : seen.add(a.title.toLowerCase())));
      albumSlot.replaceChildren(h('div', { class: 'tiles' }, uniq.map((a) => tile({
        image: a.cover, name: a.title, sub: [a.year, a.type].filter(Boolean).join(' · '),
        onOpen: () => go('album', { kind: 'deezer', id: a.id }),
        onPlay: async () => { const al = await deezer.album(a.id); engine.playList(al.tracks, 0, { type: 'album', id: `dz:${a.id}` }); },
      }))));
    }).catch((err) => albumSlot.replaceChildren(h('p', { class: 't-meta' }, err.message)));
    deezer.related(artist.id).then((rel) => relSlot.replaceChildren(h('div', { class: 'tiles scroller' }, rel.map((a) => tile({ image: a.image, name: a.name, round: true, onOpen: () => go('artist', { name: a.name, dz: a.id }) }))))).catch(() => relSlot.remove());
  }
}
