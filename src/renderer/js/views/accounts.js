import { h, icon, clear } from '../util.js';
import { state, mf, on, refreshAuth } from '../state.js';
import { apple } from '../services.js';
import { go } from '../router.js';
import { toast, confirm } from '../ui/components.js';

const link = (url, text) => h('a', { href: url, onclick: (e) => { e.preventDefault(); mf.invoke('shell:open', url); } }, text || url);
const code = (t) => h('code', null, t);

export function render() {
  const list = h('div', { class: 'svc-list' });
  const view = h('div', { class: 'view' },
    h('div', { class: 'view-head' }, h('div', null, h('h1', { class: 't-display' }, 'Accounts'),
      h('p', { class: 't-sub' }, 'Each service is linked with your own free developer key, so your data goes straight between this PC and the service. Keys and sign-ins are stored encrypted on this computer.'))),
    list);
  const open = new Set();
  const draw = () => {
    const a = state.auth;
    clear(list).append(
      service({
        id: 'spotify', name: 'Spotify', open,
        desc: 'Your playlists, liked songs, top artists and playback.',
        status: a.spotify.connected ? `Signed in${a.spotify.user ? ` as ${a.spotify.user.name}` : ''}` : a.spotify.configured ? 'Ready to sign in' : 'Not set up',
        ok: a.spotify.connected,
        setup: () => [
          h('ol', { class: 'steps' },
            h('li', null, 'Open the ', link('https://developer.spotify.com/dashboard', 'Spotify developer dashboard'), ' and choose Create app. Any name works.'),
            h('li', null, 'Under Redirect URIs add ', code(a.spotify.redirect), '. It must match exactly.'),
            h('li', null, 'Tick Web API and Web Playback SDK, then save.'),
            h('li', null, 'Copy the Client ID into the box below and choose Sign in.')),
          h('p', { class: 'note' }, 'Spotify requires the app owner to have Premium for developer apps, and allows five users per app. If you sign in with a different Spotify account than the one that owns the app, add it under User Management in the dashboard. Playback goes through the Spotify app on this PC or your phone (Spotify Connect) unless this build has in-app DRM; see Settings → Playback.'),
          form([{ key: 'clientId', label: 'Client ID', value: a.config.spotify.clientId }], 'spotify', a.spotify),
        ],
      }),
      service({
        id: 'youtube', name: 'YouTube & YouTube Music', open,
        desc: 'Music videos, YouTube search, your playlists and liked videos.',
        status: a.youtube.connected ? `Signed in${a.youtube.user ? ` as ${a.youtube.user.name}` : ''}` : a.youtube.hasKey ? 'API key added (search and videos)' : 'Not set up',
        ok: a.youtube.connected || a.youtube.hasKey,
        setup: () => [
          h('ol', { class: 'steps' },
            h('li', null, 'In the ', link('https://console.cloud.google.com/apis/library/youtube.googleapis.com', 'Google Cloud console'), ', create a project and enable YouTube Data API v3.'),
            h('li', null, 'For search and videos: Credentials → Create credentials → API key. Paste it below.'),
            h('li', null, 'For your playlists and likes (optional): Create credentials → OAuth client ID → Desktop app. Paste its client ID and secret, then on the OAuth consent screen add your Google account as a test user and choose Sign in.')),
          h('p', { class: 'note' }, 'Google gives 10,000 quota units a day; one search costs 100. MusicForge only searches YouTube when you ask, or to find a full-length version of a song no other source has, and remembers every match.'),
          form([
            { key: 'apiKey', label: 'API key', secret: true, has: a.config.youtube.hasKey },
            { key: 'clientId', label: 'OAuth client ID', value: a.config.youtube.clientId },
            { key: 'clientSecret', label: 'OAuth client secret', secret: true, has: a.config.youtube.hasSecret },
          ], 'youtube', a.youtube),
        ],
      }),
      service({
        id: 'lastfm', name: 'Last.fm', open,
        desc: 'Scrobble what you play, see your all-time stats, listener counts for artists.',
        status: a.lastfm.connected ? `Scrobbling as ${a.lastfm.user?.name}` : a.lastfm.configured ? 'Key added; sign in to scrobble' : 'Not set up',
        ok: a.lastfm.connected,
        setup: () => [
          h('ol', { class: 'steps' },
            h('li', null, 'Create an API account at ', link('https://www.last.fm/api/account/create', 'last.fm/api/account/create'), '. Callback URL can stay empty.'),
            h('li', null, 'Paste the API key and shared secret below, then Sign in.')),
          h('p', { class: 'note' }, 'With just the key, artist pages and Artist watch show Last.fm listeners and plays. Signing in adds scrobbling and your personal stats.'),
          form([
            { key: 'apiKey', label: 'API key', value: a.config.lastfm.apiKey },
            { key: 'secret', label: 'Shared secret', secret: true, has: a.config.lastfm.hasSecret },
          ], 'lastfm', a.lastfm),
        ],
      }),
      service({
        id: 'apple', name: 'Apple Music', open,
        desc: 'Import your Apple Music library playlists. Apple catalogue search and previews work without this.',
        status: a.apple.connected ? 'Signed in' : a.apple.configured ? 'Token added; sign in' : 'Optional',
        ok: a.apple.connected,
        setup: () => [
          h('p', { class: 'note' }, 'Apple only issues MusicKit developer tokens to Apple Developer Program members. If you have one, generate a MusicKit token (a JWT) and paste it here. Songs from Apple Music play through your other sources, because Apple doesn’t allow its streams in third-party desktop apps.'),
          appleForm(a),
        ],
      }),
      service({ id: 'soundcloud', name: 'SoundCloud', open, desc: 'Paste any SoundCloud track link into search to play it or add it to a playlist.', status: 'Works without an account', ok: true }),
      service({ id: 'deezer', name: 'Deezer', open, desc: 'Charts, artist fan counts, search, 30-second previews and public playlists by link.', status: 'Works without an account', ok: true }),
      service({ id: 'local', name: 'Local files', open, desc: 'MP3, FLAC, M4A, OGG, Opus and WAV from your folders, with full visualizer support.', status: `${state.library.tracks.length.toLocaleString()} songs`, ok: state.library.tracks.length > 0,
        setup: () => [h('div', null, h('button', { class: 'btn ghost', onclick: () => go('library', { tab: 'folders' }) }, icon('folder', 16), 'Manage folders'))] }),
    );
    if (!a.encrypted) list.after(h('p', { class: 'note', style: { marginTop: '14px' } }, 'Your system keyring isn’t available, so keys are stored in a local file without OS encryption.'));
  };

  function service({ id, name, desc, status, ok, setup, open: openSet }) {
    const isOpen = openSet.has(id);
    const row = h('div', { class: 'svc-row' },
      h('span', { class: `svc-dot src-${id === 'apple' ? 'apple' : id}`, style: { background: 'var(--src)' } }),
      h('div', null,
        h('div', { class: 'svc-name' }, name, h('span', { class: `svc-status ${ok ? 'ok' : ''}` }, ok ? icon('check', 14) : null, status)),
        h('div', { class: 'svc-desc' }, desc)),
      setup ? h('button', { class: 'btn small ghost', 'aria-expanded': isOpen, onclick: () => { if (openSet.has(id)) openSet.delete(id); else openSet.add(id); draw(); } }, isOpen ? 'Close' : ok ? 'Manage' : 'Set up') : null);
    return h('div', { class: 'svc' }, row, isOpen && setup ? h('div', { class: 'svc-setup' }, setup()) : null);
  }

  function form(fields, svc, st) {
    const inputs = {};
    const grid = h('div', { class: 'fields' }, fields.map((f) => {
      const input = h('input', { class: 'input', type: f.secret ? 'password' : 'text', value: f.value || '', placeholder: f.has ? 'Saved. Paste to replace.' : '', autocomplete: 'off', spellcheck: false });
      inputs[f.key] = { input, f };
      return h('div', { class: 'field' }, h('label', null, f.label), input);
    }));
    const saveCfg = async () => {
      const cfg = {};
      for (const [k, { input }] of Object.entries(inputs)) { const v = input.value.trim(); if (v) cfg[k] = v; }
      state.auth = await mf.invoke('auth:config', svc, cfg);
      return state.auth;
    };
    const connectBtn = h('button', {
      class: 'btn primary',
      onclick: async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        try {
          await saveCfg();
          if (svc === 'youtube' && !state.auth.youtube.configured) { toast(state.auth.youtube.hasKey ? 'API key saved' : 'Nothing to save', state.auth.youtube.hasKey ? '' : 'error'); await refreshAuth(); draw(); return; }
          btn.replaceChildren('Waiting for your browser…');
          state.auth = await mf.invoke('auth:connect', svc);
          toast(`${{ spotify: 'Spotify', youtube: 'YouTube', lastfm: 'Last.fm' }[svc]} linked`);
        } catch (err) {
          toast(String(err.message).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), 'error');
        }
        await refreshAuth();
        draw();
      },
    }, svc === 'youtube' ? 'Save and sign in' : 'Sign in');
    const saveBtn = h('button', { class: 'btn ghost', onclick: async () => { await saveCfg(); await refreshAuth(); toast('Saved'); draw(); } }, 'Save');
    const disc = st.connected ? h('button', { class: 'btn ghost danger', onclick: async () => {
      if (!(await confirm({ title: 'Sign out?', text: 'MusicForge forgets this sign-in. Your keys stay saved, and imported playlists stay in MusicForge.', ok: 'Sign out' }))) return;
      state.auth = await mf.invoke('auth:disconnect', svc);
      await refreshAuth(); draw();
    } }, 'Sign out') : null;
    const forget = st.configured || st.hasKey ? h('button', { class: 'btn ghost', onclick: async () => {
      if (!(await confirm({ title: 'Forget saved keys?', text: 'This removes the keys you entered for this service and signs you out.', ok: 'Forget keys' }))) return;
      await mf.invoke('auth:disconnect', svc);
      state.auth = await mf.invoke('auth:config', svc, null);
      await refreshAuth(); draw();
    } }, 'Forget keys') : null;
    return h('div', { style: { display: 'grid', gap: '12px' } }, grid, h('div', { class: 'row' }, connectBtn, saveBtn, disc, forget));
  }

  function appleForm(a) {
    const ta = h('textarea', { class: 'input', placeholder: a.config.apple.hasToken ? 'Token saved. Paste to replace.' : 'eyJhbGciOiJFUzI1NiIs…', spellcheck: false });
    return h('div', { style: { display: 'grid', gap: '12px' } },
      h('div', { class: 'field' }, h('label', null, 'MusicKit developer token'), ta),
      h('div', { class: 'row' },
        h('button', { class: 'btn primary', onclick: async () => {
          try {
            if (ta.value.trim()) state.auth = await mf.invoke('auth:config', 'apple', { developerToken: ta.value.trim() });
            await apple.authorize();
            toast('Apple Music linked');
          } catch (err) { toast(err.message, 'error'); }
          await refreshAuth(); draw();
        } }, 'Save and sign in'),
        a.apple.connected ? h('button', { class: 'btn ghost danger', onclick: async () => { await mf.invoke('auth:appleUserToken', null); await refreshAuth(); draw(); } }, 'Sign out') : null));
  }

  draw();
  const off = on('auth', () => view.isConnected && draw());
  return { el: view, cleanup: off };
}
