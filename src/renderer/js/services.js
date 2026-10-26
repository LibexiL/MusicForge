// Service connectors. Each maps its API into one Track shape:
// { key, title, artist, album, duration (s), art, artLarge, src: { spotify|youtube|local|soundcloud|preview|deezer|apple }, origin, url }
import { mf, state, mediaUrl, coverUrl } from './state.js';
import { decodeEntities } from './util.js';

export class ApiError extends Error {
  constructor(msg, status, code) { super(msg); this.status = status; this.code = code; }
}

export async function api(service, path, opts = {}) {
  let r;
  try {
    r = await mf.invoke('api:request', { service, path, ...opts });
  } catch (err) {
    const raw = String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
    const offline = /ERR_(INTERNET_DISCONNECTED|NAME_NOT_RESOLVED|TUNNEL_CONNECTION_FAILED|CONNECTION|TIMED_OUT|PROXY|NETWORK)/.test(raw);
    throw new ApiError(offline ? `Can't reach ${NAMES[service] || service}. Check your internet connection.` : raw, 0, offline ? 'offline' : null);
  }
  if (!r.ok && r.status === 0) throw new ApiError(`Can't reach ${NAMES[service] || service}. Check your internet connection.`, 0, 'offline');
  if (!r.ok) {
    const msg = r.error === 'not_connected' ? `${NAMES[service] || service} isn't linked yet. Set it up in Accounts.` : String(r.error);
    throw new ApiError(msg, r.status, r.error === 'not_connected' ? 'not_connected' : (r.data?.error?.reason || r.data?.reason || null));
  }
  return r.data;
}

export const NAMES = {
  spotify: 'Spotify', youtube: 'YouTube', soundcloud: 'SoundCloud', deezer: 'Deezer', apple: 'Apple Music',
  itunes: 'Apple Music', lastfm: 'Last.fm', local: 'Local files', preview: 'Preview', lrclib: 'LRCLIB',
};

const pickImage = (images, min = 0) => {
  if (!images?.length) return null;
  const sorted = [...images].sort((a, b) => (a.width || 0) - (b.width || 0));
  return (sorted.find((i) => (i.width || 0) >= min) || sorted[sorted.length - 1]).url;
};

// ---------------- Local ----------------
export const local = {
  map(t) {
    return {
      key: `lo:${t.id}`, title: t.title, artist: t.artist || 'Unknown artist', album: t.album || '',
      duration: t.duration, art: t.cover ? coverUrl(t.id) : null, artLarge: t.cover ? coverUrl(t.id) : null,
      src: { local: t.id }, origin: 'local', no: t.no, disc: t.disc, year: t.year, genre: t.genre, albumArtist: t.albumArtist,
    };
  },
  url: (id) => mediaUrl(id),
};

