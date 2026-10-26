// Accounts: guided setup. Every step that needs a website has a button that opens the exact
// page; keys are pasted with one click and checked against the service straight away.
import { h, icon, clear } from '../util.js';
import { state, mf, on, refreshAuth } from '../state.js';
import { apple, api } from '../services.js';
import { go } from '../router.js';
import { toast, confirm } from '../ui/components.js';

const open = (url) => mf.invoke('shell:open', url);
const cleanErr = (err) => String(err?.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

const URLS = {
  spotifyDash: 'https://developer.spotify.com/dashboard',
  gProject: 'https://console.cloud.google.com/projectcreate',
  gYouTubeApi: 'https://console.cloud.google.com/apis/library/youtube.googleapis.com',
  gCredentials: 'https://console.cloud.google.com/apis/credentials',
  gConsent: 'https://console.cloud.google.com/apis/credentials/consent',
  lastfmCreate: 'https://www.last.fm/api/account/create',
};

// ---------------------------------------------------------------- building blocks
function step(n, title, detail, ...actions) {
  return h('li', { class: 'g-step' },
    h('span', { class: 'g-n', 'aria-hidden': 'true' }, n),
    h('div', { class: 'g-body' }, h('div', { class: 'g-t' }, title), detail ? h('div', { class: 'g-d' }, detail) : null),
    actions.length ? h('div', { class: 'g-act' }, ...actions) : null);
}
const openBtn = (url, text = 'Open page') => h('button', { class: 'btn small ghost', onclick: () => open(url) }, text, icon('external', 14));
const copyBtn = (text) => h('button', {
  class: 'btn small ghost',
  onclick: async (e) => {
    const b = e.currentTarget;
    try { await navigator.clipboard.writeText(text); b.replaceChildren(icon('check', 14), 'Copied'); setTimeout(() => b.replaceChildren('Copy'), 1800); } catch { toast('Copy failed. Select the text and press Ctrl+C.', 'error'); }
  },
}, 'Copy');

// A key box with a Paste button. `clean` normalises whatever was pasted.
function keyField({ label, placeholder, saved, secret = false, clean = (v) => v.trim().replace(/^["']|["']$/g, '') }) {
  const input = h('input', { class: 'input', type: secret ? 'password' : 'text', placeholder: saved ? 'Saved. Paste a new one to replace it.' : placeholder, autocomplete: 'off', spellcheck: false });
  input.addEventListener('paste', () => setTimeout(() => { input.value = clean(input.value); input.dispatchEvent(new Event('change')); }, 0));
  const paste = h('button', { class: 'btn ghost', onclick: async () => {
    const text = clean(await mf.invoke('clipboard:read'));
    if (!text) { toast('Your clipboard is empty. Copy the key first.', 'error'); return; }
    input.value = text;
    input.dispatchEvent(new Event('change'));
  } }, icon('import', 15), 'Paste');
  const el = h('div', { class: 'field' }, h('label', null, label), h('div', { class: 'key-row' }, input, paste));
  return { el, input, value: () => clean(input.value) };
}

// Status line under a form. Messages are kept per key so they survive the screen redrawing
// when account status changes.
const messages = new Map();
function result(key) {
  const el = h('div', { class: 'g-result', role: 'status', hidden: true });
  const set = (kind, nodes) => {
    if (!kind) { el.hidden = true; messages.delete(key); return; }
    el.hidden = false;
    el.className = `g-result ${kind}`;
    el.replaceChildren(...nodes);
    if (kind !== 'wait') messages.set(key, { kind, nodes });
  };
  const r = {
    el,
    ok(text) { set('ok', [icon('check', 16), h('span', null, text)]); },
    err(text, fix) { set('err', [icon('close', 16), h('span', null, text), fix || '']); },
    wait(text, ...extra) { set('wait', [h('span', { class: 'g-spin' }), h('span', null, text), ...extra]); },
    clear() { set(null); },
  };
  const prev = messages.get(key);
  if (prev) set(prev.kind, prev.nodes);
  return r;
}

// Runs a browser sign-in with a visible "waiting" state, a Cancel button and a hint for when it stalls.
async function browserSignIn(svc, res, hint) {
  const cancel = h('button', { class: 'btn small ghost', onclick: () => mf.invoke('auth:cancel', svc) }, 'Cancel');
  res.wait('Finish signing in in your browser, then come back here.', cancel);
  const slow = setTimeout(() => { if (!res.el.hidden && res.el.classList.contains('wait')) res.wait(hint, cancel); }, 25000);
  try {
    state.auth = await mf.invoke('auth:connect', svc);
    return true;
  } catch (err) {
    const msg = cleanErr(err);
    if (/cancelled|restarted/i.test(msg)) res.clear(); else res.err(msg);
    return false;
  } finally {
    clearTimeout(slow);
    refreshAuth();
  }
}

// ---------------------------------------------------------------- checks against the real services
async function checkYouTubeKey() {
  try {
    await api('youtube', '/videos', { query: { part: 'id', id: 'jNQXAC9IVRw' } });
    return { ok: true };
  } catch (err) {
    const m = err.message || '';
    const fix = /(https:\/\/console\.(?:developers|cloud)\.google\.com\/[^\s"]+)/.exec(m)?.[1];
    if (/API key not valid|API_KEY_INVALID/i.test(m)) return { ok: false, text: 'Google says this key isn’t valid. Copy it again from the Credentials page.' };
    if (/has not been used|is disabled|SERVICE_DISABLED|accessNotConfigured/i.test(m)) {
      return { ok: false, text: 'The key works, but YouTube Data API v3 isn’t turned on for its project. Turn it on, wait a minute, then check again.', fix: fix || URLS.gYouTubeApi, fixText: 'Turn it on' };
    }
    if (/referer|blocked|API_KEY_.*_BLOCKED/i.test(m)) return { ok: false, text: 'This key has restrictions that block MusicForge. In Credentials, edit the key and set Application restrictions to None.', fix: URLS.gCredentials, fixText: 'Open Credentials' };
    if (/quota/i.test(m)) return { ok: true, note: 'Key works. Today’s free quota is used up; it resets at midnight Pacific time.' };
    if (err.code === 'offline') return { ok: false, offline: true, text: 'Saved, but MusicForge couldn’t reach YouTube to check it. Check your connection and press Check again.' };
    return { ok: false, text: m };
  }
}

async function checkLastfmKey() {
  try {
    await api('lastfm', '', { query: { method: 'artist.getInfo', artist: 'Radiohead' } });
    return { ok: true };
  } catch (err) {
    return { ok: false, text: /invalid api key/i.test(err.message) ? 'Last.fm says this API key isn’t valid. Copy it again from your API account page.' : err.message };
  }
}

function parseGoogleClient(text) {
  try {
    const j = JSON.parse(text);
    const c = j.installed || j.web || j;
    if (!c.client_id || !c.client_secret) return { error: 'That file has no client ID and secret in it.' };
    if (j.web) return { error: 'That client is a “Web application”. Create one of type “Desktop app” instead.' };
    return { clientId: c.client_id, clientSecret: c.client_secret };
  } catch {
    return { error: 'That isn’t the JSON file Google gives you. Use the download button next to your Desktop client.' };
  }
}

// ---------------------------------------------------------------- view
export function render() {
  const list = h('div', { class: 'svc-list' });
  const view = h('div', { class: 'view' },
    h('div', { class: 'view-head' }, h('div', null, h('h1', { class: 't-display' }, 'Accounts'),
      h('p', { class: 't-sub' }, 'Spotify, Google and Last.fm need a free developer key from you, made once in a couple of minutes. Each setup below opens the right pages and checks your key as soon as you paste it.'))),
    list);
  const openSet = new Set();
  let moreOpen = null; // remembers the optional YouTube sign-in section across redraws
  const draw = () => {
    const a = state.auth;
    clear(list).append(
      service('spotify', 'Spotify', 'Your playlists, liked songs, top artists and playback.',
        a.spotify.connected ? `Signed in${a.spotify.user ? ` as ${a.spotify.user.name}` : ''}` : a.spotify.configured ? 'Ready to sign in' : 'Not set up',
        a.spotify.connected, () => spotifySetup(a)),
      service('youtube', 'YouTube & YouTube Music', 'Music videos, YouTube search, your playlists and liked videos.',
        a.youtube.connected ? `Signed in${a.youtube.user ? ` as ${a.youtube.user.name}` : ''}` : a.youtube.hasKey ? 'Search and videos on' : 'Not set up',
        a.youtube.connected || a.youtube.hasKey, () => youtubeSetup(a)),
      service('lastfm', 'Last.fm', 'Scrobble what you play, your all-time stats, listener counts for artists.',
        a.lastfm.connected ? `Scrobbling as ${a.lastfm.user?.name}` : a.lastfm.configured ? 'Key added. Sign in to scrobble' : 'Not set up',
        a.lastfm.connected, () => lastfmSetup(a)),
      service('apple', 'Apple Music', 'Import your Apple Music library playlists. Apple catalogue search and previews already work.',
        a.apple.connected ? 'Signed in' : a.apple.configured ? 'Token added. Sign in' : 'Optional', a.apple.connected, () => appleSetup(a)),
      service('soundcloud', 'SoundCloud', 'Paste any SoundCloud track link into search to play it or add it to a playlist.', 'Works without an account', true),
      service('deezer', 'Deezer', 'Charts, artist fan counts, search, 30-second previews and public playlists by link.', 'Works without an account', true),
      service('local', 'Local files', 'MP3, FLAC, M4A, OGG, Opus and WAV from your folders, with full visualizer support.',
        `${state.library.tracks.length.toLocaleString()} songs`, state.library.tracks.length > 0,
        () => [h('div', null, h('button', { class: 'btn ghost', onclick: () => go('library', { tab: 'folders' }) }, icon('folder', 16), 'Manage folders'))]),
    );
    if (!a.encrypted) list.append(h('p', { class: 'note', style: { marginTop: '14px' } }, 'Your system keyring isn’t available, so keys are stored in a local file without OS encryption.'));
  };

  function service(id, name, desc, status, ok, setup) {
    const isOpen = openSet.has(id);
    const toggle = () => { if (openSet.has(id)) openSet.delete(id); else openSet.add(id); draw(); };
    const row = h('div', { class: 'svc-row' },
      h('span', { class: `svc-dot src-${id}`, style: { background: 'var(--src)' } }),
      h('div', null,
        h('div', { class: 'svc-name' }, name, h('span', { class: `svc-status ${ok ? 'ok' : ''}` }, ok ? icon('check', 14) : null, status)),
        h('div', { class: 'svc-desc' }, desc)),
      setup ? h('button', { class: `btn small ${!ok && !isOpen ? 'primary' : 'ghost'}`, 'aria-expanded': isOpen, onclick: toggle }, isOpen ? 'Close' : ok ? 'Manage' : 'Set up') : null);
    return h('div', { class: 'svc' }, row, isOpen && setup ? h('div', { class: 'svc-setup' }, setup()) : null);
  }

  // Sign out / forget keys row shared by the services.
  function manageRow(svc, st) {
    const out = st.connected ? h('button', { class: 'btn small ghost danger', onclick: async () => {
      if (!(await confirm({ title: 'Sign out?', text: 'MusicForge forgets this sign-in. Your key stays saved, and imported playlists stay in MusicForge.', ok: 'Sign out' }))) return;
      state.auth = await mf.invoke('auth:disconnect', svc); await refreshAuth(); draw();
    } }, 'Sign out') : null;
    const forget = st.configured || st.hasKey ? h('button', { class: 'btn small ghost', onclick: async () => {
      if (!(await confirm({ title: 'Forget saved keys?', text: 'This removes the keys you entered for this service and signs you out.', ok: 'Forget keys' }))) return;
      await mf.invoke('auth:disconnect', svc); state.auth = await mf.invoke('auth:config', svc, null); await refreshAuth(); draw();
    } }, 'Forget keys') : null;
    return out || forget ? h('div', { class: 'row g-manage' }, out, forget) : null;
  }

  // -------------------------------------------------------------- Spotify
  function spotifySetup(a) {
    const res = result('spotify');
    const id = keyField({ label: 'Client ID', placeholder: '32 letters and numbers, e.g. 1a2b3c…', saved: !!a.config.spotify.clientId, clean: (v) => v.trim().replace(/[^0-9a-f]/gi, '') });
    if (a.config.spotify.clientId) id.input.value = a.config.spotify.clientId;
    const signIn = h('button', { class: 'btn primary', onclick: async () => {
      const v = id.value();
      if (!/^[0-9a-f]{32}$/i.test(v)) { res.err('A Spotify Client ID is 32 letters and numbers. Copy it from your app’s Settings page.'); return; }
      state.auth = await mf.invoke('auth:config', 'spotify', { clientId: v });
      signIn.disabled = true;
      const ok = await browserSignIn('spotify', res, `Taking a while? If Spotify shows “INVALID_CLIENT: Invalid redirect URI”, add ${a.spotify.redirect} to your app exactly as shown in step 2, save, and try again.`);
      signIn.disabled = false;
      if (ok) { toast('Spotify linked'); draw(); }
    } }, a.spotify.connected ? 'Sign in again' : 'Sign in with Spotify');
    return [
      h('ol', { class: 'guide' },
        step(1, 'Create a Spotify app', 'Log in and choose Create app. Name and description can be anything.', openBtn(URLS.spotifyDash, 'Open Spotify dashboard')),
        step(2, 'Add this Redirect URI', h('span', null, h('code', { class: 'inline' }, a.spotify.redirect), ' Paste it under Redirect URIs and press Add. Under APIs, tick Web API, then Save.'), copyBtn(a.spotify.redirect)),
        step(3, 'Paste your Client ID', 'It’s at the top of your app’s Settings page.')),
      h('div', { class: 'g-form' }, id.el, h('div', { class: 'row' }, signIn), res.el),
      h('p', { class: 'note' }, 'Spotify requires the app’s owner to have Premium. Songs play through the Spotify app on this PC or your phone, so keep Spotify open somewhere.'),
      manageRow('spotify', a.spotify),
    ];
  }

  // -------------------------------------------------------------- YouTube
  function youtubeSetup(a) {
    const res = result('youtube');
    const key = keyField({ label: 'API key', placeholder: 'Starts with AIza…', saved: a.youtube.hasKey, secret: a.youtube.hasKey, clean: (v) => (v.match(/AIza[0-9A-Za-z_-]{35}/) || [v.trim()])[0] });
    const check = h('button', { class: 'btn primary', onclick: async () => {
      const v = key.value();
      if (!v && !a.youtube.hasKey) { res.err('Paste your API key first.'); return; }
      if (v && !/^AIza[0-9A-Za-z_-]{35}$/.test(v)) { res.err('That doesn’t look like a Google API key. They start with “AIza” and are 39 characters long.'); return; }
      check.disabled = true;
      res.wait('Checking your key with YouTube…');
      const prev = a.youtube.hasKey;
      if (v) state.auth = await mf.invoke('auth:config', 'youtube', { apiKey: v });
      const r = await checkYouTubeKey();
      check.disabled = false;
      if (r.ok) {
        await refreshAuth();
        res.ok(r.note || 'Key works. YouTube search, music videos and full-length matches are on.');
        if (!prev) toast('YouTube search is on');
      } else {
        if (v && !prev && !r.offline) { state.auth = await mf.invoke('auth:config', 'youtube', { apiKey: null }); await refreshAuth(); }
        res.err(r.text, r.fix ? h('button', { class: 'btn small ghost', onclick: () => open(r.fix) }, r.fixText, icon('external', 14)) : null);
      }
    } }, a.youtube.hasKey ? 'Check again' : 'Check and save');

    // Optional: Google sign-in for playlists and likes.
    const signRes = result('google');
    let client = a.youtube.configured ? { saved: true } : null;
    const clientLine = h('div', { class: 'g-client' });
    const paintClient = () => clientLine.replaceChildren(client
      ? h('div', { class: 'g-result ok' }, icon('check', 16), h('span', null, client.saved ? 'Google client saved. Now sign in.' : 'Client loaded from file.'))
      : h('span', { class: 'faint' }, 'No client loaded yet.'));
    paintClient();
    const useClient = async (text) => {
      const c = parseGoogleClient(text);
      if (c.error) { signRes.err(c.error); return; }
      state.auth = await mf.invoke('auth:config', 'youtube', c);
      client = c;
      signRes.clear();
      paintClient();
    };
    const pickFile = h('button', { class: 'btn ghost', onclick: async () => { const t = await mf.invoke('auth:googleClientFile'); if (t) useClient(t); } }, icon('folder', 15), 'Choose downloaded file');
    const pasteJson = h('button', { class: 'btn ghost', onclick: async () => {
      const t = await mf.invoke('clipboard:read');
      if (!t.trim().startsWith('{')) { signRes.err('Your clipboard doesn’t contain the client JSON. Use “Choose downloaded file” instead.'); return; }
      useClient(t);
    } }, 'Paste JSON');
    const googleSignIn = h('button', { class: 'btn primary', onclick: async () => {
      if (!client) { signRes.err('Load your Desktop client file first (step 3).'); return; }
      googleSignIn.disabled = true;
      const ok = await browserSignIn('youtube', signRes, 'Taking a while? If Google says “Access blocked”, add your Google address as a test user (step 2). If it says the app isn’t verified, choose Continue; it’s your own app.');
      googleSignIn.disabled = false;
      if (ok) { toast('YouTube account linked'); draw(); }
    } }, a.youtube.connected ? 'Sign in again' : 'Sign in with Google');

    const advanced = h('details', { class: 'g-more', open: (moreOpen ?? (a.youtube.configured || a.youtube.connected)) || undefined, ontoggle: (e) => { moreOpen = e.currentTarget.open; } },
      h('summary', null, 'Also show my YouTube playlists and liked videos (optional, about 3 more minutes)'),
      h('ol', { class: 'guide' },
        step(1, 'Set up Google sign-in for your project', 'Choose Get started. App name: MusicForge. Use your email for both contact fields. Audience: External. Then Create.', openBtn(URLS.gConsent, 'Open sign-in setup')),
        step(2, 'Add yourself as a test user', 'Still in Google Auth Platform: open Audience, then under Test users choose Add users and enter your Google address.'),
        step(3, 'Create a Desktop client and download it', 'Create credentials → OAuth client ID → Application type “Desktop app” → Create. In the box that appears, choose Download JSON.', openBtn(URLS.gCredentials, 'Open Credentials')),
        step(4, 'Load that file here, then sign in', null)),
      h('div', { class: 'g-form' }, clientLine, h('div', { class: 'row' }, pickFile, pasteJson, googleSignIn), signRes.el));

    return [
      h('ol', { class: 'guide' },
        step(1, 'Create a Google Cloud project', 'Any name works. Skip this if you already have a project.', openBtn(URLS.gProject, 'Open Google Cloud')),
        step(2, 'Turn on YouTube Data API v3', 'Make sure your project is selected at the top, then press Enable.', openBtn(URLS.gYouTubeApi, 'Open API page')),
        step(3, 'Create an API key', 'Choose Create credentials → API key, then copy the key it shows you.', openBtn(URLS.gCredentials, 'Open Credentials')),
        step(4, 'Paste it and check it')),
      h('div', { class: 'g-form' }, key.el, h('div', { class: 'row' }, check), res.el),
      h('p', { class: 'note' }, 'Free. Google allows 10,000 units a day and a search costs 100. MusicForge only searches YouTube when you ask, or to find a full-length song no other source has, and remembers every match.'),
      advanced,
      manageRow('youtube', a.youtube),
    ];
  }

  // -------------------------------------------------------------- Last.fm
  function lastfmSetup(a) {
    const res = result('lastfm');
    const hex = (v) => (v.match(/[0-9a-f]{32}/i) || [v.trim()])[0];
    const key = keyField({ label: 'API key', placeholder: '32 letters and numbers', saved: !!a.config.lastfm.apiKey, clean: hex });
    if (a.config.lastfm.apiKey) key.input.value = a.config.lastfm.apiKey;
    const secret = keyField({ label: 'Shared secret', placeholder: '32 letters and numbers', saved: a.config.lastfm.hasSecret, secret: true, clean: hex });
    const go1 = h('button', { class: 'btn primary', onclick: async () => {
      const k = key.value(); const s = secret.value();
      if (!/^[0-9a-f]{32}$/i.test(k)) { res.err('The API key is 32 letters and numbers. Copy it from the page Last.fm showed after creating the account.'); return; }
      if (s && !/^[0-9a-f]{32}$/i.test(s)) { res.err('The shared secret is 32 letters and numbers, shown right under the API key.'); return; }
      if (!s && !a.config.lastfm.hasSecret) { res.err('Paste the shared secret too. It’s right under the API key.'); return; }
      if (s && s.toLowerCase() === k.toLowerCase()) { res.err('The key and the secret are the same. Copy the shared secret, which is the second value.'); return; }
      go1.disabled = true;
      res.wait('Checking your key with Last.fm…');
      state.auth = await mf.invoke('auth:config', 'lastfm', s ? { apiKey: k, secret: s } : { apiKey: k });
      const r = await checkLastfmKey();
      if (!r.ok) { go1.disabled = false; res.err(r.text); return; }
      const ok = await browserSignIn('lastfm', res, 'Taking a while? Choose “Yes, allow access” on the Last.fm page, then come back here.');
      go1.disabled = false;
      if (ok) { toast('Last.fm linked. Scrobbling is on.'); draw(); }
    } }, a.lastfm.connected ? 'Sign in again' : 'Check and sign in');
    return [
      h('ol', { class: 'guide' },
        step(1, 'Create a Last.fm API account', 'Application name: MusicForge. Leave Callback URL empty. Submit, and Last.fm shows your API key and shared secret.', openBtn(URLS.lastfmCreate, 'Open Last.fm')),
        step(2, 'Paste both values and sign in')),
      h('div', { class: 'g-form' }, h('div', { class: 'fields' }, key.el, secret.el), h('div', { class: 'row' }, go1), res.el),
      h('p', { class: 'note' }, 'Last.fm only shows the secret once. If you lost it, open last.fm/api/accounts to see it again.'),
      manageRow('lastfm', a.lastfm),
    ];
  }

  // -------------------------------------------------------------- Apple Music
  function appleSetup(a) {
    const res = result('apple');
    const ta = h('textarea', { class: 'input', placeholder: a.config.apple.hasToken ? 'Token saved. Paste a new one to replace it.' : 'eyJhbGciOiJFUzI1NiIs…', spellcheck: false });
    return [
      h('p', { class: 'note' }, 'This one needs an Apple Developer Program membership, which is how Apple issues MusicKit tokens. If you have one, generate a MusicKit developer token and paste it here. Apple songs play through your other sources, because Apple doesn’t allow its streams in other desktop apps.'),
      h('div', { class: 'field' }, h('label', null, 'MusicKit developer token'), ta),
      h('div', { class: 'row' },
        h('button', { class: 'btn ghost', onclick: async () => { ta.value = (await mf.invoke('clipboard:read')).trim(); } }, icon('import', 15), 'Paste'),
        h('button', { class: 'btn primary', onclick: async () => {
          try {
            const t = ta.value.trim();
            if (t && t.split('.').length !== 3) { res.err('That isn’t a developer token. It should be a long text with two dots in it (a JWT).'); return; }
            if (t) state.auth = await mf.invoke('auth:config', 'apple', { developerToken: t });
            res.wait('Finish signing in in the Apple window…');
            await apple.authorize();
            res.ok('Apple Music linked.');
            toast('Apple Music linked');
          } catch (err) { res.err(cleanErr(err)); }
          await refreshAuth(); draw();
        } }, 'Sign in with Apple Music'),
        a.apple.connected ? h('button', { class: 'btn ghost danger', onclick: async () => { await mf.invoke('auth:appleUserToken', null); await refreshAuth(); draw(); } }, 'Sign out') : null),
      res.el,
    ];
  }

  messages.clear();
  draw();
  const off = on('auth', () => view.isConnected && !view.querySelector('.g-result.wait') && draw());
  return { el: view, cleanup: off };
}
