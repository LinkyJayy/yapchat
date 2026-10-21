// Exposes a tiny, safe bridge to the Yapper web app.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('yapperDesktop', {
  notify: (n) => ipcRenderer.send('notify', { title: n?.title, body: n?.body, url: n?.url }),
  setBadge: (count) => ipcRenderer.send('badge', Number(count) || 0),
});

contextBridge.exposeInMainWorld('yapperSetup', {
  save: (url) => ipcRenderer.invoke('setup:save', String(url || '')),
  get: () => ipcRenderer.invoke('setup:get'),
});

ipcRenderer.on('navigate', (_e, url) => {
  window.dispatchEvent(new CustomEvent('yapper-navigate', { detail: url }));
});
