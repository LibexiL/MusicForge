// Artist watch: follow Deezer fans and Last.fm listeners/plays over time. A snapshot is
// stored at most once per day per artist; the trend line is built from those snapshots.
import { h, img, fmtNum, fmtFull, fmtAgo, iconBtn, icon } from '../util.js';
import { state, save, on } from '../state.js';
import { deezer, lastfm } from '../services.js';
import { go } from '../router.js';
import { emptyState, pick, toast } from '../ui/components.js';

const STALE = 6 * 3600 * 1000;

export function isWatched(id) { return state.watchlist.some((a) => String(a.id) === String(id)); }

export function watch(artist) {
  if (isWatched(artist.id)) return;
  state.watchlist.push({ id: artist.id, name: artist.name, image: artist.image, added: Date.now(), snaps: [] });
  save('watchlist');
  refreshArtist(state.watchlist[state.watchlist.length - 1]);
}

export function unwatch(id) {
  state.watchlist = state.watchlist.filter((a) => String(a.id) !== String(id));
  save('watchlist');
}

export async function refreshArtist(entry, force = false) {
  const last = entry.snaps[entry.snaps.length - 1];
  if (!force && last && Date.now() - last.t < STALE) return false;
  const [dz, lf] = await Promise.all([
    deezer.artist(entry.id).catch(() => null),
    lastfm.enabled() ? lastfm.artist(entry.name).catch(() => null) : Promise.resolve(null),
  ]);
  if (!dz && !lf) return false;
  const snap = { t: Date.now(), fans: dz?.fans ?? null, albums: dz?.albums ?? null, listeners: lf?.listeners ?? null, plays: lf?.playcount ?? null };
  if (dz?.image) entry.image = dz.image;
  const day = new Date(snap.t).toDateString();
  if (last && new Date(last.t).toDateString() === day) entry.snaps[entry.snaps.length - 1] = snap;
  else entry.snaps.push(snap);
  if (entry.snaps.length > 400) entry.snaps.splice(0, entry.snaps.length - 400);
  save('watchlist');
  return true;
}

function deltaSince(entry, field, days) {
  const snaps = entry.snaps.filter((x) => x[field] != null);
  if (snaps.length < 2) return null;
  const last = snaps[snaps.length - 1];
  const cutoff = last.t - days * 86400000;
  const base = [...snaps].reverse().find((x) => x.t <= cutoff) || snaps[0];
  if (base === last) return null;
  return last[field] - base[field];
}

function deltaEl(d) {
  if (d == null || d === 0) return null;
  return h('span', { class: `delta ${d > 0 ? 'up' : 'down'}`, title: 'Change over the last 7 days of snapshots' }, `${d > 0 ? '+' : '−'}${fmtNum(Math.abs(d))}`);
}

function sparkline(entry, field = 'fans') {
  const pts = entry.snaps.filter((x) => x[field] != null).slice(-60);
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'spark');
  svg.setAttribute('viewBox', '0 0 110 30');
  if (pts.length < 2) {
    const t = document.createElementNS(NS, 'title');
    t.textContent = 'Trend appears after a second day of snapshots';
    svg.append(t);
    return svg;
  }
  const min = Math.min(...pts.map((p) => p[field]));
  const max = Math.max(...pts.map((p) => p[field]));
  const t0 = pts[0].t; const t1 = pts[pts.length - 1].t;
  const xy = pts.map((p) => [((p.t - t0) / (t1 - t0 || 1)) * 108 + 1, 28 - ((p[field] - min) / (max - min || 1)) * 26]);
  const line = xy.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join('');
  const area = document.createElementNS(NS, 'path');
  area.setAttribute('class', 'area');
  area.setAttribute('d', `${line}L${xy[xy.length - 1][0]},30L${xy[0][0]},30Z`);
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', line);
  const title = document.createElementNS(NS, 'title');
  title.textContent = `${fmtFull(pts[0][field])} → ${fmtFull(pts[pts.length - 1][field])} (${pts.length} days)`;
  svg.append(title, area, path);
  return svg;
}

