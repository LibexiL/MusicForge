import { h, img, fmtNum, fmtFull, fmtAgo, fmtLong } from '../util.js';
import { state, connected } from '../state.js';
import { spotify, lastfm, NAMES } from '../services.js';
import { engine } from '../player/engine.js';
import { go } from '../router.js';
import { loadingLine, emptyState, trackList } from '../ui/components.js';

const SVG = 'http://www.w3.org/2000/svg';
const s = (tag, attrs = {}, ...kids) => {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, v);
  for (const c of kids) if (c != null) el.append(c);
  return el;
};

const DAY = 86400000;
const RANGES = [['7', '7 days'], ['30', '30 days'], ['365', '12 months'], ['all', 'All time']];

export function render({ tab = 'listening', range = '30' } = {}) {
  const tabs = [['listening', 'Your listening'], ['spotify', 'Spotify'], ['lastfm', 'Last.fm']];
  const view = h('div', { class: 'view' },
    h('div', { class: 'view-head' }, h('div', null, h('h1', { class: 't-display' }, 'Stats'),
      h('p', { class: 't-sub' }, 'What you play in MusicForge, plus your Spotify and Last.fm history.'))),
    h('div', { class: 'tabs' }, tabs.map(([id, text]) => h('button', { class: `chip ${id === tab ? 'on' : ''}`, onclick: () => go('stats', { tab: id, range }, { replace: true }) }, text))));
  const body = h('div');
  view.append(body);
  if (tab === 'listening') listening(body, range);
  else if (tab === 'spotify') spotifyStats(body, range);
  else lastfmStats(body, range);
  return { el: view };
}

function rangeChips(tab, range, opts = RANGES) {
  return h('div', { class: 'tabs' }, opts.map(([id, text]) => h('button', { class: `chip ${id === range ? 'on' : ''}`, onclick: () => go('stats', { tab, range: id }, { replace: true }) }, text)));
}

function block(title, el, meta) {
  return h('section', { class: 'section' }, h('div', { class: 'section-head' }, h('h2', { class: 't-sec' }, title), meta ? h('span', { class: 't-meta' }, meta) : null), el);
}

// Rounded-top bar path anchored to the baseline.
function barPath(x, y, w, hgt) {
  const r = Math.min(4, w / 2, hgt);
  return `M${x},${y + hgt}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + hgt}Z`;
}

