import { h, icon, iconBtn, fmtTime, img, clear, throttle } from '../util.js';
import { state, on, emit, isLiked, toggleLike, mf, slim, save } from '../state.js';
import { NAMES } from '../services.js';
import { engine } from '../player/engine.js';
import { go } from '../router.js';
import { addToPlaylist, createPlaylist, removeFromPlaylist } from '../playlists.js';

// ---------------------------------------------------------------- toasts
const toastRoot = document.getElementById('toast-root');
export function toast(text, kind = '') {
  const t = h('div', { class: `toast ${kind}`, role: kind === 'error' ? 'alert' : 'status' }, text);
  toastRoot.append(t);
  while (toastRoot.children.length > 3) toastRoot.firstChild.remove();
  setTimeout(() => t.remove(), kind === 'error' ? 6500 : 3200);
}
on('toast', (d) => toast(d.text, d.kind));

// ---------------------------------------------------------------- menus
const menuRoot = document.getElementById('menu-root');
let openMenu = null;
export function closeMenu() { openMenu?.remove(); openMenu = null; }
document.addEventListener('pointerdown', (e) => { if (openMenu && !openMenu.contains(e.target)) closeMenu(); }, true);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });
window.addEventListener('blur', closeMenu);

export function menu(items, x, y) {
  closeMenu();
  const m = h('div', { class: 'menu', role: 'menu' });
  for (const it of items) {
    if (!it) continue;
    if (it === '-') { m.append(h('hr')); continue; }
    if (it.label && !it.run) { m.append(h('div', { class: 'menu-label' }, it.label)); continue; }
    m.append(h('button', { role: 'menuitem', onclick: () => { closeMenu(); it.run(); } }, it.icon ? icon(it.icon, 16) : null, it.text));
  }
  menuRoot.append(m);
  const r = m.getBoundingClientRect();
  m.style.left = `${Math.max(6, Math.min(x, innerWidth - r.width - 8))}px`;
  m.style.top = `${Math.max(6, Math.min(y, innerHeight - r.height - 8))}px`;
  openMenu = m;
  m.querySelector('button')?.focus();
  m.addEventListener('keydown', (e) => {
    const btns = [...m.querySelectorAll('button')];
    const i = btns.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); btns[(i + 1) % btns.length]?.focus(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); btns[(i - 1 + btns.length) % btns.length]?.focus(); }
  });
}

// ---------------------------------------------------------------- modals
const dlg = document.getElementById('modal');
export function modal(build) {
  return new Promise((resolve) => {
    clear(dlg);
    let done = false;
    const close = (v) => { if (done) return; done = true; dlg.close(); resolve(v); };
    dlg.append(build(close));
    dlg.onclose = () => close(undefined);
    dlg.showModal();
    dlg.querySelector('input, [autofocus]')?.focus();
  });
}

export function prompt({ title, text = '', value = '', placeholder = '', ok = 'Save' }) {
  return modal((close) => {
    const input = h('input', { class: 'input', value, placeholder });
    const submit = () => close(input.value.trim() || null);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    return h('div', null,
      h('div', { class: 'modal-body' }, h('h2', null, title), text ? h('p', null, text) : null, input),
      h('div', { class: 'modal-actions' },
        h('button', { class: 'btn ghost', onclick: () => close(null) }, 'Cancel'),
        h('button', { class: 'btn primary', onclick: submit }, ok)));
  });
}

export function confirm({ title, text, ok = 'Delete', danger = true }) {
  return modal((close) => h('div', null,
    h('div', { class: 'modal-body' }, h('h2', null, title), h('p', null, text)),
    h('div', { class: 'modal-actions' },
      h('button', { class: 'btn ghost', onclick: () => close(false) }, 'Cancel'),
      h('button', { class: `btn ${danger ? 'primary' : 'primary'}`, autofocus: true, onclick: () => close(true) }, ok))));
}