export async function addArtistFlow(query) {
  const q = query || (await (await import('../ui/components.js')).prompt({ title: 'Watch an artist', placeholder: 'Artist name', ok: 'Search' }));
  if (!q) return;
  let results;
  try { results = await deezer.searchArtists(q, 8); } catch (err) { toast(err.message, 'error'); return; }
  if (!results.length) { toast(`No artist found for “${q}”`, 'error'); return; }
  const chosen = await pick({ title: 'Which artist?', items: results.map((a) => ({ img: a.image, t: a.name, a: `${fmtNum(a.fans)} fans on Deezer`, value: a })) });
  if (chosen) { watch(chosen); toast(`Watching ${chosen.name}`); }
}

export function render() {
  const view = h('div', { class: 'view' });
  const tableSlot = h('div');
  view.append(h('div', { class: 'view-head' },
    h('div', null, h('h1', { class: 't-display' }, 'Artist watch'),
      h('p', { class: 't-sub' }, 'Fan and listener counts for artists you follow. MusicForge saves one snapshot a day, so trends grow the longer you watch.')),
    h('div', { class: 'row' },
      h('button', { class: 'btn ghost', onclick: () => refreshAll(true) }, icon('refresh', 16), 'Refresh'),
      h('button', { class: 'btn primary', onclick: () => addArtistFlow() }, icon('plus', 16), 'Watch an artist'))),
  tableSlot);

  const draw = () => {
    if (!state.watchlist.length) {
      tableSlot.replaceChildren(emptyState('Not watching anyone yet', 'Add artists to track their Deezer fans, and their Last.fm listeners and plays if Last.fm is set up. Tip: on any artist page, choose Watch.'));
      return;
    }
    const lf = lastfm.enabled();
    tableSlot.replaceChildren(h('table', { class: 'watch' },
      h('thead', null, h('tr', null,
        h('th', null, 'Artist'), h('th', { class: 'num' }, 'Deezer fans'),
        lf ? h('th', { class: 'num' }, 'Last.fm listeners') : null, lf ? h('th', { class: 'num' }, 'Last.fm plays') : null,
        h('th', null, 'Fans trend'), h('th', null, 'Updated'), h('th'))),
      h('tbody', null, state.watchlist.map((a) => {
        const s = a.snaps[a.snaps.length - 1] || {};
        return h('tr', null,
          h('td', null, h('div', { class: 'who', onclick: () => go('artist', { name: a.name, dz: a.id }) }, img(a.image), h('b', null, a.name))),
          h('td', { class: 'num' }, s.fans != null ? fmtFull(s.fans) : '—', deltaEl(deltaSince(a, 'fans', 7))),
          lf ? h('td', { class: 'num' }, s.listeners != null ? fmtFull(s.listeners) : '—', deltaEl(deltaSince(a, 'listeners', 7))) : null,
          lf ? h('td', { class: 'num' }, s.plays != null ? fmtFull(s.plays) : '—', deltaEl(deltaSince(a, 'plays', 7))) : null,
          h('td', null, sparkline(a)),
          h('td', { class: 'faint' }, s.t ? fmtAgo(s.t) : 'pending'),
          h('td', null, iconBtn('close', `Stop watching ${a.name}`, () => { unwatch(a.id); draw(); }, { class: 'small', size: 15 })));
      }))));
  };

  const refreshAll = async (force = false) => {
    let changed = false;
    for (const a of state.watchlist) {
      try { if (await refreshArtist(a, force)) changed = true; } catch { /* keep going */ }
    }
    if (changed && view.isConnected) draw();
    if (force) toast('Artist stats refreshed');
  };
  draw();
  refreshAll();
  const off = on('change:watchlist', () => view.isConnected && draw());
  return { el: view, cleanup: off };
}
