// Loopback HTTP server. Serving the UI from http://127.0.0.1 (instead of file://) is what lets
// YouTube/SoundCloud embeds identify the page, and it doubles as the OAuth redirect target
// and a range-capable streamer for local audio files.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { net } from 'electron';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.mp4': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.wav': 'audio/wav',
  '.webm': 'audio/webm',
};

const CSP = [
  "default-src 'self'",
  "script-src 'self' https://www.youtube.com https://s.ytimg.com https://w.soundcloud.com https://sdk.scdn.co https://js-cdn.music.apple.com",
  "style-src 'self' 'unsafe-inline'",
  "img-src * data: blob:",
  "media-src 'self' blob: https:",
  "font-src 'self'",
  "connect-src 'self' https: wss:",
  "frame-src https://www.youtube.com https://www.youtube-nocookie.com https://w.soundcloud.com https://sdk.scdn.co https://*.spotify.com https://*.apple.com",
  "object-src 'none'",
  "base-uri 'none'",
].join('; ');

// Hosts the preview proxy may fetch from (30-second previews from Deezer and Apple).
const PROXY_HOSTS = [/(^|\.)dzcdn\.net$/, /(^|\.)deezer\.com$/, /(^|\.)mzstatic\.com$/, /^audio-ssl\.itunes\.apple\.com$/];

const DONE_PAGE = (ok, msg) => `<!doctype html><meta charset="utf-8"><title>MusicForge</title>
<style>body{font:16px system-ui,sans-serif;background:#1b1e25;color:#ece8e1;display:grid;place-items:center;height:100vh;margin:0}
p{max-width:28rem;text-align:center;line-height:1.5}b{color:${ok ? '#e9b949' : '#e5675a'}}</style>
<p><b>${ok ? 'Connected.' : 'Sign-in failed.'}</b><br>${msg}</p>`;

function parseRange(header, size) {
  const m = /bytes=(\d*)-(\d*)/.exec(header || '');
  if (!m) return null;
  let start = m[1] === '' ? null : Number(m[1]);
  let end = m[2] === '' ? null : Number(m[2]);
  if (start === null) { start = size - end; end = size - 1; }
  if (end === null || end >= size) end = size - 1;
  if (start > end || start < 0) return 'invalid';
  return { start, end };
}

