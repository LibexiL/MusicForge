// Auto-update from GitHub Releases.
// - Windows installer, AppImage, .rpm and .deb: download in the background, install on restart
//   (rpm/deb ask for your password once through the system prompt).
// - Windows portable .exe and unpackaged runs: check only, and link to the release page.
import { app, net, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import updaterPkg from 'electron-updater';

const { autoUpdater } = updaterPkg;
const REPO = 'LibexiL/MusicForge';
const FIRST_CHECK_MS = 20_000;
const INTERVAL_MS = 4 * 3600_000;

function packageType() {
  if (process.platform === 'win32') return process.env.PORTABLE_EXECUTABLE_DIR ? 'portable' : 'nsis';
  if (process.platform === 'linux') {
    if (process.env.APPIMAGE) return 'appimage';
    try { return fs.readFileSync(path.join(process.resourcesPath, 'package-type'), 'utf8').trim(); } catch { return 'unknown'; }
  }
  return 'unknown';
}

const newer = (a, b) => {
  const pa = a.replace(/^v/, '').split('-')[0].split('.').map(Number);
  const pb = b.replace(/^v/, '').split('-')[0].split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
};

export function createUpdater({ send, getSettings }) {
  const type = app.isPackaged ? packageType() : 'dev';
  const auto = ['nsis', 'appimage', 'rpm', 'deb'].includes(type);
  const status = {
    state: 'idle', // idle | checking | none | available | downloading | ready | error
    current: app.getVersion(),
    version: null,
    percent: 0,
    error: null,
    url: `https://github.com/${REPO}/releases/latest`,
    mode: auto ? 'auto' : 'manual',
    type,
    lastCheck: 0,
  };
  const push = (patch) => { Object.assign(status, patch); send('update:status', { ...status }); };

  if (auto) {
    autoUpdater.autoDownload = true;
    // Package-manager installs prompt for a password, so never do that silently on quit.
    autoUpdater.autoInstallOnAppQuit = type === 'nsis' || type === 'appimage';
    autoUpdater.allowPrerelease = false;
    autoUpdater.logger = { info: () => {}, warn: (m) => console.warn('[updater]', m), error: (m) => console.error('[updater]', m), debug: () => {} };
    autoUpdater.on('checking-for-update', () => push({ state: 'checking', error: null }));
    autoUpdater.on('update-not-available', () => push({ state: 'none', lastCheck: Date.now() }));
    autoUpdater.on('update-available', (info) => push({ state: 'downloading', version: info.version, percent: 0, lastCheck: Date.now() }));
    autoUpdater.on('download-progress', (p) => push({ state: 'downloading', percent: Math.round(p.percent || 0) }));
    autoUpdater.on('update-downloaded', (info) => push({ state: 'ready', version: info.version, percent: 100 }));
    autoUpdater.on('error', (err) => {
      // The latest release has no update file (e.g. one published before the updater existed): nothing to install.
      if (/Cannot find (latest|channel)|latest[\w-]*\.yml.*(404|not found)/i.test(String(err?.message))) return push({ state: 'none', error: null, lastCheck: Date.now() });
      push({ state: 'error', error: friendly(err), lastCheck: Date.now() });
    });
  }

  async function manualCheck() {
    push({ state: 'checking', error: null });
    try {
      const res = await net.fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'MusicForge' } });
      if (res.status === 404) return push({ state: 'none', lastCheck: Date.now() });
      if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
      const rel = await res.json();
      if (newer(rel.tag_name, status.current)) push({ state: 'available', version: rel.tag_name.replace(/^v/, ''), url: rel.html_url, lastCheck: Date.now() });
      else push({ state: 'none', lastCheck: Date.now() });
    } catch (err) {
      push({ state: 'error', error: friendly(err), lastCheck: Date.now() });
    }
  }

  async function check() {
    if (status.state === 'downloading' || status.state === 'ready' || status.state === 'checking') return { ...status };
    if (auto) {
      try { await autoUpdater.checkForUpdates(); } catch { /* reported through the 'error' event */ }
    } else await manualCheck();
    return { ...status };
  }

  function install() {
    if (status.state === 'ready' && auto) {
      setImmediate(() => autoUpdater.quitAndInstall(false, true));
      return true;
    }
    shell.openExternal(status.url);
    return false;
  }

  let timer = null;
  function schedule() {
    clearTimeout(timer);
    clearInterval(timer);
    if (type === 'dev' || getSettings()?.autoUpdate === false) return;
    timer = setTimeout(() => {
      check();
      timer = setInterval(check, INTERVAL_MS);
    }, FIRST_CHECK_MS);
  }
  schedule();

  return { status: () => ({ ...status }), check, install, reschedule: schedule };
}

function friendly(err) {
  const m = String(err?.message || err);
  if (/ERR_INTERNET_DISCONNECTED|ENOTFOUND|ERR_NAME_NOT_RESOLVED|ETIMEDOUT|ECONNREFUSED|net::/.test(m)) return "Couldn't reach GitHub. Check your connection.";
  if (/latest.*\.yml|Cannot find/i.test(m)) return 'The newest release is still being built. Try again in a few minutes.';
  if (/rate limit|403/i.test(m)) return 'GitHub is rate-limiting update checks. Try again later.';
  if (/pkexec|sudo|authentication|dnf|apt/i.test(m)) return 'The update needs your password to install. Try Restart to update again.';
  return m.split('\n')[0].slice(0, 200);
}
