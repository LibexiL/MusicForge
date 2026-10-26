// Every outbound API call goes through here: credentials never reach the renderer,
// CORS is a non-issue, and public GETs are cached in memory.
import { net } from 'electron';
import { lastfmSign } from './auth.mjs';

const BASES = {
  spotify: 'https://api.spotify.com/v1',
  youtube: 'https://www.googleapis.com/youtube/v3',
  lastfm: 'https://ws.audioscrobbler.com/2.0/',
  deezer: 'https://api.deezer.com',
  itunes: 'https://itunes.apple.com',
  lrclib: 'https://lrclib.net/api',
  apple: 'https://api.music.apple.com/v1',
  soundcloud: 'https://soundcloud.com',
};

const UA = 'MusicForge/0.1 (+https://github.com/LibexiL/MusicForge)';
const IMAGE_HOSTS = /(scdn\.co|spotifycdn\.com|ytimg\.com|ggpht\.com|googleusercontent\.com|dzcdn\.net|deezer\.com|mzstatic\.com|sndcdn\.com|lastfm\.freetls\.fastly\.net|last\.fm|127\.0\.0\.1)$/;

export class Api {
  constructor(auth) {
    this.auth = auth;
    this.cache = new Map();
  }

  cacheGet(key) {
    const hit = this.cache.get(key);
    if (!hit) return null;
    if (hit.exp < Date.now()) { this.cache.delete(key); return null; }
    return hit.value;
  }
  cacheSet(key, value, ttl) {
    if (this.cache.size > 800) this.cache.delete(this.cache.keys().next().value);
    this.cache.set(key, { value, exp: Date.now() + ttl * 1000 });
  }

  async request({ service, path = '', url: fullUrl, method = 'GET', query = {}, body, ttl = 0 }) {
    const base = BASES[service];
    if (!base) throw new Error(`Unknown service ${service}`);
    if (!fullUrl && path.startsWith('http')) fullUrl = path;
    const url = new URL(fullUrl || base + path);
    if (fullUrl && !fullUrl.startsWith(base.replace(/\/v\d.*$/, '') + '/')) throw new Error('URL does not belong to service');
    const headers = { accept: 'application/json' };
    let payload;
    const q = {};
    for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== null && v !== '') q[k] = v;

    if (service === 'spotify') {
      const token = await this.auth.token('spotify');
      if (!token) return { ok: false, status: 401, error: 'not_connected' };
      headers.authorization = `Bearer ${token}`;
    } else if (service === 'youtube') {
      const token = await this.auth.token('youtube').catch(() => null);
      const { apiKey } = this.auth.config('youtube');
      if (token) headers.authorization = `Bearer ${token}`;
      else if (apiKey) q.key = apiKey;
      else return { ok: false, status: 401, error: 'not_connected' };
    } else if (service === 'lastfm') {
      const cfg = this.auth.config('lastfm');
      if (!cfg.apiKey) return { ok: false, status: 401, error: 'not_connected' };
      q.api_key = cfg.apiKey;
      if (method === 'POST') {
        const sk = this.auth.tok('lastfm')?.sk;
        if (!sk) return { ok: false, status: 401, error: 'not_connected' };
        q.sk = sk;
        q.api_sig = lastfmSign(q, cfg.secret);
        q.format = 'json';
        payload = new URLSearchParams(q).toString();
        headers['content-type'] = 'application/x-www-form-urlencoded';
      } else {
        q.format = 'json';
      }
    } else if (service === 'apple') {
      const { developerToken, userToken } = await this.auth.token('apple');
      if (!developerToken) return { ok: false, status: 401, error: 'not_connected' };
      headers.authorization = `Bearer ${developerToken}`;
      if (userToken) headers['music-user-token'] = userToken;
    }
    if (service === 'lrclib' || service === 'deezer' || service === 'itunes') headers['user-agent'] = UA;

    if (!payload) for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    if (body !== undefined && !payload) {
      payload = JSON.stringify(body);
      headers['content-type'] = 'application/json';
    }

    const cacheKey = method === 'GET' && ttl > 0 ? `${service}|${url}` : null;
    if (cacheKey) {
      const hit = this.cacheGet(cacheKey);
      if (hit) return hit;
    }

    const send = () => net.fetch(url.toString(), { method, headers, body: payload });
    let res;
    try {
      res = await send();
    } catch (err) {
      return { ok: false, status: 0, error: `network: ${err.message}` };
    }
    if (res.status === 401 && (service === 'spotify' || service === 'youtube')) {
      const fresh = await this.auth.token(service, true).catch(() => null);
      if (fresh) { headers.authorization = `Bearer ${fresh}`; res = await send().catch(() => res); }
    }
    if (res.status === 429) {
      const wait = Math.min(Number(res.headers.get('retry-after') || 2), 6) * 1000;
      await new Promise((r) => setTimeout(r, wait));
      res = await send().catch(() => res);
    }

    const type = res.headers.get('content-type') || '';
    let data = null;
    if (res.status !== 204) {
      const text = await res.text();
      if (type.includes('json') || /^[\[{]/.test(text.trim())) {
        try { data = JSON.parse(text); } catch { data = text; }
      } else data = text;
    }
    const out = { ok: res.ok, status: res.status, data };
    if (!res.ok) out.error = (data && (data.error?.message || data.message || data.error)) || `HTTP ${res.status}`;
    if (cacheKey && res.ok) this.cacheSet(cacheKey, out, ttl);
    return out;
  }

  // Raw image bytes for colour extraction (remote images taint the canvas otherwise).
  async imageBytes(url) {
    const u = new URL(url);
    if (!IMAGE_HOSTS.test(u.hostname)) throw new Error('Host not allowed');
    const key = `img|${url}`;
    const hit = this.cacheGet(key);
    if (hit) return hit;
    const res = await net.fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 3_000_000) throw new Error('Image too large');
    const value = { type: res.headers.get('content-type') || 'image/jpeg', data: buf };
    this.cacheSet(key, value, 3600);
    return value;
  }
}