export function startServer({ port, root, token, library }) {
  const pending = new Map();
  let origin = '';

  const server = http.createServer(async (req, res) => {
    try {
      // DNS-rebinding guard: only answer requests addressed to our loopback origin.
      const host = req.headers.host || '';
      if (!/^127\.0\.0\.1(:\d+)?$/.test(host)) { res.writeHead(403); return res.end(); }
      const url = new URL(req.url, origin);
      const p = url.pathname;

      if (p.startsWith('/callback/')) {
        const provider = p.slice('/callback/'.length);
        const entry = pending.get(provider);
        const params = url.searchParams;
        if (!entry || (entry.state && params.get('state') !== entry.state)) {
          res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
          return res.end(DONE_PAGE(false, 'This sign-in link expired. Start again from MusicForge.'));
        }
        pending.delete(provider);
        clearTimeout(entry.timer);
        const failed = params.get('error');
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(DONE_PAGE(!failed, failed ? `The service said: ${failed}.` : 'You can close this tab and go back to MusicForge.'));
        return entry.resolve(params);
      }

      if (p === '/media' || p === '/cover' || p === '/proxy') {
        if (url.searchParams.get('t') !== token) { res.writeHead(403); return res.end(); }
        if (p === '/media') return serveFile(req, res, library.pathFor(url.searchParams.get('id')));
        if (p === '/cover') return serveCover(res, url.searchParams.get('id'));
        return proxy(req, res, url.searchParams.get('u'));
      }

      // Static UI.
      const rel = decodeURIComponent(p === '/' ? '/index.html' : p);
      const file = path.normalize(path.join(root, rel));
      if (!file.startsWith(root + path.sep)) { res.writeHead(403); return res.end(); }
      const ext = path.extname(file);
      let data;
      try { data = await fs.promises.readFile(file); } catch { res.writeHead(404); return res.end(); }
      const headers = {
        'content-type': MIME[ext] || 'application/octet-stream',
        'cache-control': ext === '.woff2' || ext === '.png' ? 'max-age=604800' : 'no-cache',
        'x-content-type-options': 'nosniff',
      };
      if (ext === '.html') {
        headers['content-security-policy'] = CSP;
        headers['referrer-policy'] = 'strict-origin-when-cross-origin';
      }
      res.writeHead(200, headers);
      res.end(data);
    } catch (err) {
      console.error('[server]', err);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  });

  async function serveFile(req, res, file) {
    if (!file) { res.writeHead(404); return res.end(); }
    let stat;
    try { stat = await fs.promises.stat(file); } catch { res.writeHead(404); return res.end(); }
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const range = parseRange(req.headers.range, stat.size);
    if (range === 'invalid') { res.writeHead(416, { 'content-range': `bytes */${stat.size}` }); return res.end(); }
    if (range) {
      res.writeHead(206, {
        'content-type': type,
        'accept-ranges': 'bytes',
        'content-length': range.end - range.start + 1,
        'content-range': `bytes ${range.start}-${range.end}/${stat.size}`,
      });
      fs.createReadStream(file, { start: range.start, end: range.end }).pipe(res);
    } else {
      res.writeHead(200, { 'content-type': type, 'accept-ranges': 'bytes', 'content-length': stat.size });
      fs.createReadStream(file).pipe(res);
    }
  }

  async function serveCover(res, id) {
    const cover = await library.cover(id);
    if (!cover) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': cover.format || 'image/jpeg', 'cache-control': 'max-age=86400' });
    res.end(cover.data);
  }

  async function proxy(req, res, target) {
    let u;
    try { u = new URL(target); } catch { res.writeHead(400); return res.end(); }
    if (u.protocol !== 'https:' || !PROXY_HOSTS.some((re) => re.test(u.hostname))) { res.writeHead(403); return res.end(); }
    const headers = {};
    if (req.headers.range) headers.range = req.headers.range;
    const upstream = await net.fetch(u.toString(), { headers });
    const out = {};
    for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
      const v = upstream.headers.get(h);
      if (v) out[h] = v;
    }
    res.writeHead(upstream.status, out);
    if (!upstream.body) return res.end();
    Readable.fromWeb(upstream.body).on('error', () => res.destroy()).pipe(res);
  }

  function waitForCallback(provider, state, timeoutMs = 5 * 60 * 1000) {
    const old = pending.get(provider);
    if (old) { clearTimeout(old.timer); old.reject(new Error('Sign-in restarted')); }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(provider); reject(new Error('Sign-in timed out')); }, timeoutMs);
      pending.set(provider, { state, resolve, reject, timer });
    });
  }

  return new Promise((resolve, reject) => {
    const tryListen = (p, fallback) => {
      server.once('error', (err) => {
        if (fallback && err.code === 'EADDRINUSE') tryListen(0, false);
        else reject(err);
      });
      server.listen(p, '127.0.0.1', () => {
        const actual = server.address().port;
        origin = `http://127.0.0.1:${actual}`;
        if (actual !== port) console.warn(`[server] port ${port} busy, using ${actual}. Spotify sign-in needs ${port}.`);
        const cancel = (provider) => {
          const entry = pending.get(provider);
          if (!entry) return false;
          pending.delete(provider);
          clearTimeout(entry.timer);
          entry.reject(new Error('Sign-in cancelled'));
          return true;
        };
        resolve({ origin, port: actual, waitForCallback, cancel, close: () => server.close() });
      });
    };
    tryListen(port, true);
  });
}
