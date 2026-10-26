// The unified player: one queue, many sources. For each song it walks the user's source
// priority (Settings → Playback), resolving a match on other services when needed
// (e.g. a Deezer chart song → Spotify or YouTube), and falls through on failure.
import { state, save, emit, connected, youtubeSearchable, slim, mediaUrl, proxyUrl } from '../state.js';
import { spotify, youtube, deezer, lastfm, NAMES } from '../services.js';
import { AudioAdapter, SpotifyAdapter, YouTubeAdapter, SoundCloudAdapter } from './adapters.js';
import { shuffleArray } from '../util.js';
import { setOutputDevice } from './audio.js';

const SOURCE_ADAPTER = { local: 'audio', preview: 'audio', spotify: 'spotify', youtube: 'youtube', soundcloud: 'soundcloud' };

class Engine {
  constructor() {
    this.adapters = { audio: new AudioAdapter(), spotify: new SpotifyAdapter(), youtube: new YouTubeAdapter(), soundcloud: new SoundCloudAdapter() };
    this.queue = [];
    this.unshuffled = null;
    this.index = -1;
    this.shuffle = false;
    this.repeat = 'off';
    this.track = null;
    this.cur = null;
    this.source = null;
    this.state = 'idle';
    this.token = 0;
    this.pending = 0; // restored position to start from on first play
    this.fails = 0;
    this.listen = null;
    this.lastTick = performance.now();
    this.tickN = 0;
    setInterval(() => this.tick(), 250);
    this.setupMediaSession();
  }

  // -------- queue --------
  playList(tracks, startIndex = 0, context = null) {
    if (!tracks?.length) return;
    this.queue = tracks.slice();
    this.context = context;
    this.unshuffled = null;
    this.index = Math.max(0, Math.min(startIndex, tracks.length - 1));
    if (this.shuffle) this.applyShuffle();
    this.fails = 0;
    this.emitQueue();
    return this.start(this.queue[this.index]);
  }
  playOne(track) { return this.playList([track], 0); }
  enqueue(tracks) {
    tracks = [].concat(tracks);
    if (!this.queue.length) return this.playList(tracks, 0);
    this.queue.push(...tracks);
    this.unshuffled?.push(...tracks);
    this.emitQueue();
    emit('toast', { text: tracks.length === 1 ? `Added “${tracks[0].title}” to the queue` : `Added ${tracks.length} songs to the queue` });
  }
  playNext(tracks) {
    tracks = [].concat(tracks);
    if (!this.queue.length) return this.playList(tracks, 0);
    this.queue.splice(this.index + 1, 0, ...tracks);
    this.emitQueue();
    emit('toast', { text: tracks.length === 1 ? `“${tracks[0].title}” plays next` : `${tracks.length} songs play next` });
  }
  jump(i) {
    if (i < 0 || i >= this.queue.length) return;
    this.index = i;
    this.fails = 0;
    this.emitQueue();
    this.start(this.queue[i]);
  }
  removeAt(i) {
    if (i === this.index) return;
    const [t] = this.queue.splice(i, 1);
    if (i < this.index) this.index--;
    if (this.unshuffled) this.unshuffled = this.unshuffled.filter((x) => x !== t);
    this.emitQueue();
  }
  move(from, to) {
    if (from === to) return;
    const [t] = this.queue.splice(from, 1);
    this.queue.splice(to, 0, t);
    if (this.index === from) this.index = to;
    else if (from < this.index && to >= this.index) this.index--;
    else if (from > this.index && to <= this.index) this.index++;
    this.emitQueue();
  }
  clearUpcoming() {
    this.queue = this.queue.slice(0, this.index + 1);
    this.unshuffled = null;
    this.emitQueue();
  }
  applyShuffle() {
    this.unshuffled = this.queue.slice();
    const cur = this.queue[this.index];
    const rest = this.queue.filter((_, i) => i !== this.index);
    this.queue = [cur, ...shuffleArray(rest)];
    this.index = 0;
  }
  toggleShuffle() {
    this.shuffle = !this.shuffle;
    if (this.queue.length) {
      if (this.shuffle) this.applyShuffle();
      else if (this.unshuffled) {
        const cur = this.queue[this.index];
        this.queue = this.unshuffled;
        this.unshuffled = null;
        this.index = Math.max(0, this.queue.indexOf(cur));
      }
    }
    this.emitQueue();
  }
  cycleRepeat() {
    this.repeat = this.repeat === 'off' ? 'all' : this.repeat === 'all' ? 'one' : 'off';
    this.emitQueue();
  }
  emitQueue() {
    emit('queue', this);
    this.persist();
  }
  persist() {
    state.queue = {
      tracks: this.queue.slice(Math.max(0, this.index - 50), this.index + 500).map(slim),
      index: Math.min(this.index, 50),
      pos: Math.floor(this.time()),
      shuffle: this.shuffle,
      repeat: this.repeat,
    };
    save('queue');
  }
  restore() {
    const q = state.queue;
    if (!q?.tracks?.length) return;
    this.queue = q.tracks;
    this.index = Math.min(q.index || 0, q.tracks.length - 1);
    this.shuffle = !!q.shuffle;
    this.repeat = q.repeat || 'off';
    this.track = this.queue[this.index];
    this.pending = q.pos || 0;
    this.state = 'paused';
    emit('track', this);
    emit('queue', this);
    emit('state', this);
  }