function dailyChart(days) {
  // days: [{ date, min }], oldest first. One series: minutes listened per day.
  const W = 1000; const H = 180; const padL = 34; const padB = 22; const padT = 8;
  const max = Math.max(10, ...days.map((d) => d.min));
  const step = niceStep(max);
  const top = Math.ceil(max / step) * step;
  const svg = s('svg', { class: 'chart', viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', role: 'img', 'aria-label': 'Minutes listened per day' });
  const plotW = W - padL; const plotH = H - padB - padT;
  for (let v = 0; v <= top; v += step) {
    const y = padT + plotH - (v / top) * plotH;
    svg.append(s('line', { class: 'grid', x1: padL, x2: W, y1: y, y2: y }), s('text', { class: 'axis', x: padL - 6, y: y + 4, 'text-anchor': 'end' }, String(v)));
  }
  const n = days.length;
  const slot = plotW / n;
  const bw = Math.max(1, slot - 2);
  days.forEach((d, i) => {
    const bh = (d.min / top) * plotH;
    const x = padL + i * slot + 1;
    const label = `${d.date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}: ${Math.round(d.min)} min`;
    const g = s('g', null, s('title', null, label));
    g.append(s('rect', { x: padL + i * slot, y: padT, width: slot, height: plotH, fill: 'transparent' }));
    if (bh > 0) g.append(s('path', { class: `bar ${i === n - 1 ? 'today' : ''}`, d: barPath(x, padT + plotH - bh, bw, bh) }));
    svg.append(g);
    const every = n > 60 ? 30 : n > 14 ? 7 : 1;
    if ((n - 1 - i) % every === 0) svg.append(s('text', { class: 'axis', x: x + bw / 2, y: H - 6, 'text-anchor': 'middle' }, d.date.toLocaleDateString(undefined, n > 14 ? { month: 'short', day: 'numeric' } : { weekday: 'short' })));
  });
  return svg;
}

function niceStep(max) {
  const raw = max / 4;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const n = raw / pow;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * pow;
}

function rankList(items, { round = false } = {}) {
  const max = Math.max(1, ...items.map((i) => i.value || 0));
  return h('ol', { class: 'rank' }, items.map((it) => h('li', { class: round ? 'round' : '', style: { cursor: it.open ? 'pointer' : 'default' }, onclick: it.open },
    img(it.image), h('div', { class: 'tt' }, h('div', { class: 't' }, it.title), it.sub ? h('div', { class: 'a' }, it.sub) : null),
    h('div', { class: 'val' }, it.label, it.value ? h('div', { class: 'barline', style: { width: `${(it.value / max) * 100}%` } }) : null))));
}

// ---------------------------------------------------------------- MusicForge history
function listening(body, range) {
  const hist = state.history;
  if (!hist.length) {
    body.append(emptyState('No listening yet', 'Play songs from any service and your stats build up here: time listened, top artists and songs, and which services you use most. Songs count after 30 seconds.'));
    return;
  }
  const now = Date.now();
  const since = range === 'all' ? 0 : now - (+range) * DAY;
  const rows = hist.filter((e) => e.t >= since);
  body.append(rangeChips('listening', range));

  const totalMs = rows.reduce((a, e) => a + e.ms, 0);
  const artists = new Map(); const tracks = new Map(); const sources = new Map();
  for (const e of rows) {
    const a = (e.artist || 'Unknown').split(',')[0].trim();
    const ar = artists.get(a) || { name: a, ms: 0, plays: 0, art: e.art };
    ar.ms += e.ms; ar.plays++; artists.set(a, ar);
    const tr = tracks.get(e.key) || { e, plays: 0, ms: 0 };
    tr.plays++; tr.ms += e.ms; tracks.set(e.key, tr);
    sources.set(e.src, (sources.get(e.src) || 0) + e.ms);
  }
  body.append(h('div', { class: 'facts' },
    fact(fmtLong(totalMs / 1000), 'listened'),
    fact(fmtFull(rows.length), 'plays'),
    fact(fmtFull(tracks.size), 'different songs'),
    fact(fmtFull(artists.size), 'artists')));

  // Daily chart over the last 7/30 days (or 30 for longer ranges).
  const nDays = range === '7' ? 7 : 30;
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const days = [];
  for (let i = nDays - 1; i >= 0; i--) days.push({ date: new Date(start.getTime() - i * DAY), min: 0 });
  const first = days[0].date.getTime();
  for (const e of hist) {
    if (e.t < first) continue;
    const idx = Math.floor((new Date(e.t).setHours(0, 0, 0, 0) - first) / DAY);
    if (days[idx]) days[idx].min += e.ms / 60000;
  }
  body.append(block('Minutes per day', dailyChart(days), `last ${nDays} days · today highlighted`));

  // Share by source (identity colours; every segment is labelled in the legend).
  const total = [...sources.values()].reduce((a, b) => a + b, 0) || 1;
  const srcs = [...sources.entries()].sort((a, b) => b[1] - a[1]);
  body.append(block('Where your music came from', h('div', null,
    h('div', { class: 'share', role: 'img', 'aria-label': srcs.map(([k, v]) => `${NAMES[k] || k} ${Math.round(v / total * 100)}%`).join(', ') },
      srcs.map(([k, v]) => h('div', { class: `src-${k}`, style: { flex: `${v} 0 0` }, title: `${NAMES[k] || k}: ${fmtLong(v / 1000)}` }))),
    h('div', { class: 'share-legend' }, srcs.map(([k, v]) => h('span', { class: `src src-${k}` }, NAMES[k] || k, h('b', null, `${Math.round(v / total * 100)}%`)))))));

  const topArtists = [...artists.values()].sort((a, b) => b.ms - a.ms).slice(0, 10);
  const topTracks = [...tracks.values()].sort((a, b) => b.plays - a.plays || b.ms - a.ms).slice(0, 10);
  body.append(h('div', { class: 'two-col section' },
    block('Top artists', rankList(topArtists.map((a) => ({ title: a.name, sub: `${a.plays} plays`, image: a.art, label: fmtLong(a.ms / 1000), value: a.ms, open: () => go('artist', { name: a.name }) })), { round: true })),
    block('Top songs', rankList(topTracks.map((t) => ({ title: t.e.title, sub: t.e.artist, image: t.e.art, label: `${t.plays} plays`, value: t.plays }))))));

  const recent = hist.slice(-25).reverse();
  body.append(block('Recently played', rankList(recent.map((e) => ({ title: e.title, sub: `${e.artist} · ${NAMES[e.src] || e.src}`, image: e.art, label: fmtAgo(e.t) })))));
}

function fact(v, k) { return h('div', { class: 'fact' }, h('div', { class: 'v' }, v), h('div', { class: 'k' }, k)); }

// ---------------------------------------------------------------- Spotify
function spotifyStats(body, range) {
  if (!connected('spotify')) {
    body.append(emptyState('Spotify isn’t linked', 'Link Spotify in Accounts to see your top artists and songs there.', h('button', { class: 'btn primary', onclick: () => go('accounts') }, 'Open Accounts')));
    return;
  }
  const map = { '7': 'short_term', '30': 'short_term', '365': 'medium_term', all: 'long_term' };
  const opts = [['30', 'Last 4 weeks'], ['365', 'Last 6 months'], ['all', 'About a year']];
  const r = map[range] || 'short_term';
  const sel = range === '7' ? '30' : range;
  body.append(rangeChips('spotify', sel, opts));
  const slot = h('div', null, loadingLine());
  body.append(slot);
  Promise.all([spotify.top('artists', r, 20), spotify.top('tracks', r, 50), spotify.recent().catch(() => [])]).then(([artists, tracks, recent]) => {
    slot.replaceChildren(
      h('div', { class: 'two-col' },
        block('Top artists on Spotify', rankList(artists.map((a, i) => ({ title: a.name, sub: a.genres.slice(0, 2).join(', '), image: a.image, label: `#${i + 1}`, open: () => go('artist', { name: a.name }) })), { round: true })),
        block('Recently played', rankList(recent.slice(0, 20).map((t) => ({ title: t.title, sub: t.artist, image: t.art, label: fmtAgo(t.playedAt) }))))),
      block('Top songs on Spotify', trackList(tracks, { context: { type: 'spotify-top' } })));
  }).catch((err) => slot.replaceChildren(emptyState("Couldn't load Spotify stats", err.message)));
}

// ---------------------------------------------------------------- Last.fm
function lastfmStats(body, range) {
  const user = state.auth.lastfm.user?.name;
  if (!user) {
    body.append(emptyState('Last.fm isn’t linked', 'Link Last.fm in Accounts to see your all-time scrobbles and top artists, and to scrobble what you play in MusicForge.', h('button', { class: 'btn primary', onclick: () => go('accounts') }, 'Open Accounts')));
    return;
  }
  const periods = { '7': '7day', '30': '1month', '365': '12month', all: 'overall' };
  body.append(rangeChips('lastfm', range));
  const slot = h('div', null, loadingLine());
  body.append(slot);
  Promise.all([lastfm.user(user), lastfm.userTop(user, 'artists', periods[range], 15), lastfm.userTop(user, 'tracks', periods[range], 15), lastfm.recent(user, 20)])
    .then(([u, artists, tracks, recent]) => {
      const pic = (arr) => arr?.find((i) => i.size === 'large')?.['#text'] || null;
      slot.replaceChildren(
        h('div', { class: 'facts' },
          fact(fmtFull(u.playcount), 'scrobbles'),
          fact(fmtFull(u.artist_count || 0), 'artists'),
          fact(fmtFull(u.track_count || 0), 'songs'),
          fact(new Date((+u.registered?.unixtime || +u.registered?.['#text'] || 0) * 1000).getFullYear() || '—', 'scrobbling since')),
        h('div', { class: 'two-col' },
          block('Top artists', rankList(artists.map((a) => ({ title: a.name, image: pic(a.image), label: `${fmtNum(a.playcount)} plays`, value: +a.playcount, open: () => go('artist', { name: a.name }) })), { round: true })),
          block('Top songs', rankList(tracks.map((t) => ({ title: t.name, sub: t.artist?.name, image: pic(t.image), label: `${fmtNum(t.playcount)} plays`, value: +t.playcount }))))),
        block('Recent scrobbles', rankList(recent.map((t) => ({
          title: t.name, sub: t.artist?.['#text'], image: pic(t.image),
          label: t['@attr']?.nowplaying ? 'now' : t.date?.uts ? fmtAgo(+t.date.uts * 1000) : '',
        })))));
    }).catch((err) => slot.replaceChildren(emptyState("Couldn't load Last.fm stats", err.message)));
}

export { engine };