// ---------------- Spotify ----------------
export const spotify = {
  map(t) {
    if (!t || !t.id || t.type === 'episode') return null;
    return {
      key: `sp:${t.id}`, title: t.name, artist: (t.artists || []).map((a) => a.name).join(', '),
      artistId: t.artists?.[0]?.id ? `sp:${t.artists[0].id}` : null,
      album: t.album?.name || '', duration: (t.duration_ms || 0) / 1000,
      art: pickImage(t.album?.images, 160), artLarge: pickImage(t.album?.images, 600),
      src: { spotify: t.uri, isrc: t.external_ids?.isrc }, origin: 'spotify', url: t.external_urls?.spotify,
    };
  },
  async pages(path, query = {}, max = 2000, pick = (d) => d) {
    const out = [];
    let data = pick(await api('spotify', path, { query: { limit: 50, ...query } }));
    out.push(...(data.items || []));
    while (data.next && out.length < max) {
      data = pick(await api('spotify', data.next));
      out.push(...(data.items || []));
    }
    return out;
  },
  async playlists() {
    const items = await this.pages('/me/playlists', {}, 1000);
    return items.filter(Boolean).map((p) => ({
      id: p.id, name: p.name, image: pickImage(p.images, 200), owner: p.owner?.display_name,
      count: p.items?.total ?? p.tracks?.total ?? 0, url: p.external_urls?.spotify, service: 'spotify',
    }));
  },
  async playlistTracks(id) {
    try {
      const items = await this.pages(`/playlists/${id}/items`, {}, 5000);
      return items.map((i) => this.map(i.item || i.track)).filter(Boolean);
    } catch (err) {
      if (err.status === 403 || err.status === 404) {
        throw new ApiError('Spotify only shares the songs of playlists you own or collaborate on.', err.status);
      }
      throw err;
    }
  },
  async liked(max = 3000) {
    const items = await this.pages('/me/tracks', {}, max);
    return items.map((i) => this.map(i.track)).filter(Boolean);
  },
  async top(type = 'tracks', range = 'medium_term', limit = 50) {
    const d = await api('spotify', `/me/top/${type}`, { query: { time_range: range, limit }, ttl: 600 });
    return type === 'tracks' ? d.items.map((t) => this.map(t)).filter(Boolean)
      : d.items.map((a) => ({ id: a.id, name: a.name, image: pickImage(a.images, 160), genres: a.genres || [], url: a.external_urls?.spotify }));
  },
  async recent() {
    const d = await api('spotify', '/me/player/recently-played', { query: { limit: 50 }, ttl: 60 });
    return d.items.map((i) => ({ ...this.map(i.track), playedAt: Date.parse(i.played_at) })).filter((t) => t.key);
  },
  async search(q) {
    const d = await api('spotify', '/search', { query: { q, type: 'track', limit: 10 }, ttl: 300 });
    return (d.tracks?.items || []).map((t) => this.map(t)).filter(Boolean);
  },
  // Songs, albums and artists in one request (Spotify caps each at 10 for personal apps).
  async searchAll(q) {
    const d = await api('spotify', '/search', { query: { q, type: 'track,album,artist', limit: 10 }, ttl: 300 });
    return {
      tracks: (d.tracks?.items || []).map((t) => this.map(t)).filter(Boolean),
      albums: (d.albums?.items || []).filter(Boolean).map((a) => ({
        id: a.id, title: a.name, cover: pickImage(a.images, 300), artist: (a.artists || []).map((x) => x.name).join(', '),
        year: (a.release_date || '').slice(0, 4), type: a.album_type, service: 'spotify',
      })),
      artists: (d.artists?.items || []).filter(Boolean).map((a) => ({ id: a.id, name: a.name, image: pickImage(a.images, 300), genres: a.genres || [], service: 'spotify' })),
    };
  },
  async albumInfo(id) {
    const a = await api('spotify', `/albums/${id}`, { ttl: 3600 });
    return {
      title: a.name, cover: pickImage(a.images, 600), artist: (a.artists || []).map((x) => x.name).join(', '),
      tracks: (a.tracks?.items || []).map((t) => this.map({ ...t, album: a })).filter(Boolean),
    };
  },
  async findMatch(track) {
    const q = `track:${track.title.replace(/["']/g, '')} artist:${(track.artist || '').split(',')[0]}`;
    const d = await api('spotify', '/search', { query: { q, type: 'track', limit: 3 }, ttl: 3600 });
    const items = d.tracks?.items || [];
    const best = items.find((t) => !track.duration || Math.abs(t.duration_ms / 1000 - track.duration) < 8) || items[0];
    return best?.uri || null;
  },
  async track(id) { return this.map(await api('spotify', `/tracks/${id}`, { ttl: 3600 })); },
  async album(id) {
    const a = await api('spotify', `/albums/${id}`, { ttl: 3600 });
    return (a.tracks?.items || []).map((t) => this.map({ ...t, album: a })).filter(Boolean);
  },
  save(uris) { return api('spotify', '/me/library', { method: 'PUT', body: { uris } }); },
  devices() { return api('spotify', '/me/player/devices').then((d) => d.devices || []); },
  playerState() { return api('spotify', '/me/player'); },
  play(deviceId, uri, positionMs = 0) {
    return api('spotify', '/me/player/play', { method: 'PUT', query: deviceId ? { device_id: deviceId } : {}, body: { uris: [uri], position_ms: Math.max(0, Math.round(positionMs)) } });
  },
  resume(deviceId) { return api('spotify', '/me/player/play', { method: 'PUT', query: deviceId ? { device_id: deviceId } : {} }); },
  pause(deviceId) { return api('spotify', '/me/player/pause', { method: 'PUT', query: deviceId ? { device_id: deviceId } : {} }); },
  seek(ms, deviceId) { return api('spotify', '/me/player/seek', { method: 'PUT', query: { position_ms: Math.round(ms), ...(deviceId ? { device_id: deviceId } : {}) } }); },
  volume(pct, deviceId) { return api('spotify', '/me/player/volume', { method: 'PUT', query: { volume_percent: Math.round(pct), ...(deviceId ? { device_id: deviceId } : {}) } }); },
};