  // -------- source selection --------
  mergedSrc(track) { return { ...track.src, ...(state.resolve[track.key] || {}) }; }

  async valueFor(track, name, allowResolve) {
    const src = this.mergedSrc(track);
    switch (name) {
      case 'local': return src.local ? mediaUrl(src.local) : null;
      case 'soundcloud': return src.soundcloud || null;
      case 'preview':
        if (src.preview) return proxyUrl(src.preview);
        if (!allowResolve) return null;
        { const p = await deezer.findPreview(track).catch(() => null); if (p) this.remember(track, { preview: p }); return p ? proxyUrl(p) : null; }
      case 'spotify':
        if (!connected('spotify')) return null;
        if (src.spotify) return src.spotify;
        if (!allowResolve) return null;
        { const uri = await spotify.findMatch(track).catch(() => null); if (uri) this.remember(track, { spotify: uri }); return uri; }
      case 'youtube':
        if (src.youtube) return [src.youtube];
        if (!allowResolve || !state.settings.resolveWithYouTube || !youtubeSearchable()) return null;
        { const ids = await youtube.candidates(track).catch(() => []); return ids.length ? ids : null; }
      default: return null;
    }
  }

  remember(track, patch) {
    if (track.origin === 'local') return;
    state.resolve[track.key] = { ...(state.resolve[track.key] || {}), ...patch };
    const keys = Object.keys(state.resolve);
    if (keys.length > 5000) for (const k of keys.slice(0, keys.length - 5000)) delete state.resolve[k];
    save('resolve');
  }

  // -------- playback --------
  async start(track, startAt = 0, only = null) {
    const token = ++this.token;
    this.finishListen();
    this.stopCurrent();
    this.track = track;
    this.source = null;
    this.pending = 0;
    this.setState('loading');
    emit('track', this);

    const order = only ? [only] : state.settings.sourceOrder;
    let lastErr = null;
    for (const name of order) {
      let value;
      try { value = await this.valueFor(track, name, true); } catch (err) { lastErr = err; }
      if (token !== this.token) return;
      if (!value) continue;
      const adapter = this.adapters[SOURCE_ADAPTER[name]];
      adapter.h = this.handlers(token, adapter);
      try {
        await adapter.load(track, value, startAt);
        if (token !== this.token) return;
        this.cur = adapter;
        this.source = name;
        adapter.setVolume(state.settings.muted ? 0 : state.settings.volume);
        if (name === 'youtube' && !this.mergedSrc(track).youtube) this.remember(track, { youtube: adapter.currentId() });
        this.beginListen();
        this.fails = 0;
        emit('track', this);
        this.updateMediaSession();
        return;
      } catch (err) {
        adapter.h = null;
        try { adapter.stop(); } catch { /* ignore */ }
        lastErr = err;
        if (token !== this.token) return;
      }
    }
    if (token !== this.token) return;
    this.setState('error');
    this.fails++;
    const hint = lastErr?.message || noSourceHint(track);
    emit('toast', { text: `Can't play “${track.title}”. ${hint}`, kind: 'error' });
    if (this.fails < 3 && this.index < this.queue.length - 1 && !only) setTimeout(() => token === this.token && this.next(true), 1200);
  }

