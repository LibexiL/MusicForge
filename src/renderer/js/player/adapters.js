// Playback adapters. Each one plays a single track from one source and reports back
// through `this.h` = { playing(bool), ended(), error(err), buffering() }, which the engine
// sets before load() and clears on stop() so stale players can never drive the queue.
import { audioEl, audioGraph, setGain } from './audio.js';
import { spotify } from '../services.js';
import { mf, state } from '../state.js';
import { setEmbed } from '../ui/embed.js';
import { h, debounce } from '../util.js';

const once = (target, ev) => new Promise((res) => target.addEventListener(ev, res, { once: true }));

function loadScript(src, readyGlobal, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.onerror = () => reject(new Error(`Could not load ${new URL(src).hostname}. Check your connection.`));
    if (readyGlobal) {
      const t = setTimeout(() => reject(new Error(`${new URL(src).hostname} took too long to load.`)), timeout);
      window[readyGlobal] = () => { clearTimeout(t); resolve(); };
    } else s.onload = () => resolve();
    document.head.append(s);
  });
}

// ---------------------------------------------------------------- local files + previews
export class AudioAdapter {
  constructor() {
    this.name = 'audio';
    this.h = null;
    const el = audioEl();
    el.addEventListener('playing', () => this.h?.playing(true));
    el.addEventListener('pause', () => { if (!el.ended) this.h?.playing(false); });
    el.addEventListener('ended', () => this.h?.ended());
    el.addEventListener('waiting', () => this.h?.buffering?.());
    el.addEventListener('error', () => {
      if (!el.getAttribute('src')) return;
      const code = el.error?.code;
      this.h?.error(new Error(code === 4 ? "This file's format isn't supported." : "Couldn't read this audio."));
    });
  }
  async load(track, url, startAt = 0) {
    const el = audioEl();
    const g = audioGraph();
    if (g.ctx.state !== 'running') g.ctx.resume().catch(() => {});
    el.src = url;
    if (startAt > 0) {
      await once(el, 'loadedmetadata');
      el.currentTime = startAt;
    }
    await el.play();
  }
  play() { audioGraph().ctx.resume(); return audioEl().play(); }
  pause() { audioEl().pause(); }
  seek(s) { const el = audioEl(); if (Number.isFinite(s)) el.currentTime = Math.max(0, Math.min(s, (el.duration || s) - 0.05)); }
  setVolume(v) { setGain(v); }
  time() { return audioEl().currentTime || 0; }
  duration() { const d = audioEl().duration; return Number.isFinite(d) ? d : 0; }
  stop() {
    const el = audioEl();
    el.pause();
    el.removeAttribute('src');
    el.load();
  }
}

// ---------------------------------------------------------------- Spotify
// "inapp": the Web Playback SDK plays inside MusicForge (needs a Widevine-enabled Electron build).
// "connect": MusicForge remote-controls the Spotify app on this PC or any device (Spotify Connect).
export class SpotifyAdapter {
  constructor() {
    this.name = 'spotify';
    this.h = null;
    this.mode = null;
    this.sdk = null;
    this.sdkDevice = null;
    this.sdkError = null;
    this.sdkTried = false;
    this.uri = null;
    this.dur = 0;
    this.pos = 0;
    this.at = 0;
    this.isPlaying = false;
    this.poll = null;
    this.endTimer = null;
    this.deviceId = null;
    this.deviceName = '';
    this.pushVolume = debounce((v) => {
      if (this.mode === 'connect' && this.deviceId) spotify.volume(v * 100, this.deviceId).catch(() => {});
    }, 300);
  }