// ---------------- YouTube ----------------
const isoDur = (s) => {
  const m = /P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(s || '');
  if (!m) return 0;
  return (+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0);
};

function splitYouTubeTitle(rawTitle, channel) {
  const title = decodeEntities(rawTitle);
  const ch = decodeEntities(channel || '').replace(/\s*-\s*Topic$/i, '').replace(/VEVO$/i, '');
  const m = /^(.+?)\s+[-–—]\s+(.+)$/.exec(title);
  if (m) {
    const t = m[2].replace(/\s*[([](official|lyric|audio|music|video|hd|4k|visuali[sz]er|mv)[^)\]]*[)\]]/gi, '').trim();
    return { artist: m[1].trim(), title: t || m[2] };
  }
  return { artist: ch, title: title.replace(/\s*[([](official|lyric|audio|music video|video)[^)\]]*[)\]]/gi, '').trim() };
}

export const youtube = {
  map(v, durations = {}) {
    const id = typeof v.id === 'string' ? v.id : v.id?.videoId || v.contentDetails?.videoId || v.snippet?.resourceId?.videoId;
    const sn = v.snippet || {};
    if (!id || sn.title === 'Deleted video' || sn.title === 'Private video') return null;
    const { artist, title } = splitYouTubeTitle(sn.title, sn.videoOwnerChannelTitle || sn.channelTitle);
    const th = sn.thumbnails || {};
    return {
      key: `yt:${id}`, title, artist, album: '', duration: durations[id] ?? isoDur(v.contentDetails?.duration),
      art: (th.medium || th.default || {}).url || `https://i.ytimg.com/vi/${id}/mqdefault.jpg`,
      artLarge: (th.maxres || th.high || th.medium || {}).url || `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
      src: { youtube: id }, origin: 'youtube', url: `https://www.youtube.com/watch?v=${id}`, rawTitle: decodeEntities(sn.title),
      music: sn.categoryId === '10',
    };
  },
  async durations(ids) {
    const out = {};
    for (let i = 0; i < ids.length; i += 50) {
      const d = await api('youtube', '/videos', { query: { part: 'contentDetails', id: ids.slice(i, i + 50).join(','), maxResults: 50 }, ttl: 86400 });
      for (const v of d.items || []) out[v.id] = isoDur(v.contentDetails.duration);
    }
    return out;
  },
  async search(q, { music = true, max = 10 } = {}) {
    const d = await api('youtube', '/search', {
      query: { part: 'snippet', type: 'video', q, maxResults: max, ...(music ? { videoCategoryId: 10 } : {}), videoEmbeddable: 'true' },
      ttl: 86400,
    });
    const items = d.items || [];
    const durs = await this.durations(items.map((i) => i.id.videoId)).catch(() => ({}));
    return items.map((i) => this.map(i, durs)).filter(Boolean);
  },
  // Candidates for playing a song from another service, best first.
  async candidates(track, video = false) {
    const q = `${(track.artist || '').split(',')[0]} ${track.title} ${video ? 'official video' : 'audio'}`;
    const list = await this.search(q, { max: 5 });
    if (!track.duration || video) return list.map((t) => t.src.youtube);
    return list
      .map((t) => ({ id: t.src.youtube, d: Math.abs((t.duration || 0) - track.duration) }))
      .sort((a, b) => a.d - b.d)
      .map((x) => x.id);
  },
  async playlists() {
    const out = [];
    let token;
    do {
      const d = await api('youtube', '/playlists', { query: { part: 'snippet,contentDetails', mine: 'true', maxResults: 50, pageToken: token } });
      for (const p of d.items || []) {
        out.push({ id: p.id, name: decodeEntities(p.snippet.title), image: p.snippet.thumbnails?.medium?.url, count: p.contentDetails?.itemCount || 0, service: 'youtube', url: `https://www.youtube.com/playlist?list=${p.id}` });
      }
      token = d.nextPageToken;
    } while (token && out.length < 500);
    return out;
  },
  async playlistTracks(id, max = 2000) {
    const items = [];
    let token;
    do {
      const d = await api('youtube', '/playlistItems', { query: { part: 'snippet,contentDetails', playlistId: id, maxResults: 50, pageToken: token } });
      items.push(...(d.items || []));
      token = d.nextPageToken;
    } while (token && items.length < max);
    const durs = await this.durations(items.map((i) => i.contentDetails?.videoId).filter(Boolean)).catch(() => ({}));
    return items.map((i) => this.map(i, durs)).filter(Boolean);
  },
  // Liked videos, newest first. YouTube Music likes are YouTube likes, so they're included;
  // `music` marks videos in YouTube's Music category.
  async liked(max = 1000) {
    const out = [];
    let token;
    do {
      const d = await api('youtube', '/videos', { query: { part: 'snippet,contentDetails', myRating: 'like', maxResults: 50, pageToken: token }, ttl: 300 });
      for (const v of d.items || []) { const t = this.map(v); if (t) out.push(t); }
      token = d.nextPageToken;
    } while (token && out.length < max);
    return out;
  },
  async video(id) {
    const d = await api('youtube', '/videos', { query: { part: 'snippet,contentDetails', id }, ttl: 86400 });
    return d.items?.[0] ? this.map(d.items[0]) : null;
  },
};

