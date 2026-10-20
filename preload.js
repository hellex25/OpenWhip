const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bridge', {
  whipCrack: () => ipcRenderer.send('whip-crack'),
  hideOverlay: () => ipcRenderer.send('hide-overlay'),
  onSpawnWhip: (fn) => ipcRenderer.on('spawn-whip', (_e, pos) => fn(pos)),
  onDropWhip: (fn) => ipcRenderer.on('drop-whip', () => fn()),
  onSettings: (fn) => ipcRenderer.on('settings', (_e, settings) => fn(settings)),
});
