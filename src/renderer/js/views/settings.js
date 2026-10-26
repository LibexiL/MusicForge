import { h, icon, iconBtn, clear } from '../util.js';
import { state, save, mf, connected, DEFAULT_SETTINGS } from '../state.js';
import { spotify, NAMES } from '../services.js';
import { engine } from '../player/engine.js';
import { go } from '../router.js';
import { toast, confirm } from '../ui/components.js';
import { PALETTES, listInputDevices, startSystemCapture, stopSystemCapture, systemCaptureActive } from '../visualizer.js';
import { resetAccent, accentFromArt, applyMotion } from '../theme.js';
import { update, checkForUpdates } from '../ui/update.js';
import { on } from '../state.js';

const ACCENTS = ['#E9B949', '#E07A4F', '#D9577A', '#9C7CF0', '#5B8CF0', '#46B5A8', '#8CC152', '#ECE8E1'];

const row = (label, desc, ...ctl) => h('div', { class: 'set-row' }, h('div', null, h('div', { class: 'lbl' }, label), desc ? h('div', { class: 'desc' }, desc) : null), h('div', { class: 'ctl' }, ...ctl));
const group = (title, ...rows) => h('section', { class: 'set-group' }, h('h2', null, title), ...rows);

function toggle(get, set, label) {
  const b = h('button', { class: 'toggle', role: 'switch', 'aria-checked': String(!!get()), 'aria-label': label });
  b.onclick = () => { const v = !get(); set(v); b.setAttribute('aria-checked', String(v)); };
  return b;
}
function select(options, value, onChange, width = '100%') {
  const s = h('select', { class: 'input', style: { width }, onchange: (e) => onChange(e.target.value) }, options.map(([v, t]) => h('option', { value: v, selected: v === value }, t)));
  return s;
}
function range(min, max, step, value, onInput) {
  const out = h('span', { class: 't-meta', style: { width: '36px', textAlign: 'right' } }, String(value));
  const r = h('input', { type: 'range', class: 'range', min, max, step, value, oninput: (e) => { out.textContent = e.target.value; onInput(+e.target.value); } });
  return [r, out];
}

