// The stage: big artwork (or the video), stamped title, synced lyrics, full-width visualizer.
import { h, icon, iconBtn, img, setImg } from '../util.js';
import { state, on, save, mf } from '../state.js';
import { engine } from '../player/engine.js';
import { go } from '../router.js';
import { srcBadge, trackMenu, toast } from '../ui/components.js';
import { LyricsView, nudgeOffset, offsetLabel, pickLyrics, copyLyrics } from '../lyrics.js';
import { Visualizer, hasSignal, startSystemCapture } from '../visualizer.js';
import { attachSlot, embedKind } from '../ui/embed.js';

const STYLES = [['bars', 'Bars'], ['mirror', 'Mirror'], ['wave', 'Wave'], ['radial', 'Radial']];

export function render({ vis = false } = {}) {
  const backdropImg = img(null);
  const backdrop = h('div', { class: 'np-backdrop' }, backdropImg);
  const media = h('div', { class: 'np-media', dataset: { embedAny: '' }, title: 'Visualizer only (V)', ondblclick: () => go('nowplaying', { vis: true }, { replace: true }) });
  const mediaImg = img(null);
  media.append(mediaImg);
  const title = h('h1', { class: 'np-title' });
  const artist = h('div', { class: 'np-artist' });
  const sub = h('div', { class: 'np-sub' });
  const next = h('div', { class: 'np-next' });
  const left = h('div', { class: 'np-left' }, media, h('div', { style: { minWidth: 0 } }, title, artist, sub, next));

  // Lyrics column with quiet tools that brighten on hover.
  const lyricsBox = h('div');
  const offsetText = h('span', { class: 'np-offset', title: 'Lyrics timing. [ and ] adjust it too.' }, offsetLabel());
  const tools = h('div', { class: 'np-tools' },
    iconBtn('back', 'Show lyrics earlier ([)', () => nudgeOffset(-0.25), { class: 'small', size: 14 }),
    offsetText,
    iconBtn('fwd', 'Show lyrics later (])', () => nudgeOffset(0.25), { class: 'small', size: 14 }),
    h('span', { class: 'np-tools-sep' }),
    h('button', { class: 'link-btn', onclick: () => engine.track && pickLyrics(engine.track).then((ok) => ok && lyrics.load(engine.track, true)) }, 'Wrong lyrics?'),
    iconBtn('copy', 'Copy lyrics', () => engine.track && copyLyrics(engine.track), { class: 'small', size: 15 }));
  const right = h('div', { class: 'np-right' }, tools, lyricsBox);
  const lyrics = new LyricsView(lyricsBox, { big: true });

  // Visualizer with an overlay toolbar.
  const canvas = h('canvas', { 'aria-label': 'Audio visualizer' });
  const hint = h('div', { class: 'hint' });
  const seg = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': 'Visualizer style' }, STYLES.map(([id, text]) => h('button', {
    role: 'radio', 'aria-checked': String(state.settings.vis.style === id), class: state.settings.vis.style === id ? 'on' : '',
    onclick: (e) => {
      state.settings.vis.style = id; save('settings');
      seg.querySelectorAll('button').forEach((b) => { const onB = b === e.currentTarget; b.classList.toggle('on', onB); b.setAttribute('aria-checked', String(onB)); });
    },
  }, text)));
  const visTools = h('div', { class: 'np-vis-tools' }, seg,
    iconBtn(vis ? 'lyrics' : 'expand', vis ? 'Show artwork and lyrics (V)' : 'Visualizer only (V)', () => go('nowplaying', { vis: !vis }, { replace: true }), { size: 17 }),
    iconBtn('fullscreen', 'Full screen (F11)', () => mf.invoke('win:fullscreen'), { size: 17 }));
  const visWrap = h('div', { class: 'np-vis' }, canvas, hint, vis ? null : visTools);

  const miniTitle = h('div', { class: 'np-mini' });
  const np = h('div', { class: `np ${vis ? 'vis-only' : ''}` }, backdrop);
  if (vis) np.append(h('div', { class: 'np-visbar' }, miniTitle, h('span', { class: 'spacer' }), visTools), visWrap);
  else np.append(left, right, visWrap);

  const v = new Visualizer(canvas, {});
  v.start();

  const paintHint = () => {
    hint.replaceChildren();
    if (!engine.track || hasSignal()) return;
    if (engine.source === 'local' || engine.source === 'preview') return;
    hint.append(`The visualizer can't hear ${engine.source === 'spotify' ? 'Spotify' : 'embedded players'} directly.`,
      h('button', { class: 'btn small ghost', onclick: async () => {
        try {
          if (state.settings.vis.source === 'player') { state.settings.vis.source = 'auto'; save('settings'); }
          await startSystemCapture(); paintHint(); v.kick();
          toast('Listening to system audio');
        } catch (err) { toast(err.message, 'error'); }
      } }, 'Use system audio'));
  };

  const paintNext = () => {
    const n = engine.queue[engine.index + 1] || (engine.repeat === 'all' ? engine.queue[0] : null);
    next.replaceChildren(n && engine.queue.length > 1 ? h('button', { onclick: () => engine.next(), title: 'Skip to it' }, h('span', { class: 'faint' }, 'Up next '), `${n.title} · ${n.artist}`) : '');
  };

  const paint = () => {
    const t = engine.track;
    title.textContent = t ? t.title : 'Nothing playing';
    title.title = t?.title || '';
    miniTitle.replaceChildren(h('div', { class: 't' }, t ? `${t.title} — ${t.artist}` : ''));
    artist.replaceChildren(t?.artist ? h('button', { onclick: () => go('artist', { name: t.artist.split(',')[0].trim() }) }, t.artist) : '');
    sub.replaceChildren(
      engine.source ? srcBadge(engine.source) : null,
      t?.album ? h('span', null, t.album) : null,
      t ? h('button', { class: 'link-btn', onclick: (e) => trackMenu(t, e) }, 'More…') : h('button', { class: 'btn small ghost', onclick: () => go('search') }, 'Find something to play'));
    const art = t?.artLarge || t?.art;
    setImg(mediaImg, art);
    setImg(backdropImg, t?.art || art);
    media.classList.toggle('video', embedKind() === 'youtube');
    attachSlot(embedKind() && !vis ? media : null);
    if (!vis) lyrics.load(t);
    paintHint();
    paintNext();
  };
  paint();
  const offs = [
    on('track', paint),
    on('queue', paintNext),
    on('state', () => { v.kick(); paintHint(); }),
    on('capture', () => { paintHint(); v.kick(); }),
    on('lyrics-offset', () => { offsetText.textContent = offsetLabel(); }),
  ];
  return {
    el: np,
    mounted: () => { np.parentElement.style.overflow = 'hidden'; },
    cleanup: () => {
      offs.forEach((f) => f());
      v.destroy();
      lyrics.destroy();
      attachSlot(null);
      document.getElementById('main').style.overflow = '';
    },
  };
}

export { icon };
