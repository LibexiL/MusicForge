import { h, icon } from '../util.js';
import { on, youtubeSearchable, connected } from '../state.js';
import { engine } from '../player/engine.js';
import { go } from '../router.js';
import { srcBadge } from '../ui/components.js';
import { attachSlot, embedKind } from '../ui/embed.js';

export function render() {
  const stageMsg = h('div', { class: 'msg' });
  const stage = h('div', { class: 'video-stage' }, stageMsg);
  const title = h('h1', { class: 't-display', style: { fontSize: '26px' } });
  const sub = h('p', { class: 't-sub' });
  const actions = h('div', { class: 'row', style: { marginTop: '14px' } });
  const view = h('div', { class: 'video-view' }, stage, h('div', { style: { marginTop: '20px' } }, title, sub, actions));

  const paint = () => {
    const t = engine.track;
    const yt = embedKind() === 'youtube';
    attachSlot(yt ? stage : null);
    title.textContent = t ? t.title : 'Music videos';
    sub.replaceChildren(t ? `${t.artist}` : 'Play a song, then open this screen to watch its video.', engine.source ? ' · ' : '', engine.source ? srcBadge(engine.source) : '');
    actions.replaceChildren();
    if (!t) { stageMsg.textContent = 'Nothing playing.'; return; }
    if (!yt) {
      stageMsg.replaceChildren(
        h('p', null, youtubeSearchable() || t.src.youtube ? 'Switch this song to its music video. Playback continues from the same spot.' : 'Finding videos needs a YouTube API key. Add one in Accounts; it’s free.'),
        youtubeSearchable() || t.src.youtube
          ? h('button', { class: 'btn primary', onclick: () => engine.switchTo('youtube', { video: true }) }, icon('video', 16), 'Watch the video')
          : h('button', { class: 'btn primary', onclick: () => go('accounts') }, 'Open Accounts'));
    } else if (t.origin !== 'youtube' || t.src.spotify || t.src.local) {
      const back = t.src.local ? 'local' : (t.src.spotify && connected('spotify')) ? 'spotify' : null;
      if (back) actions.append(h('button', { class: 'btn ghost', onclick: () => engine.switchTo(back) }, icon('note', 16), 'Back to audio only'));
    }
  };
  paint();
  const offs = [on('track', paint)];
  return { el: view, cleanup: () => { offs.forEach((f) => f()); attachSlot(null); } };
}