export function pick({ title, text, items }) {
  // items: [{ img, t, a, value }]
  return modal((close) => h('div', null,
    h('div', { class: 'modal-body' },
      h('h2', null, title), text ? h('p', null, text) : null,
      h('div', { class: 'pick-list' }, items.map((it) => h('button', { onclick: () => close(it.value) },
        it.img !== undefined ? img(it.img) : null,
        h('div', null, h('div', { class: 't' }, it.t), it.a ? h('div', { class: 'a' }, it.a) : null))))),
    h('div', { class: 'modal-actions' }, h('button', { class: 'btn ghost', onclick: () => close(null) }, 'Cancel'))));
}

// ---------------------------------------------------------------- slider
export function slider({ value = 0, max = 1, onInput, onCommit, format, label }) {
  const fill = h('div', { class: 'fill' });
  const knob = h('div', { class: 'knob' });
  const tip = format ? h('div', { class: 'hover-tip' }) : null;
  const el = h('div', { class: 'slider', role: 'slider', tabindex: 0, 'aria-label': label }, h('div', { class: 'track' }, fill), knob, tip);
  let cur = value; let mx = max || 1; let dragging = false;
  const paint = (v) => {
    const p = mx > 0 ? Math.max(0, Math.min(1, v / mx)) : 0;
    fill.style.transform = `scaleX(${p})`;
    knob.style.left = `${p * 100}%`;
    el.setAttribute('aria-valuenow', String(Math.round(v)));
  };
  const at = (e) => { const r = el.getBoundingClientRect(); return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * mx; };
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    dragging = true;
    el.classList.add('drag');
    el.setPointerCapture(e.pointerId);
    cur = at(e); paint(cur); onInput?.(cur);
  });
  el.addEventListener('pointermove', (e) => {
    if (tip) { const r = el.getBoundingClientRect(); tip.style.left = `${e.clientX - r.left}px`; tip.textContent = format(at(e)); }
    if (!dragging) return;
    cur = at(e); paint(cur); onInput?.(cur);
  });
  const end = () => { if (!dragging) return; dragging = false; el.classList.remove('drag'); onCommit?.(cur); };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  el.addEventListener('keydown', (e) => {
    const step = mx / (e.shiftKey ? 10 : 40);
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') cur = Math.min(mx, cur + step);
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') cur = Math.max(0, cur - step);
    else return;
    e.preventDefault(); e.stopPropagation(); paint(cur); onCommit?.(cur);
  });
  paint(cur);
  return {
    el,
    set(v, newMax) { if (newMax !== undefined) mx = newMax || 1; if (!dragging) { cur = v; paint(v); } },
    get dragging() { return dragging; },
  };
}

// ---------------------------------------------------------------- bits
export function srcBadge(name) {
  if (!name) return null;
  return h('span', { class: `src src-${name}` }, NAMES[name] || name);
}

export function tile({ image, name, sub, round = false, onOpen, onPlay }) {
  const el = h('div', { class: `tile ${round ? 'round' : ''}`, tabindex: 0, role: 'button', onclick: onOpen, onkeydown: (e) => { if (e.key === 'Enter') onOpen?.(); } },
    h('div', { class: 'art' }, img(image, ''), onPlay ? h('button', { class: 'tile-play', title: `Play ${name}`, 'aria-label': `Play ${name}`, onclick: (e) => { e.stopPropagation(); onPlay(); } }, icon('play', 18)) : null),
    h('div', { class: 'nm', title: name }, name),
    sub ? h('div', { class: 'sub' }, sub) : null);
  return el;
}

export function emptyState(title, text, action) {
  return h('div', { class: 'empty-state' }, h('h3', null, title), h('p', null, text), action || null);
}

export const loadingLine = () => h('div', { class: 'loading-line', role: 'progressbar', 'aria-label': 'Loading' });

