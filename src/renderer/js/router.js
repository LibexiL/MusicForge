// Tiny view router with back/forward history. Views are lazy-loaded modules exporting
// render(params) → { el, cleanup? } (or a Promise of one).
import { clear } from './util.js';
import { emit } from './state.js';

const VIEWS = {
  home: () => import('./views/home.js'),
  search: () => import('./views/search.js'),
  library: () => import('./views/library.js'),
  playlist: () => import('./views/playlist.js'),
  remote: () => import('./views/playlist.js'),
  album: () => import('./views/playlist.js'),
  nowplaying: () => import('./views/nowplaying.js'),
  video: () => import('./views/video.js'),
  stats: () => import('./views/stats.js'),
  artists: () => import('./views/artists.js'),
  artist: () => import('./views/artist.js'),
  accounts: () => import('./views/accounts.js'),
  settings: () => import('./views/settings.js'),
};

const main = document.getElementById('main');
const back = [];
const fwd = [];
let current = null;
let cleanup = null;
let renderToken = 0;

export function currentRoute() { return current; }

export function go(name, params = {}, { replace = false, keepForward = false } = {}) {
  if (current && !replace) back.push({ ...current, scroll: main.scrollTop });
  if (!keepForward) fwd.length = 0;
  current = { name, params };
  return render();
}

export function goBack() {
  if (!back.length) return;
  fwd.push({ ...current, scroll: main.scrollTop });
  current = back.pop();
  return render(current.scroll);
}

export function goForward() {
  if (!fwd.length) return;
  back.push({ ...current, scroll: main.scrollTop });
  current = fwd.pop();
  return render(current.scroll);
}

export function refresh() { return render(main.scrollTop); }

async function render(scroll = 0) {
  const token = ++renderToken;
  const { name, params } = current;
  try { cleanup?.(); } catch { /* ignore */ }
  cleanup = null;
  emit('route', current);
  const mod = await (VIEWS[name] || VIEWS.home)();
  if (token !== renderToken) return;
  let out;
  try {
    out = await mod.render(params, name);
  } catch (err) {
    console.error(err);
    const { h } = await import('./util.js');
    out = { el: h('div', { class: 'view' }, h('h1', { class: 't-display' }, 'Something went wrong'), h('p', { class: 't-sub' }, err.message)) };
  }
  if (token !== renderToken) { out?.cleanup?.(); return; }
  clear(main).append(out.el);
  cleanup = out.cleanup || null;
  main.dataset.view = name;
  main.scrollTop = scroll;
  out.mounted?.();
  emit('route-rendered', current);
}

export const canGoBack = () => back.length > 0;
export const canGoForward = () => fwd.length > 0;