  async ensure() {
    const pref = state.settings.spotifyMode;
    if (pref !== 'connect' && !this.sdkTried) {
      this.sdkTried = true;
      try { await this.initSdk(); } catch (err) { this.sdkError = err.message; console.info('[spotify] in-app playback unavailable:', err.message); }
    }
    if (pref === 'inapp' && !this.sdkDevice) throw new Error(`In-app Spotify playback isn't available here (${this.sdkError || 'unknown reason'}). Switch Spotify playback to "Auto" or "Spotify app" in Settings.`);
    this.mode = pref !== 'connect' && this.sdkDevice ? 'inapp' : 'connect';
  }

  async initSdk() {
    try {
      await navigator.requestMediaKeySystemAccess('com.widevine.alpha', [{
        initDataTypes: ['cenc'],
        audioCapabilities: [{ contentType: 'audio/mp4; codecs="mp4a.40.2"' }],
      }]);
    } catch {
      throw new Error('this build has no Widevine DRM module');
    }
    if (!window.Spotify) await loadScript('https://sdk.scdn.co/spotify-player.js', 'onSpotifyWebPlaybackSDKReady');
    const player = new window.Spotify.Player({
      name: 'MusicForge',
      getOAuthToken: (cb) => mf.invoke('auth:token', 'spotify').then(cb),
      volume: state.settings.muted ? 0 : state.settings.volume,
    });
    const ready = new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('Spotify player did not start')), 12000);
      player.addListener('ready', ({ device_id: id }) => { clearTimeout(t); resolve(id); });
      for (const ev of ['initialization_error', 'authentication_error', 'account_error']) {
        player.addListener(ev, ({ message }) => { clearTimeout(t); reject(new Error(message)); });
      }
    });
    player.addListener('playback_error', ({ message }) => this.h?.error(new Error(`Spotify: ${message}`)));
    player.addListener('player_state_changed', (s) => this.onSdkState(s));
    player.addListener('not_ready', () => { this.sdkDevice = null; });
    if (!(await player.connect())) throw new Error('Spotify player refused to connect');
    this.sdkDevice = await ready;
    this.sdk = player;
  }

  onSdkState(s) {
    if (!s || !this.h || this.mode !== 'inapp') return;
    const cur = s.track_window?.current_track;
    const ours = cur && (cur.uri === this.uri || cur.linked_from?.uri === this.uri);
    if (!ours) {
      if (this.isPlaying && this.time() > this.dur - 5) this.h.ended();
      return;
    }
    this.setPos(s.position / 1000, !s.paused);
  }

  async pickDevice() {
    if (this.mode === 'inapp') { this.deviceName = 'MusicForge'; return this.sdkDevice; }
    const devices = await spotify.devices();
    const want = state.settings.spotifyDevice;
    const d = devices.find((x) => x.id === want) || devices.find((x) => x.is_active) || devices.find((x) => x.type === 'Computer') || devices[0];
    if (!d) throw new Error('Open Spotify on this PC or your phone so MusicForge can play through it.');
    this.deviceName = d.name;
    return d.id;
  }

  async load(track, uri, startAt = 0) {
    await this.ensure();
    this.uri = uri;
    this.dur = track.duration || 0;
    this.deviceId = await this.pickDevice();
    try {
      await spotify.play(this.deviceId, uri, startAt * 1000);
    } catch (err) {
      if (err.status === 403) throw new Error('Spotify only allows playback control with Premium.');
      if (err.status === 404) throw new Error('Spotify lost the playback device. Open Spotify and try again.');
      throw err;
    }
    if (this.mode === 'connect' && !state.settings.muted) this.pushVolume(state.settings.volume);
    this.setPos(startAt, true);
    clearInterval(this.poll);
    if (this.mode === 'connect') this.poll = setInterval(() => this.sync(), 2500);
  }

  setPos(sec, playing) {
    const changed = playing !== this.isPlaying;
    this.pos = sec;
    this.at = performance.now();
    this.isPlaying = playing;
    if (changed) this.h?.playing(playing);
    clearTimeout(this.endTimer);
    if (playing && this.dur) {
      const rem = this.dur - sec;
      this.endTimer = setTimeout(() => { if (this.h && this.isPlaying) this.h.ended(); }, Math.max(0, rem * 1000 - 300));
    }
  }

  async sync() {
    if (!this.h) return;
    try {
      const s = await spotify.playerState();
      if (!this.h || !s || !s.item) return;
      if (s.item.uri !== this.uri && s.item.linked_from?.uri !== this.uri) {
        if (this.isPlaying && this.time() > this.dur - 6) this.h.ended();
        else if (this.isPlaying) this.setPos(this.time(), false); // changed in the Spotify app; let it be
        return;
      }
      if (s.device?.id) this.deviceId = s.device.id;
      this.setPos(s.progress_ms / 1000, s.is_playing);
    } catch { /* transient */ }
  }

  play() {
    this.setPos(this.pos, true);
    return this.mode === 'inapp' ? this.sdk.resume() : spotify.resume(this.deviceId).catch((e) => this.h?.error(e));
  }
  pause() {
    this.setPos(this.time(), false);
    return this.mode === 'inapp' ? this.sdk.pause() : spotify.pause(this.deviceId).catch(() => {});
  }
  seek(s) {
    this.setPos(s, this.isPlaying);
    return this.mode === 'inapp' ? this.sdk.seek(Math.round(s * 1000)) : spotify.seek(s * 1000, this.deviceId).catch(() => {});
  }
  setVolume(v) {
    if (this.mode === 'inapp') this.sdk?.setVolume(v);
    else this.pushVolume(v);
  }
  time() { return this.isPlaying ? Math.min(this.pos + (performance.now() - this.at) / 1000, this.dur || Infinity) : this.pos; }
  duration() { return this.dur; }
  stop() {
    clearInterval(this.poll);
    clearTimeout(this.endTimer);
    if (this.isPlaying) {
      if (this.mode === 'inapp') this.sdk?.pause();
      else if (this.deviceId) spotify.pause(this.deviceId).catch(() => {});
    }
    this.isPlaying = false;
  }
}