// ---------------- Deezer (public API: search, charts, artist stats, 30 s previews) ----------------
export const deezer = {
  map(t) {
    if (!t?.id) return null;
    return {
      key: `dz:${t.id}`, title: t.title_short || t.title, artist: t.artist?.name || '', artistId: t.artist?.id ? `dz:${t.artist.id}` : null,
      album: t.album?.title || '', duration: t.duration || 0,
      art: t.album?.cover_medium || null, artLarge: t.album?.cover_xl || t.album?.cover_big || null,
      src: { deezer: t.id, preview: t.preview || null, isrc: t.isrc }, origin: 'deezer', url: t.link,
    };
  },
  mapArtist(a) {
    return { id: a.id, name: a.name, image: a.picture_medium, imageLarge: a.picture_xl || a.picture_big, fans: a.nb_fan, albums: a.nb_album, url: a.link };
  },
  async search(q, limit = 25) {
    const d = await api('deezer', '/search', { query: { q, limit }, ttl: 900 });
    return (d.data || []).map((t) => this.map(t)).filter(Boolean);
  },
  async searchAlbums(q, limit = 18) {
    const d = await api('deezer', '/search/album', { query: { q, limit }, ttl: 900 });
    return (d.data || []).map((a) => ({ id: a.id, title: a.title, cover: a.cover_medium, coverLarge: a.cover_xl, artist: a.artist?.name || '', type: a.record_type, count: a.nb_tracks, service: 'deezer' }));
  },
  async searchPlaylists(q, limit = 18) {
    const d = await api('deezer', '/search/playlist', { query: { q, limit }, ttl: 900 });
    return (d.data || []).map((p) => ({ id: p.id, name: p.title, image: p.picture_medium, count: p.nb_tracks, owner: p.user?.name || '', service: 'deezer', url: p.link }));
  },
  async searchArtists(q, limit = 8) {
    const d = await api('deezer', '/search/artist', { query: { q, limit }, ttl: 900 });
    return (d.data || []).map((a) => this.mapArtist(a));
  },
  async artist(id) { return this.mapArtist(await api('deezer', `/artist/${id}`, { ttl: 1800 })); },
  async artistTop(id, limit = 10) {
    const d = await api('deezer', `/artist/${id}/top`, { query: { limit }, ttl: 1800 });
    return (d.data || []).map((t) => this.map(t)).filter(Boolean);
  },
  async artistAlbums(id) {
    const d = await api('deezer', `/artist/${id}/albums`, { query: { limit: 100 }, ttl: 3600 });
    return (d.data || []).map((a) => ({ id: a.id, title: a.title, cover: a.cover_medium, year: (a.release_date || '').slice(0, 4), type: a.record_type, fans: a.fans }));
  },
  async related(id) {
    const d = await api('deezer', `/artist/${id}/related`, { query: { limit: 12 }, ttl: 86400 });
    return (d.data || []).map((a) => this.mapArtist(a));
  },
  async album(id) {
    const a = await api('deezer', `/album/${id}`, { ttl: 3600 });
    return { title: a.title, cover: a.cover_xl, artist: a.artist?.name, tracks: (a.tracks?.data || []).map((t) => this.map({ ...t, album: a })).filter(Boolean) };
  },
  async chart() {
    const d = await api('deezer', '/chart/0', { ttl: 1800 });
    return { tracks: (d.tracks?.data || []).map((t) => this.map(t)).filter(Boolean), artists: (d.artists?.data || []).map((a) => this.mapArtist(a)) };
  },
  async playlist(id) {
    const p = await api('deezer', `/playlist/${id}`, { ttl: 600 });
    let tracks = p.tracks?.data || [];
    let next = p.tracks?.next;
    while (next && tracks.length < 2000) {
      const d = await api('deezer', next);
      tracks = tracks.concat(d.data || []);
      next = d.next;
    }
    return { name: p.title, image: p.picture_medium, tracks: tracks.map((t) => this.map(t)).filter(Boolean) };
  },
  async findPreview(track) {
    const list = await this.search(`artist:"${(track.artist || '').split(',')[0]}" track:"${track.title}"`, 3).catch(() => []);
    const hit = list[0] || (await this.search(`${track.artist} ${track.title}`, 3).catch(() => []))[0];
    return hit?.src.preview || null;
  },
};

