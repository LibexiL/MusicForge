// MusicForge playlists: mix songs from any service in one list. Imports are snapshots
// that remember where they came from, so they can be re-synced.
import { state, save, slim, emit } from './state.js';
import { uid } from './util.js';
import { spotify, youtube, deezer, apple } from './services.js';

export function createPlaylist(name, tracks = [], source = null) {
  const p = { id: uid(), name, created: Date.now(), updated: Date.now(), tracks: dedupe(tracks.map(slim)), source };
  state.playlists.unshift(p);
  save('playlists');
  emit('playlists');
  return p;
}

function dedupe(tracks) {
  const seen = new Set();
  return tracks.filter((t) => (seen.has(t.key) ? false : seen.add(t.key)));
}

export function getPlaylist(id) { return state.playlists.find((p) => p.id === id); }

export function addToPlaylist(id, tracks) {
  const p = getPlaylist(id);
  if (!p) return 0;
  const have = new Set(p.tracks.map((t) => t.key));
  const add = tracks.filter((t) => !have.has(t.key)).map(slim);
  p.tracks.push(...add);
  p.updated = Date.now();
  save('playlists');
  emit('playlists');
  return add.length;
}

export function removeFromPlaylist(id, indices) {
  const p = getPlaylist(id);
  if (!p) return;
  const drop = new Set(indices);
  p.tracks = p.tracks.filter((_, i) => !drop.has(i));
  p.updated = Date.now();
  save('playlists');
  emit('playlists');
}

export function renamePlaylist(id, name) {
  const p = getPlaylist(id);
  if (!p) return;
  p.name = name;
  save('playlists');
  emit('playlists');
}

export function deletePlaylist(id) {
  state.playlists = state.playlists.filter((p) => p.id !== id);
  save('playlists');
  emit('playlists');
}

export function movePlaylistTrack(id, from, to) {
  const p = getPlaylist(id);
  if (!p) return;
  const [t] = p.tracks.splice(from, 1);
  p.tracks.splice(to, 0, t);
  save('playlists');
}

export async function fetchRemote(service, id) {
  if (service === 'spotify') return spotify.playlistTracks(id);
  if (service === 'youtube') return youtube.playlistTracks(id);
  if (service === 'deezer') return (await deezer.playlist(id)).tracks;
  if (service === 'apple') return apple.playlistTracks(id);
  throw new Error(`Can't import from ${service}`);
}

export async function importPlaylist(service, remote) {
  const tracks = await fetchRemote(service, remote.id);
  const existing = state.playlists.find((p) => p.source?.service === service && p.source?.id === remote.id);
  if (existing) {
    existing.tracks = dedupe(tracks.map(slim));
    existing.updated = Date.now();
    save('playlists');
    emit('playlists');
    return { playlist: existing, updated: true };
  }
  const p = createPlaylist(remote.name, tracks, { service, id: remote.id, url: remote.url || null });
  return { playlist: p, updated: false };
}

export async function resyncPlaylist(id) {
  const p = getPlaylist(id);
  if (!p?.source) return null;
  return importPlaylist(p.source.service, { id: p.source.id, name: p.name, url: p.source.url });
}