// ---------------------------------------------------------------- track context menu
export async function addToPlaylistFlow(tracks) {
  const items = [{ t: 'New playlist…', a: '', value: '__new', img: null },
    ...state.playlists.map((p) => ({ t: p.name, a: `${p.tracks.length} songs`, value: p.id, img: p.tracks.find((t) => t.art)?.art || null }))];
  const choice = await pick({ title: tracks.length === 1 ? `Add “${tracks[0].title}” to…` : `Add ${tracks.length} songs to…`, items });
  if (!choice) return;
  if (choice === '__new') {
    const name = await prompt({ title: 'New playlist', placeholder: 'Playlist name', ok: 'Create' });
    if (!name) return;
    const p = createPlaylist(name, tracks);
    toast(`Created “${p.name}”`);
  } else {
    const n = addToPlaylist(choice, tracks);
    const p = state.playlists.find((x) => x.id === choice);
    toast(n ? `Added to “${p.name}”` : `Already in “${p.name}”`);
  }
}

function goLocalAlbum(track) {
  const t = state.library.tracks.find((x) => x.id === track.src.local);
  if (!t) return;
  const artist = t.albumArtist || t.artist || 'Unknown artist';
  go('album', { kind: 'local', key: `${artist}\u0000${t.album || 'Unknown album'}` });
}

export function trackMenu(track, e, ctx = {}) {
  const items = [
    { text: 'Play now', icon: 'play', run: () => (ctx.list ? engine.playList(ctx.list, ctx.index, ctx.context) : engine.playOne(track)) },
    { text: 'Play next', icon: 'queue', run: () => engine.playNext(track) },
    { text: 'Add to queue', icon: 'plus', run: () => engine.enqueue(track) },
    '-',
    { text: 'Add to playlist…', icon: 'library', run: () => addToPlaylistFlow([track]) },
    { text: isLiked(track) ? 'Remove from Liked' : 'Like', icon: isLiked(track) ? 'heartFill' : 'heart', run: () => { const l = toggleLike(track); toast(l ? 'Added to Liked' : 'Removed from Liked'); emit('likes'); } },
    ctx.playlistId ? { text: 'Remove from this playlist', icon: 'trash', run: () => { removeFromPlaylist(ctx.playlistId, [ctx.index]); emit('playlist-changed', ctx.playlistId); } } : null,
    '-',
    track.artist ? { text: `Artist stats: ${track.artist.split(',')[0]}`, icon: 'artist', run: () => go('artist', { name: track.artist.split(',')[0].trim(), dz: track.artistId?.startsWith('dz:') ? track.artistId.slice(3) : null }) } : null,
    { text: 'Watch music video', icon: 'video', run: () => { engine.playVideo(track); go('video'); } },
    track.src?.local && track.album ? { text: `Go to album: ${track.album}`, icon: 'disc', run: () => goLocalAlbum(track) } : null,
    track.url ? { text: `Open in ${NAMES[track.origin] || 'browser'}`, icon: 'external', run: () => mf.invoke('shell:open', track.url) } : null,
    track.url ? { text: 'Copy link', icon: 'copy', run: () => navigator.clipboard.writeText(track.url).then(() => toast('Link copied')) } : null,
    track.src?.local ? { text: 'Show in folder', icon: 'folder', run: () => mf.invoke('library:reveal', track.src.local) } : null,
  ];
  menu(items, e.clientX, e.clientY);
}

// ---------------------------------------------------------------- track list (virtualised when long)
const ROW_H = 54;

