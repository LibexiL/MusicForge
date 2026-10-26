import { loadState, state, on, emit, mf, refreshLibrary } from './state.js';
import { engine } from './player/engine.js';
import { go } from './router.js';
import { resetAccent, accentFromArt, applyMotion } from './theme.js';
import { init as initShell } from './ui/shell.js';
import { toast } from './ui/components.js';
import './ui/update.js';
import { startSystemCapture } from './visualizer.js';

await loadState();
applyMotion();
resetAccent();
initShell();
engine.restore();
if (state.settings.outputDevice) engine.setOutput(state.settings.outputDevice);

on('track', () => accentFromArt(engine.track?.art || engine.track?.artLarge));

// Optional desktop notification when a new song starts and MusicForge isn't focused.
let notified = null;
on('track', () => {
  const t = engine.track;
  if (!t || !engine.source || notified === t.key) return;
  notified = t.key;
  if (!state.settings.notify || document.hasFocus()) return;
  try {
    const n = new Notification(t.title, { body: [t.artist, t.album].filter(Boolean).join(' — '), icon: t.art || undefined, silent: true, tag: 'musicforge-now-playing' });
    n.onclick = () => { window.focus(); go('nowplaying'); };
  } catch { /* notifications unavailable */ }
});
accentFromArt(engine.track?.art);

mf.on('library:progress', (p) => {
  emit('library-progress', p);
  if (p.finished) {
    refreshLibrary();
    if (p.parsed) toast(`Library updated: ${p.total.toLocaleString()} songs`);
  }
});

go('home');

// Background work after first paint.
requestIdleCallback(async () => {
  if (state.library.folders.length && state.settings.scanOnStart) mf.invoke('library:scan').catch(() => {});
  if (state.settings.vis.source === 'system') startSystemCapture().catch(() => {});
  mf.invoke('win:tray', state.settings.tray !== false);
  mf.invoke('win:mediaKeys', !!state.settings.mediaKeys);
  // Artist watch: take today's snapshot in the background so trends build even if the screen isn't opened.
  if (state.watchlist.length) {
    const { refreshArtist } = await import('./views/artists.js');
    for (const a of state.watchlist) { try { await refreshArtist(a); } catch { /* offline */ } }
  }
}, { timeout: 1500 });

window.addEventListener('unhandledrejection', (e) => console.warn('[unhandled]', e.reason));
