// The stage: big artwork (or the video), stamped title, synced lyrics, full-width visualizer.
import { h, icon, iconBtn, img } from '../util.js';
import { state, on, save, mf } from '../state.js';
import { engine } from '../player/engine.js';
import { go } from '../router.js';
import { srcBadge, trackMenu, toast } from '../ui/components.js';
import { LyricsView, nudgeOffset } from '../lyrics.js';
import { Visualizer, hasSignal, startSystemCapture, systemCaptureActive } from '../visualizer.js';
import { attachSlot, embedKind } from '../ui/embed.js';

const STYLES = [['bars', 'Bars'], ['mirror', 'Mirror'], ['wave', 'Wave'], ['radial', 'Radial']];

export function render({ vis = false } = {}) {
  const backdropImg = img(null);
  const backdrop = h('div', { class: 'np-backdrop' }, backdropImg);
  const media = h('div', { class: 'np-media', dataset: { embedAny: '' } });
  const mediaImg = img(null);
  media.append(mediaImg);
  const title = h('h1', { class: 'np-title' });
  const artist = h('div', { class: 'np-artist' });
  const sub = h('div', { class: 'np-sub' });
  const left = h('div', { class: 'np-left' }, media, h('div', { style: { minWidth: 0 } }, title, artist, sub));

  const lyricsBox = h('div');
  const offsetLabel = h('span', null, offsetText());
  const tools = h('div', { class: 'np-tools' },
    h('span', null, 'Lyrics timing'),
    iconBtn('back', 'Lyrics earlier by 0.5 s', () => { nudgeOffset(-0.5); offsetLabel.textContent = offsetText(); }, { class: 'small', size: 14 }),
    offsetLabel,
    iconBtn('fwd', 'Lyrics later by 0.5 s', () => { nudgeOffset(0.5); offsetLabel.textContent = offsetText(); }, { class: 'small', size: 14 }));
  const right = h('div', { class: 'np-right' }, tools, lyricsBox);
  const lyrics = new LyricsView(lyricsBox, { big: true });

  const canvas = h('canvas', { 'aria-label': 'Audio visualizer' });
  const hint = h('div', { class: 'hint' });
  const visWrap = h('div', { class: 'np-vis' }, canvas, hint);
  const styleChips = h('div', { class: 'row' }, STYLES.map(([id, text]) => h('button', {
    class: `chip ${state.settings.vis.style === id ? 'on' : ''}`,
    onclick: (e) => {
      state.settings.vis.style = id; save('settings');
      styleChips.querySelectorAll('.chip').forEach((c) => c.classList.toggle('on', c === e.currentTarget));
    },
  }, text)));
  const miniTitle = h('div', { class: 'np-mini' });
  const visBar = h('div', { class: 'np-visbar' },
    vis ? miniTitle : null, h('span', { class: 'spacer' }), styleChips,
    iconBtn(vis ? 'lyrics' : 'wave', vis ? 'Show artwork and lyrics' : 'Visualizer only (V)', () => go('nowplaying', { vis: !vis }, { replace: true })),
    iconBtn('fullscreen', 'Full screen (F11)', () => mf.invoke('win:fullscreen')));

  const np = h('div', { class: `np ${vis ? 'vis-only' : ''}` }, backdrop);
  if (vis) np.append(visBar, visWrap);
  else np.append(left, right, visWrap, visBar);
  if (!vis) visBar.style.gridColumn = '1 / -1';

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

  const paint = () => {
    const t = engine.track;
    title.textContent = t ? t.title : 'Nothing playing';
    miniTitle.replaceChildren(h('div', { class: 't' }, t ? `${t.title} — ${t.artist}` : ''));
    artist.replaceChildren(t?.artist ? h('button', { onclick: () => go('artist', { name: t.artist.split(',')[0].trim() }) }, t.artist) : '');
    sub.replaceChildren(
      engine.source ? srcBadge(engine.source) : null,
      t?.album ? h('span', null, t.album) : null,
      t ? h('button', { class: 'link-btn', onclick: (e) => trackMenu(t, e) }, 'More…') : h('button', { class: 'btn small ghost', onclick: () => go('search') }, 'Find something to play'));
    const art = t?.artLarge || t?.art;
    if (art) { mediaImg.src = art; backdropImg.src = t.art || art; } else { mediaImg.removeAttribute('src'); backdropImg.removeAttribute('src'); }
    const isVideo = embedKind() === 'youtube';
    media.classList.toggle('video', isVideo);
    attachSlot(embedKind() && !vis ? media : null);
    if (!vis) lyrics.load(t);
    paintHint();
  };
  paint();
  const offs = [
    on('track', paint),
    on('state', () => { v.kick(); paintHint(); }),
    on('capture', () => { paintHint(); v.kick(); }),
  ];
  return {
    el: np,
    mounted: () => { np.parentElement.style.overflow = 'hidden'; },
    cleanup: () => {
      offs.forEach((f) => f());
      v.destroy();
      lyrics.stop();
      attachSlot(null);
      document.getElementById('main').style.overflow = '';
    },
  };
}

function offsetText() {
  const o = state.settings.lyricsOffset || 0;
  return o === 0 ? '±0.0 s' : `${o > 0 ? '+' : ''}${o.toFixed(1)} s`;
}

export { systemCaptureActive, icon };
