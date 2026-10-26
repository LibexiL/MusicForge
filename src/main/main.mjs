import { app, BrowserWindow, ipcMain, shell, dialog, session, desktopCapturer, Tray, Menu, nativeImage, globalShortcut, clipboard } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Store, Secrets, readBoot, writeBoot } from './store.mjs';
import { startServer } from './server.mjs';
import { Auth } from './auth.mjs';
import { Api } from './api.mjs';
import { Library } from './library.mjs';
import { createUpdater } from './updater.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RENDERER = path.join(__dirname, '..', 'renderer');
const ICON = path.join(RENDERER, 'img', 'icon.png');
const PORT = 43117;
const DEV = process.argv.includes('--dev');

app.setName('MusicForge');
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  boot();
}

function boot() {
  const userData = app.getPath('userData');
  const bootCfg = readBoot(userData);

  // Startup tuning (must happen before 'ready').
  if (bootCfg.disableGpu) app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
  app.commandLine.appendSwitch('disable-features', 'SpareRendererForSitePerProcess');
  if (process.platform === 'linux') app.commandLine.appendSwitch('enable-features', 'WaylandWindowDecorations');

  let win = null;
  let tray = null;
  let quitting = false;
  const mediaToken = crypto.randomBytes(24).toString('hex');
  const send = (ch, payload) => { if (win && !win.isDestroyed()) win.webContents.send(ch, payload); };

  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } });
  app.on('before-quit', () => { quitting = true; });
  app.on('window-all-closed', () => app.quit());
  app.on('will-quit', () => globalShortcut.unregisterAll());

  app.whenReady().then(async () => {
    const store = new Store(path.join(userData, 'data.json'));
    const secrets = new Secrets(userData);
    const library = new Library(userData, send);
    const server = await startServer({ port: PORT, root: RENDERER, token: mediaToken, library });
    const auth = new Auth({ secrets, server, onChange: () => send('auth:changed', auth.status()) });
    const api = new Api(auth);
    const ours = (u) => typeof u === 'string' && u.startsWith(server.origin);

    // Permissions: microphone/system-audio only for our own page (visualizer capture);
    // fullscreen + DRM for the embedded players.
    const ses = session.defaultSession;
    ses.setPermissionRequestHandler((wc, permission, cb, details) => {
      if (permission === 'media' || permission === 'display-capture') return cb(ours(details.requestingUrl));
      cb(['fullscreen', 'mediaKeySystem', 'clipboard-sanitized-write', 'speaker-selection'].includes(permission));
    });
    ses.setPermissionCheckHandler((wc, permission, origin) => {
      if (permission === 'media') return ours(origin + '/');
      return ['fullscreen', 'mediaKeySystem', 'clipboard-sanitized-write', 'speaker-selection'].includes(permission);
    });
    ses.setDevicePermissionHandler(() => false);
    // System-audio loopback for the visualizer (Windows). On Linux the renderer opens a PipeWire/Pulse monitor source instead.
    ses.setDisplayMediaRequestHandler(async (req, cb) => {
      try {
        const sources = await desktopCapturer.getSources({ types: ['screen'] });
        cb({ video: sources[0], audio: process.platform === 'win32' ? 'loopback' : undefined });
      } catch {
        cb({});
      }
    });

    const createWindow = () => {
      const native = !!bootCfg.nativeFrame;
      win = new BrowserWindow({
        width: 1320, height: 840, minWidth: 940, minHeight: 600,
        show: false,
        backgroundColor: '#1b1e25',
        title: 'MusicForge',
        icon: ICON,
        autoHideMenuBar: true,
        titleBarStyle: native ? 'default' : 'hidden',
        titleBarOverlay: native ? false : { color: '#15181e', symbolColor: '#ece8e1', height: 40 },
        webPreferences: {
          preload: path.join(__dirname, 'preload.cjs'),
          contextIsolation: true,
          sandbox: true,
          nodeIntegration: false,
          spellcheck: false,
          backgroundThrottling: false,
          devTools: true,
        },
      });
      win.removeMenu();
      win.once('ready-to-show', () => { if (!process.argv.includes('--hidden')) win.show(); });
      win.on('close', (e) => {
        if (!quitting && store.get('settings')?.closeToTray && tray) { e.preventDefault(); win.hide(); }
      });
      win.on('closed', () => { win = null; });

      win.webContents.setWindowOpenHandler(({ url }) => {
        // Apple Music sign-in needs a real popup that can postMessage back to MusicKit.
        if (/^https:\/\/(authorize\.music\.apple\.com|idmsa\.apple\.com|appleid\.apple\.com)\//.test(url)) {
          return { action: 'allow', overrideBrowserWindowOptions: { width: 520, height: 720, autoHideMenuBar: true, parent: win } };
        }
        if (/^https?:\/\//.test(url)) shell.openExternal(url);
        return { action: 'deny' };
      });
      win.webContents.on('will-navigate', (e, url) => {
        if (!ours(url)) { e.preventDefault(); if (/^https?:\/\//.test(url)) shell.openExternal(url); }
      });
      win.webContents.on('before-input-event', (e, input) => {
        if (input.type === 'keyDown' && (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i'))) {
          win.webContents.toggleDevTools();
        }
      });
      win.loadURL(`${server.origin}/`);
      if (DEV) win.webContents.openDevTools({ mode: 'detach' });
    };

    const command = (cmd) => send('player:command', cmd);

    const setupTray = () => {
      if (tray) return;
      try {
        tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 22, height: 22 }));
        tray.setToolTip('MusicForge');
        tray.setContextMenu(Menu.buildFromTemplate([
          { label: 'Play / Pause', click: () => command('toggle') },
          { label: 'Next', click: () => command('next') },
          { label: 'Previous', click: () => command('prev') },
          { type: 'separator' },
          { label: 'Show MusicForge', click: () => { if (win) { win.show(); win.focus(); } else createWindow(); } },
          { label: 'Quit', click: () => { quitting = true; app.quit(); } },
        ]));
        tray.on('click', () => { if (win) { win.isVisible() ? win.focus() : win.show(); } });
      } catch (err) {
        console.warn('[tray] unavailable', err.message);
      }
    };

    const applyMediaKeys = (on) => {
      for (const k of ['MediaPlayPause', 'MediaNextTrack', 'MediaPreviousTrack', 'MediaStop']) {
        try { globalShortcut.unregister(k); } catch { /* ignore */ }
      }
      if (!on) return;
      const map = { MediaPlayPause: 'toggle', MediaNextTrack: 'next', MediaPreviousTrack: 'prev', MediaStop: 'pause' };
      for (const [k, c] of Object.entries(map)) {
        try { globalShortcut.register(k, () => command(c)); } catch { /* key grabbed elsewhere */ }
      }
    };

    // ---------- IPC ----------
    const handle = (ch, fn) => ipcMain.handle(ch, async (e, ...args) => {
      if (!ours(e.senderFrame?.url)) throw new Error('Forbidden');
      return fn(...args);
    });

    handle('app:info', () => ({
      origin: server.origin, port: server.port, mediaToken, platform: process.platform,
      version: app.getVersion(), electron: process.versions.electron, chrome: process.versions.chrome,
      boot: readBoot(userData), dev: DEV,
    }));
    handle('app:relaunch', () => { app.relaunch(); quitting = true; app.exit(0); });
    handle('boot:set', (patch) => writeBoot(userData, patch));
    handle('win:overlay', (opts) => {
      if (win && !bootCfg.nativeFrame && typeof win.setTitleBarOverlay === 'function') {
        try { win.setTitleBarOverlay(opts); } catch { /* not supported on this WM */ }
      }
    });
    handle('win:fullscreen', (on) => { if (win) win.setFullScreen(on === undefined ? !win.isFullScreen() : !!on); return win?.isFullScreen(); });
    handle('win:tray', (on) => { if (on) setupTray(); else if (tray) { tray.destroy(); tray = null; } });
    handle('win:mediaKeys', (on) => applyMediaKeys(on));
    handle('win:progress', (v) => { if (win) win.setProgressBar(v); });

    handle('store:load', () => store.all());
    handle('store:set', (key, value) => { store.set(key, value); });

    handle('auth:status', () => auth.status());
    handle('auth:config', (service, cfg) => { auth.setConfig(service, cfg); return auth.status(); });
    handle('auth:connect', (service) => auth.connect(service));
    handle('auth:disconnect', (service) => auth.disconnect(service));
    handle('auth:token', async (service) => {
      if (service === 'spotify') return auth.token('spotify');
      if (service === 'apple') return { developerToken: auth.config('apple').developerToken || null };
      throw new Error('Not available');
    });
    handle('auth:appleUserToken', (token) => auth.setAppleUserToken(token));
    handle('auth:cancel', (service) => server.cancel(service === 'youtube' ? 'google' : service));
    // Google's "Download JSON" for a Desktop OAuth client → client ID + secret, no copying by hand.
    handle('auth:googleClientFile', async () => {
      const r = await dialog.showOpenDialog(win, {
        title: 'Choose the client file you downloaded from Google',
        defaultPath: app.getPath('downloads'),
        properties: ['openFile'],
        filters: [{ name: 'Google client file', extensions: ['json'] }],
      });
      if (r.canceled || !r.filePaths[0]) return null;
      return fs.promises.readFile(r.filePaths[0], 'utf8');
    });
    handle('clipboard:read', async () => String((await clipboard.readText()) ?? '').slice(0, 20000));

    handle('api:request', (req) => api.request(req));
    handle('api:image', async (url) => {
      const { type, data } = await api.imageBytes(url);
      return { type, data: new Uint8Array(data) };
    });

    handle('library:get', () => ({ folders: library.folders(), tracks: library.tracks(), scanning: library.scanning }));
    handle('library:scan', () => library.scan());
    handle('library:addFolder', async () => {
      const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'multiSelections'], title: 'Add music folder' });
      if (r.canceled) return library.folders();
      for (const f of r.filePaths) library.addFolder(f);
      return library.folders();
    });
    handle('library:removeFolder', (dir) => library.removeFolder(dir));
    handle('library:lyrics', (id) => library.lyrics(id));
    handle('library:reveal', (id) => { const p = library.pathFor(id); if (p) shell.showItemInFolder(p); });

    handle('shell:open', (url) => { if (/^https?:\/\//.test(url)) return shell.openExternal(url); });
    handle('data:export', async (json) => {
      const r = await dialog.showSaveDialog(win, { defaultPath: 'musicforge-backup.json', filters: [{ name: 'JSON', extensions: ['json'] }] });
      if (r.canceled || !r.filePath) return false;
      await fs.promises.writeFile(r.filePath, json);
      return r.filePath;
    });
    handle('data:import', async () => {
      const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] });
      if (r.canceled || !r.filePaths[0]) return null;
      return fs.promises.readFile(r.filePaths[0], 'utf8');
    });

    createWindow();
    const updater = createUpdater({ send, getSettings: () => store.get('settings') });
    handle('update:status', () => updater.status());
    handle('update:check', () => updater.check());
    handle('update:install', () => updater.install());
    handle('update:reschedule', () => updater.reschedule());
    const s = store.get('settings') || {};
    if (s.tray !== false) setupTray();
    applyMediaKeys(s.mediaKeys ?? process.platform === 'win32');

    app.on('before-quit', () => store.flush());
  });
}
