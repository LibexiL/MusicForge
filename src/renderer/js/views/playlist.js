// One view for MusicForge playlists, live service playlists (remote) and albums.
import { h, icon, iconBtn, img, fmtLong, fmtAgo } from '../util.js';
import { state, on, mf } from '../state.js';
import { spotify, youtube, deezer, local, NAMES } from '../services.js';
import { engine } from '../player/engine.js';
import { go } from '../router.js';
import { trackList, loadingLine, emptyState, toast, prompt, confirm, menu, addToPlaylistFlow } from '../ui/components.js';
import { getPlaylist, renamePlaylist, deletePlaylist, importPlaylist, resyncPlaylist, fetchRemote } from '../playlists.js';
import { groupAlbums } from './library.js';

function collage(tracks, fallbackImage) {
  const arts = [...new Set(tracks.map((t) => t.art).filter(Boolean))].slice(0, 4);
  if (fallbackImage) return h('div', { class: 'coll-art single' }, img(fallbackImage));
  if (arts.length >= 4) return h('div', { class: 'coll-art' }, arts.map((a) => img(a)));
  if (arts.length) return h('div', { class: 'coll-art single' }, img(arts[0]));
  return h('div', { class: 'coll-art' }, h('div', { class: 'ph' }, icon('note', 48)));
}