// ---------------------------------------------------------------- YouTube (IFrame Player API)
let ytLoad = null;
const loadYT = () => (ytLoad ||= loadScript('https://www.youtube.com/iframe_api', 'onYouTubeIframeAPIReady').then(() => window.YT));

export class YouTubeAdapter {
  constructor() {
    this.name = 'youtube';
    this.h = null;
    this.player = null;
    this.ids = [];
    this.idx = 0;
    this.startAt = 0;
  }
  async ensurePlayer() {
    if (this.player) return this.player;
    const YT = await loadYT();
    await new Promise((resolve) => {
      this.player = new YT.Player('yt-player', {
        width: '100%', height: '100%',
        playerVars: { autoplay: 1, controls: 1, rel: 0, playsinline: 1, iv_load_policy: 3, origin: location.origin, enablejsapi: 1 },
        events: {
          onReady: () => resolve(),
          onStateChange: (e) => this.onState(e.data),
          onError: (e) => this.onErr(e.data),
        },
      });
    });
    return this.player;
  }
  async load(track, ids, startAt = 0) {
    this.ids = Array.isArray(ids) ? ids : [ids];
    this.idx = 0;
    this.startAt = startAt;
    setEmbed('youtube', `${track.title} — YouTube`);
    await this.ensurePlayer();
    this.player.setVolume(state.settings.muted ? 0 : Math.round(state.settings.volume * 100));
    this.player.loadVideoById({ videoId: this.ids[0], startSeconds: startAt || 0 });
  }
  onState(s) {
    if (!this.h) return;
    if (s === 0) this.h.ended();
    else if (s === 1) this.h.playing(true);
    else if (s === 2) this.h.playing(false);
    else if (s === 3) this.h.buffering?.();
  }
  onErr(code) {
    if (!this.h) return;
    if (this.idx < this.ids.length - 1) {
      this.idx++;
      this.player.loadVideoById({ videoId: this.ids[this.idx], startSeconds: this.startAt || 0 });
      return;
    }
    const msg = code === 150 || code === 101
      ? "This video's owner doesn't allow playback outside YouTube."
      : code === 100 ? 'This video was removed or made private.' : `YouTube couldn't play this (error ${code}).`;
    this.h.error(new Error(msg));
  }
  currentId() { return this.ids[this.idx]; }
  play() { this.player?.playVideo(); }
  pause() { this.player?.pauseVideo(); }
  seek(s) { this.player?.seekTo(s, true); }
  setVolume(v) { this.player?.setVolume?.(Math.round(v * 100)); }
  time() { return this.player?.getCurrentTime?.() || 0; }
  duration() { return this.player?.getDuration?.() || 0; }
  stop() { try { this.player?.stopVideo?.(); } catch { /* not ready */ } setEmbed(null); }
}