export function trackList(tracks, opts = {}) {
  const { showAlbum = true, context = null, playlistId = null, onPlay, numbers = true, reorder = null } = opts;
  const scroller = opts.scroller || document.getElementById('main');
  const root = h('div', { class: `tl ${showAlbum ? '' : 'no-album'}`, role: 'grid', 'aria-rowcount': tracks.length });
  const head = h('div', { class: 'tl-head', role: 'row' },
    h('div', { style: { textAlign: 'center' } }, '#'),
    h('div', null, 'Title'),
    h('div', { class: 'c-album' }, 'Album'),
    h('div', null, 'Source'),
    h('div', { style: { textAlign: 'right' } }, icon('disc', 14)),
    h('div'));
  root.append(head);

  let selected = -1;
  const play = (i) => (onPlay ? onPlay(i) : engine.playList(tracks, i, context));

  const row = (t, i) => {
    const liked = isLiked(t);
    const cur = engine.track?.key === t.key;
    const r = h('div', {
      class: `tl-row ${cur ? 'current' : ''} ${i === selected ? 'sel' : ''}`, role: 'row', tabindex: -1, dataset: { i },
      ondblclick: () => play(i),
      onclick: (e) => { if (e.target.closest('button')) return; selected = i; root.querySelectorAll('.tl-row.sel').forEach((x) => x.classList.remove('sel')); r.classList.add('sel'); r.focus({ preventScroll: true }); },
      oncontextmenu: (e) => { e.preventDefault(); trackMenu(t, e, { list: tracks, index: i, context, playlistId }); },
      onkeydown: (e) => { if (e.key === 'Enter') play(i); },
      draggable: true,
      ondragstart: (e) => {
        e.dataTransfer.effectAllowed = 'copyMove';
        e.dataTransfer.setData('application/x-mf-tracks', JSON.stringify([slim(t)]));
        e.dataTransfer.setData('text/plain', t.url || `${t.artist} - ${t.title}`);
        if (reorder) e.dataTransfer.setData('application/x-mf-index', String(i));
        r.classList.add('dragging');
        document.body.classList.add('dragging-tracks');
      },
      ondragend: () => { r.classList.remove('dragging'); document.body.classList.remove('dragging-tracks'); },
      ondragover: reorder ? (e) => { if (e.dataTransfer.types.includes('application/x-mf-index')) { e.preventDefault(); r.classList.add('drop-before'); } } : null,
      ondragleave: reorder ? () => r.classList.remove('drop-before') : null,
      ondrop: reorder ? (e) => {
        r.classList.remove('drop-before');
        const from = +e.dataTransfer.getData('application/x-mf-index');
        if (Number.isNaN(from)) return;
        e.preventDefault();
        reorder(from, from < i ? i - 1 : i);
      } : null,
    },
    h('div', { class: 'c-n' }, numbers ? h('span', { class: 'num' }, i + 1) : h('span', { class: 'num' }, ''), h('button', { title: 'Play', 'aria-label': `Play ${t.title}`, onclick: () => play(i) }, icon('play', 14))),
    h('div', { class: 'c-title' }, img(t.art), h('div', { class: 'tt' }, h('div', { class: 't', title: t.title }, t.title), h('div', { class: 'a' }, t.artist))),
    h('div', { class: 'c-album', title: t.album }, t.album || ''),
    h('div', null, srcBadge(t.origin)),
    h('div', { class: 'c-dur' }, t.duration ? fmtTime(t.duration) : '—'),
    h('div', { class: 'c-act' },
      iconBtn(liked ? 'heartFill' : 'heart', liked ? 'Remove from Liked' : 'Like', (e) => {
        const now = toggleLike(t);
        const b = e.currentTarget;
        b.replaceChildren(icon(now ? 'heartFill' : 'heart', 18));
        b.classList.toggle('liked', now);
        emit('likes');
      }, { class: `small ${liked ? 'liked' : ''}`, size: 18 }),
      iconBtn('more', 'More', (e) => trackMenu(t, e, { list: tracks, index: i, context, playlistId }), { class: 'small', size: 18 })));
    return r;
  };

  const virtual = tracks.length > 150;
  let body;
  if (!virtual) {
    body = h('div', null, tracks.map(row));
    root.append(body);
  } else {
    body = h('div', { class: 'tl-virtual', style: { height: `${tracks.length * ROW_H}px` } });
    root.append(body);
    let first = -1; let last = -1;
    const render = () => {
      if (!body.isConnected) return;
      const top = body.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
      const start = Math.max(0, Math.floor(-top / ROW_H) - 8);
      const end = Math.min(tracks.length, Math.ceil((-top + scroller.clientHeight) / ROW_H) + 8);
      if (start === first && end === last) return;
      first = start; last = end;
      const frag = document.createDocumentFragment();
      for (let i = start; i < end; i++) {
        const r = row(tracks[i], i);
        r.style.top = `${i * ROW_H}px`;
        frag.append(r);
      }
      body.replaceChildren(frag);
    };
    const onScroll = throttle(render, 16);
    scroller.addEventListener('scroll', onScroll, { passive: true });
    const ro = new ResizeObserver(() => { first = -1; render(); });
    ro.observe(scroller);
    requestAnimationFrame(render);
    root._cleanup = () => { scroller.removeEventListener('scroll', onScroll); ro.disconnect(); };
    root._rerender = () => { first = -1; render(); };
  }

  const off = on('track', () => {
    if (!root.isConnected) { off(); root._cleanup?.(); return; }
    const key = engine.track?.key;
    root.querySelectorAll('.tl-row').forEach((r) => r.classList.toggle('current', tracks[+r.dataset.i]?.key === key));
  });

  root.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    selected = Math.max(0, Math.min(tracks.length - 1, selected + (e.key === 'ArrowDown' ? 1 : -1)));
    if (virtual) {
      const y = body.offsetTop + selected * ROW_H;
      if (y < scroller.scrollTop + 40) scroller.scrollTop = y - 40;
      else if (y > scroller.scrollTop + scroller.clientHeight - ROW_H * 2) scroller.scrollTop = y - scroller.clientHeight + ROW_H * 2;
      root._rerender();
    }
    root.querySelectorAll('.tl-row').forEach((r) => r.classList.toggle('sel', +r.dataset.i === selected));
    root.querySelector(`.tl-row[data-i="${selected}"]`)?.focus({ preventScroll: virtual });
  });
  return root;
}

