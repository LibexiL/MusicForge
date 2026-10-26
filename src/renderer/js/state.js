// App state, persisted through the main process with debounced writes.
import { debounce } from './util.js';

export const mf = window.mf;

export const bus = new EventTarget();
export const emit = (name, detail) => bus.dispatchEvent(new CustomEvent(name, { detail }));
export const on = (name, fn) => {
  const f = (e) => fn(e.detail);
  bus.addEventListener(name, f);
  return () => bus.removeEventListener(name, f);
};

export const DEFAULT_SETTINGS = {
  sourceOrder: ['local', 'spotify', 'youtube', 'soundcloud', 'preview'],
  spotifyMode: 'auto',
  spotifyDevice: '',
  dynamicAccent: true,
  accent: '#E9B949',
  volume: 0.8,
  muted: false,
  vis: { style: 'bars', bars: 72, smoothing: 0.7, source: 'auto', device: '', peaks: true, palette: 'temper', sensitivity: 1 },
  scrobble: true,
  lyricsOffset: 0,
  scanOnStart: true,
  tray: true,
  closeToTray: false,
  mediaKeys: null,
  reduceMotion: false,
  outputDevice: '',
  resolveWithYouTube: true,
};

export const state = {
  info: null,
  auth: null,
  settings: structuredClone(DEFAULT_SETTINGS),
  playlists: [],
  liked: [],
  history: [],
  watchlist: [],
  resolve: {},
  queue: null,
  library: { folders: [], tracks: [], scanning: false },
};

const PERSISTED = ['settings', 'playlists', 'liked', 'history', 'watchlist', 'resolve', 'queue'];
const savers = {};
for (const key of PERSISTED) {
  savers[key] = debounce(() => mf.invoke('store:set', key, state[key]), key === 'queue' ? 2000 : 400);
}
export function save(key) {
  savers[key]?.();
  emit(`change:${key}`, state[key]);
}

function merge(def, val) {
  if (!val || typeof val !== 'object' || Array.isArray(val)) return val ?? def;
  const out = { ...def };
  for (const [k, v] of Object.entries(val)) {
    out[k] = def && typeof def[k] === 'object' && !Array.isArray(def[k]) && def[k] ? merge(def[k], v) : v;
  }
  return out;
}

export async function loadState() {
  const [info, data, auth, library] = await Promise.all([
    mf.invoke('app:info'),
    mf.invoke('store:load'),
    mf.invoke('auth:status'),
    mf.invoke('library:get'),
  ]);
  state.info = info;
  state.auth = auth;
  state.library = library;
  state.settings = merge(DEFAULT_SETTINGS, data.settings);
  if (state.settings.mediaKeys === null) state.settings.mediaKeys = info.platform === 'win32';
  for (const k of ['playlists', 'liked', 'history', 'watchlist']) if (Array.isArray(data[k])) state[k] = data[k];
  if (data.resolve && typeof data.resolve === 'object') state.resolve = data.resolve;
  if (data.queue) state.queue = data.queue;

  mf.on('auth:changed', (a) => { state.auth = a; emit('auth', a); });
}

export async function refreshAuth() {
  state.auth = await mf.invoke('auth:status');
  emit('auth', state.auth);
  return state.auth;
}

export async function refreshLibrary() {
  state.library = await mf.invoke('library:get');
  emit('library', state.library);
  return state.library;
}

export const mediaUrl = (id) => `${state.info.origin}/media?id=${encodeURIComponent(id)}&t=${state.info.mediaToken}`;
export const coverUrl = (id) => `${state.info.origin}/cover?id=${encodeURIComponent(id)}&t=${state.info.mediaToken}`;
export const proxyUrl = (u) => `${state.info.origin}/proxy?u=${encodeURIComponent(u)}&t=${state.info.mediaToken}`;

export const connected = (svc) => !!state.auth?.[svc]?.connected;
export const youtubeSearchable = () => !!(state.auth?.youtube?.connected || state.auth?.youtube?.hasKey);

// Likes are stored as full track snapshots so the Liked list works offline and across services.
export function isLiked(track) { return !!track && state.liked.some((t) => t.key === track.key); }
export function toggleLike(track) {
  const i = state.liked.findIndex((t) => t.key === track.key);
  if (i >= 0) state.liked.splice(i, 1);
  else state.liked.unshift(slim(track));
  save('liked');
  return i < 0;
}

// Strip transient fields before persisting a track.
export function slim(t) {
  const { key, title, artist, album, duration, art, artLarge, src, origin, url, artistId } = t;
  return { key, title, artist, album, duration, art, artLarge, src: { ...src }, origin, url, artistId };
}