  handlers(token, adapter) {
    const live = () => token === this.token && this.cur === adapter;
    return {
      playing: (p) => { if (token === this.token) this.setState(p ? 'playing' : 'paused'); },
      buffering: () => { if (live() && this.state !== 'paused') this.setState('loading'); },
      ended: () => { if (live()) this.onEnded(); },
      error: (err) => {
        if (token !== this.token) return;
        // Fall through to the next source at the same position.
        const order = state.settings.sourceOrder;
        const i = order.indexOf(this.source);
        const at = this.time();
        emit('toast', { text: `${NAMES[this.source] || 'Source'}: ${err.message}`, kind: 'error' });
        this.tryFrom(order.slice(i + 1), at);
      },
    };
  }

  async tryFrom(names, at) {
    const track = this.track;
    for (const name of names) {
      const value = await this.valueFor(track, name, true).catch(() => null);
      if (value) return this.start(track, at, name);
    }
    this.stopCurrent();
    this.setState('error');
  }

  stopCurrent() {
    if (!this.cur) return;
    this.cur.h = null;
    try { this.cur.stop(); } catch { /* ignore */ }
    this.cur = null;
  }

  onEnded() {
    if (this.repeat === 'one') { this.seek(0); this.cur?.play(); return; }
    this.next(true);
  }

  toggle() {
    if (this.state === 'playing') return this.pause();
    return this.play();
  }
  play() {
    if (!this.track) {
      if (this.queue.length) return this.jump(Math.max(0, this.index));
      return;
    }
    if (!this.cur) return this.start(this.track, this.pending || 0);
    this.cur.play();
  }
  pause() { this.cur?.pause(); if (!this.cur) this.setState('paused'); }
  next(auto = false) {
    if (!this.queue.length) return;
    if (this.index < this.queue.length - 1) this.index++;
    else if (this.repeat === 'all') this.index = 0;
    else {
      if (auto) { this.finishListen(); this.stopCurrent(); this.pending = 0; this.setState('paused'); emit('track', this); }
      return;
    }
    this.emitQueue();
    this.start(this.queue[this.index]);
  }
  prev() {
    if (this.time() > 3 || this.index <= 0) return this.seek(0);
    this.index--;
    this.emitQueue();
    this.start(this.queue[this.index]);
  }
  seek(sec) {
    if (!this.cur) { this.pending = Math.max(0, sec); emit('time', this); return; }
    this.cur.seek(Math.max(0, sec));
    emit('time', this);
  }
  time() { return this.cur ? this.cur.time() : this.pending || 0; }
  duration() { return this.track?.duration || this.cur?.duration() || 0; }

  setVolume(v) {
    state.settings.volume = Math.max(0, Math.min(1, v));
    state.settings.muted = false;
    save('settings');
    this.cur?.setVolume(state.settings.volume);
    emit('volume', state.settings);
  }
  toggleMute() {
    state.settings.muted = !state.settings.muted;
    save('settings');
    this.cur?.setVolume(state.settings.muted ? 0 : state.settings.volume);
    emit('volume', state.settings);
  }
  setOutput(id) { return setOutputDevice(id); }

  // Play a song as its music video (YouTube), from the start if it isn't the current song.
  async playVideo(track) {
    if (this.track?.key !== track.key) {
      this.finishListen();
      this.stopCurrent();
      this.queue = [track];
      this.index = 0;
      this.track = track;
      this.pending = 0;
      this.emitQueue();
      emit('track', this);
    }
    return this.switchTo('youtube', { video: true });
  }