// ---------------------------------------------------------------- song grid
// Tiles render in batches as you scroll, so big libraries stay quick.
export function trackGrid(tracks, opts = {}) {
  const { context = null, onPlay, video = false, batch = 96 } = opts;
  const scroller = opts.scroller || document.getElementById('main');
  const grid = h('div', { class: `tiles song-grid ${video ? 'video' : ''}` });
  const play = (i) => (onPlay ? onPlay(i) : engine.playList(tracks, i, context));
  const tileFor = (t, i) => {
    const cur = engine.track?.key === t.key;
    const el = h('div', {
      class: `tile song-tile ${cur ? 'current' : ''}`, tabindex: 0, role: 'button', dataset: { i }, title: `${t.title} — ${t.artist}`,
      onclick: (e) => { if (!e.target.closest('.st-more')) play(i); },
      onkeydown: (e) => { if (e.key === 'Enter') play(i); },
      oncontextmenu: (e) => { e.preventDefault(); trackMenu(t, e, { list: tracks, index: i, context }); },
      draggable: true,
      ondragstart: (e) => {
        e.dataTransfer.effectAllowed = 'copy';
        e.dataTransfer.setData('application/x-mf-tracks', JSON.stringify([slim(t)]));
        e.dataTransfer.setData('text/plain', t.url || `${t.artist} - ${t.title}`);
        document.body.classList.add('dragging-tracks');
      },
      ondragend: () => document.body.classList.remove('dragging-tracks'),
    },
    h('div', { class: 'art' }, img(video ? (t.artLarge || t.art) : t.art, ''),
      h('span', { class: 'tile-play', 'aria-hidden': 'true' }, icon(cur ? 'wave' : 'play', 18)),
      h('button', { class: 'st-more', title: 'More', 'aria-label': `More for ${t.title}`, onclick: (e) => { e.stopPropagation(); trackMenu(t, e, { list: tracks, index: i, context }); } }, icon('more', 16)),
      t.duration ? h('span', { class: 'st-dur' }, fmtTime(t.duration)) : null),
    h('div', { class: 'nm' }, t.title),
    h('div', { class: 'sub' }, h('span', { class: `src src-${t.origin}`, title: NAMES[t.origin] || t.origin }), t.artist));
    return el;
  };
  let shown = 0;
  const sentinel = h('div', { class: 'grid-sentinel' });
  const more = () => {
    const frag = document.createDocumentFragment();
    const end = Math.min(tracks.length, shown + batch);
    for (let i = shown; i < end; i++) frag.append(tileFor(tracks[i], i));
    shown = end;
    grid.append(frag);
    if (shown >= tracks.length) { io.disconnect(); sentinel.remove(); }
  };
  const io = new IntersectionObserver((e) => { if (e[0].isIntersecting) more(); }, { root: scroller, rootMargin: '600px' });
  more();
  const wrap = h('div', null, grid, shown < tracks.length ? sentinel : null);
  if (shown < tracks.length) requestAnimationFrame(() => io.observe(sentinel));
  const off = on('track', () => {
    if (!wrap.isConnected) { off(); io.disconnect(); return; }
    const key = engine.track?.key;
    grid.querySelectorAll('.song-tile').forEach((el) => {
      const isCur = tracks[+el.dataset.i]?.key === key;
      if (isCur === el.classList.contains('current')) return;
      el.classList.toggle('current', isCur);
      el.querySelector('.tile-play').replaceChildren(icon(isCur ? 'wave' : 'play', 18));
    });
  });
  wrap._cleanup = () => { io.disconnect(); off(); };
  return wrap;
}