function sourceSummary(tracks) {
  const c = {};
  for (const t of tracks) c[t.origin] = (c[t.origin] || 0) + 1;
  return Object.entries(c).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${n} ${NAMES[k] || k}`).join(', ');
}

function header({ kind, title, tracks, image, extra = [] }) {
  const total = tracks.reduce((s, t) => s + (t.duration || 0), 0);
  return h('div', { class: 'coll-head' }, collage(tracks, image),
    h('div', { style: { minWidth: 0 } },
      h('div', { class: 'coll-kind' }, kind),
      h('h1', { class: 'coll-title' }, title),
      h('div', { class: 'coll-meta' }, [`${tracks.length} song${tracks.length === 1 ? '' : 's'}`, total ? fmtLong(total) : null, tracks.length ? sourceSummary(tracks) : null, ...extra].filter(Boolean).join(' · '))));
}

function actions(tracks, context, more) {
  let filterSlot = null;
  const el = h('div', { class: 'coll-actions' },
    h('button', { class: 'btn big-play primary', title: 'Play', 'aria-label': 'Play', disabled: !tracks.length, onclick: () => { if (engine.shuffle) engine.toggleShuffle(); engine.playList(tracks, 0, context); } }, icon('play', 20)),
    iconBtn('shuffle', 'Shuffle play', () => { if (!engine.shuffle) engine.toggleShuffle(); engine.playList(tracks, Math.floor(Math.random() * tracks.length), context); }),
    iconBtn('plus', 'Add all to a playlist', () => addToPlaylistFlow(tracks)),
    iconBtn('queue', 'Add all to queue', () => engine.enqueue(tracks)),
    more ? iconBtn('more', 'More', (e) => menu(more(), e.clientX, e.clientY)) : null);
  return { el, setFilter: (input) => { filterSlot = input; el.append(input); return filterSlot; } };
}

export function render(params, routeName) {
  if (routeName === 'remote') return remote(params);
  if (routeName === 'album') return album(params);
  return own(params);
}

function own({ id }) {
  const view = h('div', { class: 'view' });
  let list = null;
  const draw = () => {
    list?._cleanup?.();
    view.replaceChildren();
    const p = getPlaylist(id);
    if (!p) { view.append(emptyState('Playlist not found', 'It may have been deleted.')); return; }
    const context = { type: 'playlist', id: p.id };
    const kind = p.source ? `Playlist · imported from ${NAMES[p.source.service]}` : 'Playlist';
    const more = () => [
      { text: 'Rename', icon: 'settings', run: async () => { const n = await prompt({ title: 'Rename playlist', value: p.name }); if (n) { renamePlaylist(p.id, n); draw(); } } },
      p.source ? { text: `Sync again from ${NAMES[p.source.service]}`, icon: 'refresh', run: async () => { toast('Syncing…'); try { await resyncPlaylist(p.id); toast('Playlist synced'); draw(); } catch (err) { toast(err.message, 'error'); } } } : null,
      p.source?.url ? { text: `Open in ${NAMES[p.source.service]}`, icon: 'external', run: () => mf.invoke('shell:open', p.source.url) } : null,
      '-',
      { text: 'Delete playlist', icon: 'trash', run: async () => { if (await confirm({ title: `Delete “${p.name}”?`, text: 'This removes the playlist from MusicForge. Songs and your accounts are not affected.' })) { deletePlaylist(p.id); go('library', { tab: 'playlists' }, { replace: true }); } } },
    ];
    const a = actions(p.tracks, context, more);
    let filtered = p.tracks;
    const listSlot = h('div');
    const paint = () => {
      list?._cleanup?.();
      list = trackList(filtered, { context, playlistId: filtered === p.tracks ? p.id : null, onPlay: (i) => engine.playList(filtered, i, context) });
      listSlot.replaceChildren(list);
    };
    if (p.tracks.length > 12) {
      a.setFilter(h('input', { class: 'coll-filter', placeholder: 'Filter this playlist', oninput: (e) => {
        const w = e.target.value.toLowerCase().trim();
        filtered = w ? p.tracks.filter((t) => `${t.title} ${t.artist} ${t.album}`.toLowerCase().includes(w)) : p.tracks;
        paint();
      } }));
    }
    view.append(header({ kind, title: p.name, tracks: p.tracks, extra: [p.source ? `synced ${fmtAgo(p.updated)}` : null] }), a.el);
    if (!p.tracks.length) view.append(emptyState('This playlist is empty', 'Right-click any song, anywhere, and choose Add to playlist.'));
    else { view.append(listSlot); paint(); }
  };
  draw();
  const off1 = on('playlist-changed', (pid) => { if (pid === id) draw(); });
  return { el: view, cleanup: () => { off1(); list?._cleanup?.(); } };
}

function remote({ service, id, name, image, url }) {
  const view = h('div', { class: 'view' });
  const body = h('div', null, loadingLine());
  view.append(body);
  let list = null;
  const load = id === 'liked'
    ? (service === 'spotify' ? spotify.liked() : youtube.liked())
    : fetchRemote(service, id);
  load.then((tracks) => {
    const context = { type: 'remote', id: `${service}:${id}` };
    const importBtn = id === 'liked'
      ? h('button', { class: 'btn ghost', onclick: async () => {
        const { createPlaylist } = await import('../playlists.js');
        const p = createPlaylist(`${NAMES[service]} likes`, tracks, null);
        toast(`Saved as “${p.name}”`);
        go('playlist', { id: p.id });
      } }, icon('import', 16), 'Save as playlist')
      : h('button', { class: 'btn ghost', onclick: async (e) => {
        e.currentTarget.disabled = true;
        try {
          const r = await importPlaylist(service, { id, name, url });
          toast(r.updated ? `Updated “${r.playlist.name}”` : `Imported “${r.playlist.name}”`);
          go('playlist', { id: r.playlist.id });
        } catch (err) { toast(err.message, 'error'); e.target.disabled = false; }
      } }, icon('import', 16), 'Import to MusicForge');
    const a = actions(tracks, context, url ? () => [{ text: `Open in ${NAMES[service]}`, icon: 'external', run: () => mf.invoke('shell:open', url) }] : null);
    a.el.append(importBtn);
    list = trackList(tracks, { context });
    body.replaceChildren(header({ kind: `${NAMES[service]} playlist`, title: name, tracks, image }), a.el, tracks.length ? list : emptyState('No songs', 'This playlist is empty.'));
  }).catch((err) => body.replaceChildren(header({ kind: `${NAMES[service]} playlist`, title: name, tracks: [], image }), emptyState("Couldn't load this playlist", err.message)));
  return { el: view, cleanup: () => list?._cleanup?.() };
}

function album({ kind, key, id }) {
  const view = h('div', { class: 'view' });
  if (kind === 'local') {
    const a = groupAlbums().find((x) => x.key === key);
    if (!a) { view.append(emptyState('Album not found', 'It may have been removed from your folders.')); return { el: view }; }
    const tracks = a.tracks.slice().sort((x, y) => (x.disc - y.disc) || (x.no - y.no)).map(local.map);
    const context = { type: 'album', id: key };
    view.append(header({ kind: 'Album · local files', title: a.album, tracks, extra: [a.artist, a.year || null] }), actions(tracks, context).el, trackList(tracks, { showAlbum: false, context }));
    return { el: view };
  }
  const body = h('div', null, loadingLine());
  view.append(body);
  deezer.album(id).then((al) => {
    const context = { type: 'album', id: `dz:${id}` };
    body.replaceChildren(header({ kind: 'Album', title: al.title, tracks: al.tracks, image: al.cover, extra: [al.artist] }), actions(al.tracks, context).el, trackList(al.tracks, { showAlbum: false, context }));
  }).catch((err) => body.replaceChildren(emptyState("Couldn't load this album", err.message)));
  return { el: view };
}