export function render() {
  const s = state.settings;
  const set = (k, v) => { s[k] = v; save('settings'); };
  const setVis = (k, v) => { s.vis[k] = v; save('settings'); };
  const view = h('div', { class: 'view settings' }, h('div', { class: 'view-head' }, h('h1', { class: 't-display' }, 'Settings')));

  // ---- Playback
  const orderList = h('ul', { class: 'order-list' });
  const drawOrder = () => {
    clear(orderList).append(...s.sourceOrder.map((name, i) => h('li', null,
      h('span', { class: 'n' }, i + 1), h('span', { class: `src src-${name}` }, name === 'preview' ? '30-second previews' : NAMES[name]),
      iconBtn('up', 'Move up', () => { if (i) { [s.sourceOrder[i - 1], s.sourceOrder[i]] = [s.sourceOrder[i], s.sourceOrder[i - 1]]; save('settings'); drawOrder(); } }, { class: 'small', size: 15, attrs: { disabled: i === 0 } }),
      iconBtn('down', 'Move down', () => { if (i < s.sourceOrder.length - 1) { [s.sourceOrder[i + 1], s.sourceOrder[i]] = [s.sourceOrder[i], s.sourceOrder[i + 1]]; save('settings'); drawOrder(); } }, { class: 'small', size: 15, attrs: { disabled: i === s.sourceOrder.length - 1 } }))));
  };
  drawOrder();

  const deviceSel = select([['', 'Whichever is active']], s.spotifyDevice, (v) => set('spotifyDevice', v));
  const loadDevices = async () => {
    if (!connected('spotify')) return;
    try {
      const list = await spotify.devices();
      clear(deviceSel).append(h('option', { value: '' }, 'Whichever is active'), ...list.map((d) => h('option', { value: d.id, selected: d.id === s.spotifyDevice }, `${d.name} (${d.type})`)));
    } catch { /* ignore */ }
  };
  loadDevices();

  const outSel = select([['', 'System default']], s.outputDevice, async (v) => { set('outputDevice', v); const ok = await engine.setOutput(v); if (!ok) toast("Couldn't switch output device", 'error'); });
  navigator.mediaDevices.enumerateDevices().then((devs) => {
    devs.filter((d) => d.kind === 'audiooutput' && d.deviceId !== 'default').forEach((d) => outSel.append(h('option', { value: d.deviceId, selected: d.deviceId === s.outputDevice }, d.label || 'Output device')));
  }).catch(() => {});

  view.append(group('Playback',
    row('Source priority', 'For each song, MusicForge tries these in order and uses the first one that has it. If a song only exists on a lower source, it searches the higher ones for a full-length match first.', orderList),
    row('Spotify playback', 'Auto plays inside MusicForge when this build has DRM support, otherwise it drives the Spotify app on this PC or your phone (Spotify Connect).',
      select([['auto', 'Auto'], ['inapp', 'Inside MusicForge'], ['connect', 'Spotify app (Connect)']], s.spotifyMode, (v) => { set('spotifyMode', v); engine.adapters.spotify.sdkTried = false; })),
    row('Spotify device', 'Used in Connect mode. Open Spotify on a device for it to show up.', deviceSel, iconBtn('refresh', 'Refresh devices', loadDevices, { size: 16 })),
    row('Find full songs on YouTube', 'When a song has no full-length source, search YouTube for it. Uses YouTube API quota.', toggle(() => s.resolveWithYouTube, (v) => set('resolveWithYouTube', v), 'Find full songs on YouTube')),
    row('Output device', 'For local files and previews. Spotify and YouTube follow your system output.', outSel),
    row('Scrobble to Last.fm', connected('lastfm') ? `Signed in as ${state.auth.lastfm.user?.name}.` : 'Sign in to Last.fm in Accounts first.', toggle(() => s.scrobble, (v) => set('scrobble', v), 'Scrobble to Last.fm')),
  ));

  // ---- Visualizer
  const palettes = h('div', { class: 'swatches' }, Object.entries(PALETTES).map(([name, cols]) => h('button', {
    class: `pal-preview ${s.vis.palette === name ? 'on' : ''}`, title: name[0].toUpperCase() + name.slice(1), 'aria-label': `${name} palette`,
    style: { outline: s.vis.palette === name ? '2px solid var(--text)' : 'none', outlineOffset: '2px', width: '54px' },
    onclick: (e) => { setVis('palette', name); palettes.querySelectorAll('button').forEach((b) => (b.style.outline = b === e.currentTarget ? '2px solid var(--text)' : 'none')); },
  }, cols.map((c) => h('div', { style: { background: c } })))));
  const capSel = select([['', 'Detect a monitor source']], s.vis.device, (v) => setVis('device', v));
  listInputDevices().then((ins) => ins.forEach((d) => capSel.append(h('option', { value: d.deviceId, selected: d.deviceId === s.vis.device }, d.label || 'Input device'))));
  const capStatus = h('span', { class: 't-meta' }, systemCaptureActive() ? 'Listening' : 'Off');
  const capBtn = h('button', { class: 'btn small ghost', onclick: async () => {
    if (systemCaptureActive()) { stopSystemCapture(); capStatus.textContent = 'Off'; capBtn.textContent = 'Start'; return; }
    try { await startSystemCapture(); capStatus.textContent = 'Listening'; capBtn.textContent = 'Stop'; } catch (err) { toast(err.message, 'error'); }
  } }, systemCaptureActive() ? 'Stop' : 'Start');

  view.append(group('Visualizer',
    row('Style', null, select([['bars', 'Bars'], ['mirror', 'Mirror'], ['wave', 'Wave'], ['radial', 'Radial']], s.vis.style, (v) => setVis('style', v), '160px')),
    row('Colours', 'Temper runs from tempered-steel blue to straw as the music gets louder.', palettes),
    row('Bars', null, ...range(16, 128, 4, s.vis.bars, (v) => setVis('bars', v))),
    row('Smoothing', 'Higher is calmer, lower is snappier.', ...range(0, 0.95, 0.05, s.vis.smoothing, (v) => setVis('smoothing', v))),
    row('Sensitivity', null, ...range(0.5, 2, 0.1, s.vis.sensitivity, (v) => setVis('sensitivity', v))),
    row('Falling peaks', null, toggle(() => s.vis.peaks, (v) => setVis('peaks', v), 'Falling peaks')),
    row('What it listens to', 'Spotify and YouTube play in protected players the visualizer can’t read. System audio captures what your PC is playing instead.',
      select([['auto', 'MusicForge audio, else system audio'], ['player', 'MusicForge audio only'], ['system', 'Always system audio']], s.vis.source, (v) => { setVis('source', v); if (v === 'system' && !systemCaptureActive()) startSystemCapture().catch((e) => toast(e.message, 'error')); })),
    state.info.platform === 'win32'
      ? row('System audio', 'Windows shares system audio through a loopback capture.', capStatus, capBtn)
      : row('System audio source', 'On PipeWire and PulseAudio, pick a “Monitor of …” source for your speakers or headphones.', capSel, capBtn),
  ));

  // ---- Lyrics
  const offOut = h('span', { class: 't-meta' }, `${(s.lyricsOffset || 0).toFixed(1)} s`);
  view.append(group('Lyrics',
    row('Timing offset', 'Shift synced lyrics if they run early or late. Positive shows lines later.', iconBtn('back', 'Earlier', () => { set('lyricsOffset', Math.round(((s.lyricsOffset || 0) - 0.1) * 10) / 10); offOut.textContent = `${s.lyricsOffset.toFixed(1)} s`; }, { class: 'small', size: 15 }), offOut, iconBtn('fwd', 'Later', () => { set('lyricsOffset', Math.round(((s.lyricsOffset || 0) + 0.1) * 10) / 10); offOut.textContent = `${s.lyricsOffset.toFixed(1)} s`; }, { class: 'small', size: 15 })),
  ));

  // ---- Appearance
  const swatches = h('div', { class: 'swatches' }, ACCENTS.map((c) => h('button', {
    class: `swatch ${s.accent.toLowerCase() === c.toLowerCase() ? 'on' : ''}`, style: { background: c }, 'aria-label': `Accent ${c}`,
    onclick: (e) => { set('accent', c); swatches.querySelectorAll('.swatch').forEach((b) => b.classList.toggle('on', b === e.currentTarget)); if (!s.dynamicAccent) resetAccent(); },
  })));
  view.append(group('Appearance',
    row('Colour from album art', 'Tint buttons and highlights with the current song’s artwork.', toggle(() => s.dynamicAccent, (v) => { set('dynamicAccent', v); accentFromArt(engine.track?.art); }, 'Colour from album art')),
    row('Accent colour', 'Used when colour from album art is off, or the art has no strong colour.', swatches),
    row('Reduce motion', null, toggle(() => s.reduceMotion, (v) => { set('reduceMotion', v); applyMotion(); }, 'Reduce motion')),
    row('Use system window frame', 'Native title bar instead of MusicForge’s. Takes effect after restart.', toggle(() => !!state.info.boot.nativeFrame, async (v) => { state.info.boot = await mf.invoke('boot:set', { nativeFrame: v }); restartHint(); }, 'Use system window frame')),
    row('Hardware acceleration', 'Turn off if you see flicker or a black window (some NVIDIA + Wayland setups). Takes effect after restart.', toggle(() => !state.info.boot.disableGpu, async (v) => { state.info.boot = await mf.invoke('boot:set', { disableGpu: !v }); restartHint(); }, 'Hardware acceleration')),
  ));

  // ---- Desktop
  view.append(group('Desktop',
    row('Tray icon', 'Play, pause and skip from the system tray.', toggle(() => s.tray, (v) => { set('tray', v); mf.invoke('win:tray', v); if (!v && s.closeToTray) set('closeToTray', false); }, 'Tray icon')),
    row('Keep playing when the window closes', 'Closing the window hides it to the tray instead of quitting.', toggle(() => s.closeToTray, (v) => { set('closeToTray', v); if (v && !s.tray) { set('tray', true); mf.invoke('win:tray', true); } }, 'Close to tray')),
    row('Global media keys', 'Play/Pause, Next and Previous keys work while MusicForge is in the background. On Linux, desktop media controls also work through MPRIS.', toggle(() => s.mediaKeys, (v) => { set('mediaKeys', v); mf.invoke('win:mediaKeys', v); }, 'Global media keys')),
    row('Scan folders on startup', 'Picks up new and changed files each time MusicForge opens.', toggle(() => s.scanOnStart, (v) => set('scanOnStart', v), 'Scan folders on startup'), h('button', { class: 'btn small ghost', onclick: () => go('library', { tab: 'folders' }) }, 'Folders')),
  ));

  // ---- Data
  view.append(group('Your data',
    row('Back up', 'Playlists, likes, listening history, artist watch and settings. Keys and sign-ins are not included.', h('button', { class: 'btn ghost', onclick: exportData }, icon('import', 16), 'Export')),
    row('Restore', 'Replace playlists, likes, history and artist watch with a backup.', h('button', { class: 'btn ghost', onclick: importData }, 'Import')),
    row('Listening history', `${state.history.length.toLocaleString()} plays recorded.`, h('button', { class: 'btn ghost danger', onclick: async () => {
      if (await confirm({ title: 'Clear listening history?', text: 'Your stats in MusicForge start again from zero. Last.fm and Spotify history are not affected.', ok: 'Clear history' })) { state.history = []; save('history'); toast('History cleared'); go('settings', {}, { replace: true }); }
    } }, 'Clear')),
    row('Song matches', `${Object.keys(state.resolve).length.toLocaleString()} cross-service matches remembered.`, h('button', { class: 'btn ghost', onclick: () => { state.resolve = {}; save('resolve'); toast('Matches cleared'); } }, 'Clear')),
    row('Reset settings', null, h('button', { class: 'btn ghost', onclick: async () => {
      if (await confirm({ title: 'Reset settings?', text: 'Playback, visualizer and appearance settings go back to defaults.', ok: 'Reset' })) { state.settings = structuredClone(DEFAULT_SETTINGS); save('settings'); resetAccent(); go('settings', {}, { replace: true }); }
    } }, 'Reset')),
  ));

  // ---- Updates
  const upText = h('span', { class: 't-meta', style: { textAlign: 'right' } });
  const upBtn = h('button', { class: 'btn small ghost' });
  const paintUpdate = (u = update.status) => {
    if (!u) { upText.textContent = ''; upBtn.textContent = 'Check now'; upBtn.onclick = () => checkForUpdates(); return; }
    const when = u.lastCheck ? ` Checked ${new Date(u.lastCheck).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.` : '';
    const texts = {
      idle: u.type === 'dev' ? 'Updates are off when running from source.' : 'Not checked yet.',
      checking: 'Checking…',
      none: `You’re up to date (${u.current}).${when}`,
      downloading: `Downloading ${u.version}… ${u.percent || 0}%`,
      ready: `Version ${u.version} is ready to install.`,
      available: `Version ${u.version} is available.${u.mode === 'manual' ? ' This build can’t update itself, so download it from GitHub.' : ''}`,
      error: u.error || 'Update check failed.',
    };
    upText.textContent = texts[u.state] || '';
    upBtn.disabled = u.state === 'checking' || u.state === 'downloading' || u.type === 'dev';
    if (u.state === 'ready') { upBtn.textContent = 'Restart to update'; upBtn.onclick = () => mf.invoke('update:install'); }
    else if (u.state === 'available') { upBtn.textContent = 'Download'; upBtn.onclick = () => mf.invoke('update:install'); }
    else { upBtn.textContent = 'Check now'; upBtn.onclick = () => checkForUpdates(); }
  };
  paintUpdate();
  const offUpdate = on('update', (u) => { if (view.isConnected) paintUpdate(u); else offUpdate(); });
  const autoDesc = { nsis: 'Downloads in the background and installs the next time MusicForge restarts.', appimage: 'Downloads in the background and swaps the AppImage on restart.', rpm: 'Downloads in the background; installing asks for your password once.', deb: 'Downloads in the background; installing asks for your password once.', portable: 'The portable build can’t replace itself; MusicForge tells you when a new version is out.' }[update.status?.type] || 'Checks GitHub for new versions every few hours.';

  view.append(group('Updates',
    row('Version', null, upText, upBtn),
    row('Update automatically', autoDesc, toggle(() => s.autoUpdate !== false, (v) => { set('autoUpdate', v); setTimeout(() => mf.invoke('update:reschedule'), 800); }, 'Update automatically')),
  ));

  view.append(group('About',
    row('MusicForge', `Version ${state.info.version} · Electron ${state.info.electron} · Chromium ${state.info.chrome}`, h('button', { class: 'btn ghost', onclick: () => mf.invoke('shell:open', 'https://github.com/LibexiL/MusicForge') }, icon('external', 16), 'GitHub')),
    row('Credits', 'Lyrics from LRCLIB. Charts, previews and fan counts from Deezer. Catalogue search from Apple. Archivo typeface by Omnibus-Type (OFL).'),
  ));
  return { el: view };
}

