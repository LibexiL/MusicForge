// The only bridge between the UI and Node/Electron. No raw ipcRenderer is exposed.
const { contextBridge, ipcRenderer } = require('electron');

const INVOKE = new Set([
  'app:info', 'app:relaunch', 'boot:set',
  'win:overlay', 'win:fullscreen', 'win:tray', 'win:mediaKeys', 'win:progress',
  'store:load', 'store:set',
  'auth:status', 'auth:config', 'auth:connect', 'auth:disconnect', 'auth:token', 'auth:appleUserToken',
  'api:request', 'api:image',
  'library:get', 'library:scan', 'library:addFolder', 'library:removeFolder', 'library:lyrics', 'library:reveal',
  'shell:open', 'data:export', 'data:import',
]);
const EVENTS = new Set(['library:progress', 'player:command', 'auth:changed']);

contextBridge.exposeInMainWorld('mf', {
  invoke(channel, ...args) {
    if (!INVOKE.has(channel)) return Promise.reject(new Error(`Blocked channel ${channel}`));
    return ipcRenderer.invoke(channel, ...args);
  },
  on(channel, cb) {
    if (!EVENTS.has(channel)) return () => {};
    const fn = (_e, payload) => cb(payload);
    ipcRenderer.on(channel, fn);
    return () => ipcRenderer.removeListener(channel, fn);
  },
});