// ---------------- Apple: iTunes catalogue (no key) + Apple Music library (MusicKit, optional) ----------------
export const itunes = {
  map(t) {
    if (!t?.trackId) return null;
    const art = t.artworkUrl100 || null;
    return {
      key: `it:${t.trackId}`, title: t.trackName, artist: t.artistName, album: t.collectionName || '',
      duration: (t.trackTimeMillis || 0) / 1000, art: art && art.replace('100x100bb', '200x200bb'), artLarge: art && art.replace('100x100bb', '1000x1000bb'),
      src: { preview: t.previewUrl || null, apple: String(t.trackId) }, origin: 'itunes', url: t.trackViewUrl,
    };
  },
  async search(q, limit = 20) {
    const d = await api('itunes', '/search', { query: { term: q, entity: 'song', limit }, ttl: 900 });
    return (d.results || []).map((t) => this.map(t)).filter(Boolean);
  },
};

export const apple = {
  map(item) {
    const a = item.attributes || {};
    const art = a.artwork?.url;
    return {
      key: `am:${item.id}`, title: a.name, artist: a.artistName, album: a.albumName || '', duration: (a.durationInMillis || 0) / 1000,
      art: art ? art.replace('{w}', '200').replace('{h}', '200') : null, artLarge: art ? art.replace('{w}', '1000').replace('{h}', '1000') : null,
      src: { apple: a.playParams?.catalogId || item.id, isrc: a.isrc }, origin: 'apple', url: a.url,
    };
  },
  async loadMusicKit() {
    if (window.MusicKit) return window.MusicKit;
    await new Promise((resolve, reject) => {
      document.addEventListener('musickitloaded', resolve, { once: true });
      const s = document.createElement('script');
      s.src = 'https://js-cdn.music.apple.com/musickit/v3/musickit.js';
      s.async = true;
      s.onerror = () => reject(new Error('Could not load MusicKit from Apple.'));
      document.head.append(s);
    });
    return window.MusicKit;
  },
  async authorize() {
    const { developerToken } = await mf.invoke('auth:token', 'apple');
    if (!developerToken) throw new Error('Add your Apple Music developer token first.');
    const MK = await this.loadMusicKit();
    await MK.configure({ developerToken, app: { name: 'MusicForge', build: state.info.version } });
    const userToken = await MK.getInstance().authorize();
    return mf.invoke('auth:appleUserToken', userToken);
  },
  async pages(path) {
    const out = [];
    let d = await api('apple', path, { query: { limit: 100 } });
    out.push(...(d.data || []));
    while (d.next && out.length < 5000) {
      d = await api('apple', d.next.startsWith('http') ? d.next : `https://api.music.apple.com${d.next}`);
      out.push(...(d.data || []));
    }
    return out;
  },
  async playlists() {
    const items = await this.pages('/me/library/playlists');
    return items.map((p) => ({
      id: p.id, name: p.attributes?.name, count: null, service: 'apple',
      image: p.attributes?.artwork?.url?.replace('{w}', '200').replace('{h}', '200') || null,
    }));
  },
  async playlistTracks(id) { return (await this.pages(`/me/library/playlists/${id}/tracks`)).map((t) => this.map(t)); },
};