function restartHint() {
  toast('Restart MusicForge to apply');
  const t = document.querySelector('.toast:last-child');
  if (t) t.append(' · ', h('button', { style: { textDecoration: 'underline', fontWeight: 700 }, onclick: () => mf.invoke('app:relaunch') }, 'Restart now'));
}

async function exportData() {
  const data = { app: 'MusicForge', version: 1, exported: new Date().toISOString(), playlists: state.playlists, liked: state.liked, history: state.history, watchlist: state.watchlist, settings: state.settings };
  const path = await mf.invoke('data:export', JSON.stringify(data));
  if (path) toast(`Saved to ${path}`);
}

async function importData() {
  const text = await mf.invoke('data:import');
  if (!text) return;
  try {
    const d = JSON.parse(text);
    if (d.app !== 'MusicForge') throw new Error('Not a MusicForge backup');
    if (!(await confirm({ title: 'Restore this backup?', text: `From ${new Date(d.exported).toLocaleString()}. This replaces your current playlists, likes, history and artist watch.`, ok: 'Restore' }))) return;
    for (const k of ['playlists', 'liked', 'history', 'watchlist']) if (Array.isArray(d[k])) { state[k] = d[k]; save(k); }
    if (d.settings) { Object.assign(state.settings, d.settings); save('settings'); }
    const { emit } = await import('../state.js');
    emit('playlists');
    toast('Backup restored');
  } catch (err) { toast(`Couldn't restore: ${err.message}`, 'error'); }
}