// ---------------------------------------------------------------- SoundCloud (Widget API)
let scLoad = null;
const loadSC = () => (scLoad ||= loadScript('https://w.soundcloud.com/player/api.js').then(() => window.SC));

export class SoundCloudAdapter {
  constructor() {
    this.name = 'soundcloud';
    this.h = null;
    this.widget = null;
    this.pos = 0;
    this.at = 0;
    this.dur = 0;
    this.isPlaying = false;
  }
  async load(track, url, startAt = 0) {
    setEmbed('soundcloud', `${track.title} — SoundCloud`);
    const SC = await loadSC();
    const opts = '&auto_play=true&visual=true&show_comments=false&hide_related=true&show_teaser=false';
    await new Promise((resolve, reject) => {
      const onReady = () => {
        this.widget.getDuration((d) => { this.dur = d / 1000; });
        this.widget.setVolume(state.settings.muted ? 0 : Math.round(state.settings.volume * 100));
        if (startAt > 0) this.widget.seekTo(startAt * 1000);
        this.widget.play();
        resolve();
      };
      const t = setTimeout(() => reject(new Error("SoundCloud didn't respond. The track may be private or removed.")), 15000);
      const done = () => { clearTimeout(t); onReady(); };
      if (!this.widget) {
        const iframe = h('iframe', { allow: 'autoplay; encrypted-media', title: 'SoundCloud player', src: `https://w.soundcloud.com/player/?url=${encodeURIComponent(url)}${opts}` });
        document.getElementById('sc-slot').append(iframe);
        this.widget = SC.Widget(iframe);
        const E = SC.Widget.Events;
        this.widget.bind(E.READY, () => this.readyCb?.());
        this.widget.bind(E.PLAY, () => { this.mark(this.pos, true); this.h?.playing(true); });
        this.widget.bind(E.PAUSE, () => { this.mark(this.pos, false); this.h?.playing(false); });
        this.widget.bind(E.FINISH, () => this.h?.ended());
        this.widget.bind(E.PLAY_PROGRESS, (e) => this.mark(e.currentPosition / 1000, this.isPlaying));
        this.widget.bind(E.ERROR, () => this.h?.error(new Error("SoundCloud couldn't play this track.")));
        this.readyCb = done;
      } else {
        this.readyCb = null;
        this.widget.load(url, { auto_play: true, visual: true, show_comments: false, hide_related: true, callback: done });
      }
    });
  }
  mark(sec, playing) { this.pos = sec; this.at = performance.now(); this.isPlaying = playing; }
  play() { this.widget?.play(); }
  pause() { this.widget?.pause(); }
  seek(s) { this.widget?.seekTo(s * 1000); this.mark(s, this.isPlaying); }
  setVolume(v) { this.widget?.setVolume(Math.round(v * 100)); }
  time() { return this.isPlaying ? this.pos + (performance.now() - this.at) / 1000 : this.pos; }
  duration() { return this.dur; }
  stop() { this.widget?.pause(); this.isPlaying = false; setEmbed(null); }
}