  // Switch the current song to another source at the same position (e.g. watch the video).
  async switchTo(name, { video = false } = {}) {
    if (!this.track) return;
    const at = this.time();
    if (name === 'youtube' && video) {
      if (!youtubeSearchable() && !this.track.src.youtube) {
        emit('toast', { text: 'Add a YouTube API key in Accounts to find music videos.', kind: 'error' });
        return;
      }
      const ids = this.track.src.youtube ? [this.track.src.youtube] : await youtube.candidates(this.track, true).catch(() => []);
      if (!ids.length) { emit('toast', { text: 'No video found for this song.', kind: 'error' }); return; }
      const token = ++this.token;
      this.finishListen();
      this.stopCurrent();
      const a = this.adapters.youtube;
      a.h = this.handlers(token, a);
      try {
        await a.load(this.track, ids, at);
        this.cur = a; this.source = 'youtube';
        a.setVolume(state.settings.muted ? 0 : state.settings.volume);
        this.beginListen();
        emit('track', this);
      } catch (err) { emit('toast', { text: err.message, kind: 'error' }); }
      return;
    }
    return this.start(this.track, at, name);
  }

  setState(s) {
    if (this.state === s) return;
    this.state = s;
    emit('state', this);
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = s === 'playing' ? 'playing' : s === 'paused' ? 'paused' : 'none';
  }

  // -------- listening history, scrobbling, ticks --------
  beginListen() {
    this.listen = { track: this.track, source: this.source, startedAt: Date.now(), ms: 0, scrobbled: false };
    if (state.settings.scrobble && connected('lastfm')) lastfm.nowPlaying(this.track).catch(() => {});
  }
  finishListen() {
    const l = this.listen;
    this.listen = null;
    if (!l) return;
    const d = l.track.duration || 0;
    if (l.ms >= 30000 || (d && l.ms >= d * 500)) {
      const t = l.track;
      state.history.push({ t: l.startedAt, key: t.key, title: t.title, artist: t.artist, album: t.album || '', art: t.art || null, src: l.source, ms: Math.round(l.ms) });
      if (state.history.length > 25000) state.history.splice(0, state.history.length - 25000);
      save('history');
    }
  }
  tick() {
    const now = performance.now();
    const dt = now - this.lastTick;
    this.lastTick = now;
    if (this.state === 'playing' && this.listen) {
      this.listen.ms += dt;
      const l = this.listen;
      const d = l.track.duration || 0;
      if (!l.scrobbled && d > 30 && l.ms >= Math.min(240000, d * 500) && state.settings.scrobble && connected('lastfm')) {
        l.scrobbled = true;
        lastfm.scrobble(l.track, l.startedAt).catch(() => {});
      }
    }
    if (this.state === 'playing' || this.state === 'loading') emit('time', this);
    if (++this.tickN % 4 === 0 && this.state === 'playing') {
      this.updatePosition();
      if (this.tickN % 20 === 0) this.persist();
    }
  }

  // -------- OS media controls (SMTC on Windows, MPRIS on Linux) --------
  setupMediaSession() {
    if (!('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    const set = (a, fn) => { try { ms.setActionHandler(a, fn); } catch { /* unsupported */ } };
    set('play', () => this.play());
    set('pause', () => this.pause());
    set('previoustrack', () => this.prev());
    set('nexttrack', () => this.next());
    set('seekto', (e) => this.seek(e.seekTime));
    set('seekbackward', (e) => this.seek(this.time() - (e.seekOffset || 10)));
    set('seekforward', (e) => this.seek(this.time() + (e.seekOffset || 10)));
  }
  updateMediaSession() {
    if (!('mediaSession' in navigator) || !this.track) return;
    const t = this.track;
    const art = t.artLarge || t.art;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: t.title, artist: t.artist, album: t.album || '',
      artwork: art ? [{ src: art, sizes: '512x512' }] : [],
    });
  }
  updatePosition() {
    if (!('mediaSession' in navigator)) return;
    const d = this.duration();
    if (!d) return;
    try { navigator.mediaSession.setPositionState({ duration: d, position: Math.min(this.time(), d), playbackRate: 1 }); } catch { /* ignore */ }
  }
}

function noSourceHint(track) {
  if (track.src.spotify && !connected('spotify')) return 'Link Spotify in Accounts to play it.';
  if (!youtubeSearchable() && !connected('spotify')) return 'Link Spotify or add a YouTube API key in Accounts so MusicForge can find a full-length source.';
  return 'No source had it.';
}

export const engine = new Engine();