// Grid / list switch. The choice is remembered per screen ("search", "library", "playlist"…).
export function viewMode(area, fallback = 'list') { return state.settings.views?.[area] || fallback; }
export function viewToggle(area, fallback, onChange) {
  const cur = viewMode(area, fallback);
  const set = (mode) => {
    state.settings.views = { ...(state.settings.views || {}), [area]: mode };
    save('settings');
    el.querySelectorAll('button').forEach((b) => { const on2 = b.dataset.mode === mode; b.classList.toggle('on', on2); b.setAttribute('aria-pressed', String(on2)); });
    onChange(mode);
  };
  const el = h('div', { class: 'seg view-toggle', role: 'group', 'aria-label': 'Layout' },
    h('button', { class: cur === 'grid' ? 'on' : '', dataset: { mode: 'grid' }, 'aria-pressed': String(cur === 'grid'), title: 'Grid', onclick: () => set('grid') }, icon('grid', 16)),
    h('button', { class: cur === 'list' ? 'on' : '', dataset: { mode: 'list' }, 'aria-pressed': String(cur === 'list'), title: 'List', onclick: () => set('list') }, icon('lyrics', 16)));
  return el;
}

// Renders songs as a grid or a list depending on the remembered mode for `area`.
export function trackCollection(tracks, opts = {}, area = 'library', fallback = 'list') {
  return viewMode(area, fallback) === 'grid' ? trackGrid(tracks, opts) : trackList(tracks, opts);
}

// Big "Top result" card for search.
export function topCard({ image, round = false, name, meta, onOpen, onPlay }) {
  return h('div', { class: 'top-card', tabindex: 0, role: 'button', onclick: onOpen, onkeydown: (e) => { if (e.key === 'Enter') onOpen?.(); } },
    img(image, '', round ? 'round' : ''),
    h('div', { class: 'tc-name' }, name),
    h('div', { class: 'tc-meta' }, meta),
    onPlay ? h('button', { class: 'tile-play tc-play', title: `Play ${name}`, 'aria-label': `Play ${name}`, onclick: (e) => { e.stopPropagation(); onPlay(); } }, icon('play', 20)) : null);
}
