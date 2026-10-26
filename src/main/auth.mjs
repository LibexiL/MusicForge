// Account linking. Every service uses the user's own developer credentials (Spotify and Google
// no longer hand out shared keys to hobby apps), entered once on the Accounts screen.
import crypto from 'node:crypto';
import { net, shell } from 'electron';

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const md5 = (s) => crypto.createHash('md5').update(s, 'utf8').digest('hex');

export const SPOTIFY_SCOPES = [
  'user-read-private',
  'playlist-read-private',
  'playlist-read-collaborative',
  'playlist-modify-private',
  'playlist-modify-public',
  'user-library-read',
  'user-library-modify',
  'user-top-read',
  'user-read-recently-played',
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-read-currently-playing',
  'user-follow-read',
  'streaming',
].join(' ');

export function lastfmSign(params, secret) {
  const keys = Object.keys(params).filter((k) => k !== 'format' && k !== 'callback').sort();
  return md5(keys.map((k) => k + params[k]).join('') + secret);
}

async function postForm(url, form) {
  const res = await net.fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error_description || data.error?.message || data.error || `HTTP ${res.status}`);
  return data;
}

export class Auth {
  constructor({ secrets, server, onChange }) {
    this.secrets = secrets;
    this.server = server;
    this.onChange = onChange;
    this.refreshing = new Map();
  }

  get redirectBase() { return `${this.server.origin}/callback`; }

  config(service) { return this.secrets.get(`cfg:${service}`) || {}; }
  // Merges: fields not sent keep their stored value; cfg === null forgets everything.
  setConfig(service, cfg) {
    const next = cfg === null ? {} : { ...this.config(service) };
    for (const [k, v] of Object.entries(cfg || {})) {
      if (v === null) delete next[k];
      else if (typeof v === 'string' && v.trim()) next[k] = v.trim();
    }
    this.secrets.set(`cfg:${service}`, Object.keys(next).length ? next : undefined);
    this.onChange();
  }
  tok(service) { return this.secrets.get(`tok:${service}`); }
  setTok(service, t) { this.secrets.set(`tok:${service}`, t); }

  status() {
    const s = {};
    const sp = this.config('spotify'); const spt = this.tok('spotify');
    s.spotify = { configured: !!sp.clientId, connected: !!spt?.refresh_token, user: spt?.user || null, redirect: `${this.redirectBase}/spotify` };
    const yt = this.config('youtube'); const ytt = this.tok('youtube');
    s.youtube = { configured: !!(yt.clientId && yt.clientSecret), hasKey: !!yt.apiKey, connected: !!ytt?.refresh_token, user: ytt?.user || null, redirect: `${this.redirectBase}/google` };
    const lf = this.config('lastfm'); const lft = this.tok('lastfm');
    s.lastfm = { configured: !!(lf.apiKey && lf.secret), connected: !!lft?.sk, user: lft?.name ? { name: lft.name } : null };
    const am = this.config('apple'); const amt = this.tok('apple');
    s.apple = { configured: !!am.developerToken, connected: !!amt?.userToken, user: null };
    // Public catalogues: no sign-in.
    s.deezer = { configured: true, connected: true };
    s.soundcloud = { configured: true, connected: true };
    s.itunes = { configured: true, connected: true };
    s.encrypted = this.secrets.encrypted;
    // Show the non-secret parts of config so the form can be prefilled.
    s.config = {
      spotify: { clientId: sp.clientId || '' },
      youtube: { clientId: yt.clientId || '', hasSecret: !!yt.clientSecret, hasKey: !!yt.apiKey },
      lastfm: { apiKey: lf.apiKey || '', hasSecret: !!lf.secret },
      apple: { hasToken: !!am.developerToken },
    };
    return s;
  }

  async connect(service) {
    if (service === 'spotify') await this.connectSpotify();
    else if (service === 'youtube') await this.connectGoogle();
    else if (service === 'lastfm') await this.connectLastfm();
    else throw new Error(`Unknown service ${service}`);
    this.onChange();
    return this.status();
  }

  disconnect(service) {
    this.setTok(service, undefined);
    this.onChange();
    return this.status();
  }

  pkce() {
    const verifier = b64url(crypto.randomBytes(48));
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
    const state = b64url(crypto.randomBytes(16));
    return { verifier, challenge, state };
  }