// ---------------- SoundCloud (widget playback by link; no API key needed) ----------------
export const soundcloud = {
  async fromUrl(url) {
    const d = await api('soundcloud', '/oembed', { query: { format: 'json', url }, ttl: 86400 });
    let title = d.title || url;
    const by = ` by ${d.author_name}`;
    if (d.author_name && title.endsWith(by)) title = title.slice(0, -by.length);
    return {
      key: `sc:${url}`, title, artist: d.author_name || '', album: '', duration: 0,
      art: d.thumbnail_url || null, artLarge: d.thumbnail_url?.replace('-t500x500', '-t500x500') || null,
      src: { soundcloud: url }, origin: 'soundcloud', url,
    };
  },
};

// ---------------- Last.fm (stats + scrobbling) ----------------
export const lastfm = {
  enabled: () => !!state.auth?.config?.lastfm?.apiKey,
  async artist(name) {
    const d = await api('lastfm', '', { query: { method: 'artist.getInfo', artist: name, autocorrect: 1 }, ttl: 1800 });
    const a = d.artist;
    if (!a) return null;
    return {
      name: a.name, listeners: +a.stats?.listeners || 0, playcount: +a.stats?.playcount || 0,
      userPlaycount: a.stats?.userplaycount ? +a.stats.userplaycount : null,
      tags: (a.tags?.tag || []).map((t) => t.name), bio: (a.bio?.summary || '').replace(/<a [^>]*>.*?<\/a>\.?/g, '').trim(), url: a.url,
    };
  },
  async user(name) {
    const d = await api('lastfm', '', { query: { method: 'user.getInfo', user: name }, ttl: 300 });
    return d.user;
  },
  async userTop(name, kind = 'artists', period = '1month', limit = 20) {
    const method = kind === 'artists' ? 'user.getTopArtists' : 'user.getTopTracks';
    const d = await api('lastfm', '', { query: { method, user: name, period, limit }, ttl: 600 });
    return kind === 'artists' ? (d.topartists?.artist || []) : (d.toptracks?.track || []);
  },
  async recent(name, limit = 30) {
    const d = await api('lastfm', '', { query: { method: 'user.getRecentTracks', user: name, limit }, ttl: 60 });
    return d.recenttracks?.track || [];
  },
  nowPlaying(t) {
    return api('lastfm', '', { method: 'POST', query: { method: 'track.updateNowPlaying', artist: t.artist, track: t.title, album: t.album || undefined, duration: Math.round(t.duration) || undefined } });
  },
  scrobble(t, startedAt) {
    return api('lastfm', '', { method: 'POST', query: { method: 'track.scrobble', artist: t.artist, track: t.title, album: t.album || undefined, timestamp: Math.floor(startedAt / 1000), duration: Math.round(t.duration) || undefined } });
  },
};

// ---------------- LRCLIB (free synced lyrics) ----------------
export const lrclib = {
  async find(track) {
    const artist = (track.artist || '').split(/,| & | feat\.? | ft\.? /i)[0].trim();
    const title = track.title.replace(/\s*[([](feat|ft|with|remaster|live)[^)\]]*[)\]]/gi, '').replace(/\s+-\s+.*remaster.*$/i, '').trim();
    try {
      const q = { artist_name: artist, track_name: title };
      if (track.album) q.album_name = track.album;
      if (track.duration) q.duration = Math.round(track.duration);
      return await api('lrclib', '/get', { query: q, ttl: 86400 });
    } catch (err) {
      if (err.status !== 404) throw err;
    }
    const list = await api('lrclib', '/search', { query: { track_name: title, artist_name: artist }, ttl: 86400 });
    if (!Array.isArray(list) || !list.length) return null;
    const scored = list.map((l) => ({ l, d: track.duration ? Math.abs((l.duration || 0) - track.duration) : 0, s: l.syncedLyrics ? 0 : 1 }));
    scored.sort((a, b) => a.s - b.s || a.d - b.d);
    return scored[0].d < 15 || !track.duration ? scored[0].l : null;
  },
};

// ---------------- Link parsing (paste a URL into search) ----------------
export function parseLink(text) {
  let u;
  try { u = new URL(text.trim()); } catch { return null; }
  const host = u.hostname.replace(/^www\.|^m\.|^music\./, '');
  const parts = u.pathname.split('/').filter(Boolean);
  if (host === 'open.spotify.com') {
    const i = parts.findIndex((p) => ['track', 'playlist', 'album'].includes(p));
    if (i >= 0) return { service: 'spotify', type: parts[i], id: parts[i + 1] };
  }
  if (host === 'youtube.com' || host === 'youtu.be') {
    if (host === 'youtu.be') return { service: 'youtube', type: 'video', id: parts[0] };
    if (u.searchParams.get('v')) return { service: 'youtube', type: 'video', id: u.searchParams.get('v') };
    if (u.searchParams.get('list')) return { service: 'youtube', type: 'playlist', id: u.searchParams.get('list') };
    if (parts[0] === 'shorts') return { service: 'youtube', type: 'video', id: parts[1] };
  }
  if (host === 'soundcloud.com' || host === 'on.soundcloud.com') return { service: 'soundcloud', type: parts.includes('sets') ? 'set' : 'track', url: u.toString() };
  if (host === 'deezer.com') {
    const i = parts.findIndex((p) => ['track', 'playlist', 'album', 'artist'].includes(p));
    if (i >= 0) return { service: 'deezer', type: parts[i], id: parts[i + 1] };
  }
  return null;
}