  async connectSpotify() {
    const { clientId } = this.config('spotify');
    if (!clientId) throw new Error('Add your Spotify Client ID first.');
    const { verifier, challenge, state } = this.pkce();
    const redirect = `${this.redirectBase}/spotify`;
    const url = new URL('https://accounts.spotify.com/authorize');
    url.search = new URLSearchParams({
      client_id: clientId, response_type: 'code', redirect_uri: redirect,
      code_challenge_method: 'S256', code_challenge: challenge, scope: SPOTIFY_SCOPES, state,
    });
    const wait = this.server.waitForCallback('spotify', state);
    await shell.openExternal(url.toString());
    const params = await wait;
    if (params.get('error')) throw new Error(`Spotify: ${params.get('error')}`);
    const t = await postForm('https://accounts.spotify.com/api/token', {
      grant_type: 'authorization_code', code: params.get('code'), redirect_uri: redirect,
      client_id: clientId, code_verifier: verifier,
    });
    const tok = { access_token: t.access_token, refresh_token: t.refresh_token, expires_at: Date.now() + t.expires_in * 1000 };
    try {
      const me = await net.fetch('https://api.spotify.com/v1/me', { headers: { authorization: `Bearer ${tok.access_token}` } }).then((r) => r.json());
      tok.user = { id: me.id, name: me.display_name || me.id, image: me.images?.[0]?.url || null };
    } catch { /* profile is cosmetic */ }
    this.setTok('spotify', tok);
  }

  async connectGoogle() {
    const { clientId, clientSecret } = this.config('youtube');
    if (!clientId || !clientSecret) throw new Error('Add your Google OAuth client ID and secret first.');
    const { verifier, challenge, state } = this.pkce();
    const redirect = `${this.redirectBase}/google`;
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.search = new URLSearchParams({
      client_id: clientId, redirect_uri: redirect, response_type: 'code',
      scope: 'https://www.googleapis.com/auth/youtube.readonly',
      code_challenge: challenge, code_challenge_method: 'S256', state,
      access_type: 'offline', prompt: 'consent',
    });
    const wait = this.server.waitForCallback('google', state);
    await shell.openExternal(url.toString());
    const params = await wait;
    if (params.get('error')) throw new Error(`Google: ${params.get('error')}`);
    const t = await postForm('https://oauth2.googleapis.com/token', {
      client_id: clientId, client_secret: clientSecret, code: params.get('code'),
      code_verifier: verifier, grant_type: 'authorization_code', redirect_uri: redirect,
    });
    const tok = { access_token: t.access_token, refresh_token: t.refresh_token, expires_at: Date.now() + t.expires_in * 1000 };
    try {
      const me = await net.fetch('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true', {
        headers: { authorization: `Bearer ${tok.access_token}` },
      }).then((r) => r.json());
      const ch = me.items?.[0];
      if (ch) tok.user = { id: ch.id, name: ch.snippet.title, image: ch.snippet.thumbnails?.default?.url || null };
    } catch { /* cosmetic */ }
    this.setTok('youtube', tok);
  }

  async connectLastfm() {
    const { apiKey, secret } = this.config('lastfm');
    if (!apiKey || !secret) throw new Error('Add your Last.fm API key and shared secret first.');
    const redirect = `${this.redirectBase}/lastfm`;
    const wait = this.server.waitForCallback('lastfm', null);
    await shell.openExternal(`https://www.last.fm/api/auth/?api_key=${encodeURIComponent(apiKey)}&cb=${encodeURIComponent(redirect)}`);
    const params = await wait;
    const token = params.get('token');
    if (!token) throw new Error('Last.fm did not return a token.');
    const q = { method: 'auth.getSession', api_key: apiKey, token };
    q.api_sig = lastfmSign(q, secret);
    q.format = 'json';
    const data = await net.fetch(`https://ws.audioscrobbler.com/2.0/?${new URLSearchParams(q)}`).then((r) => r.json());
    if (!data.session) throw new Error(data.message || 'Last.fm sign-in failed.');
    this.setTok('lastfm', { sk: data.session.key, name: data.session.name });
  }

  setAppleUserToken(userToken) {
    this.setTok('apple', userToken ? { userToken } : undefined);
    this.onChange();
    return this.status();
  }

  // Returns a valid access token, refreshing when it is about to expire.
  async token(service, force = false) {
    if (service === 'apple') return { developerToken: this.config('apple').developerToken, userToken: this.tok('apple')?.userToken };
    const t = this.tok(service);
    if (!t?.refresh_token) return null;
    if (!force && t.expires_at - Date.now() > 60_000) return t.access_token;
    if (this.refreshing.has(service)) return this.refreshing.get(service);
    const job = (async () => {
      try {
        let r;
        if (service === 'spotify') {
          r = await postForm('https://accounts.spotify.com/api/token', {
            grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: this.config('spotify').clientId,
          });
        } else if (service === 'youtube') {
          const c = this.config('youtube');
          r = await postForm('https://oauth2.googleapis.com/token', {
            grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: c.clientId, client_secret: c.clientSecret,
          });
        } else return null;
        const next = { ...t, access_token: r.access_token, expires_at: Date.now() + r.expires_in * 1000 };
        if (r.refresh_token) next.refresh_token = r.refresh_token;
        this.setTok(service, next);
        return next.access_token;
      } catch (err) {
        if (/invalid_grant|revoked/i.test(String(err.message))) { this.setTok(service, undefined); this.onChange(); }
        throw err;
      } finally {
        this.refreshing.delete(service);
      }
    })();
    this.refreshing.set(service, job);
    return job;
  }
}
