const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  getVersion: () => ipcRenderer.invoke('desktop:get-version'),
  getUpdateState: () => ipcRenderer.invoke('desktop:get-update-state'),
  checkForUpdates: () => ipcRenderer.invoke('desktop:check-for-updates'),
  installUpdate: () => ipcRenderer.invoke('desktop:install-update'),
  onUpdateState: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const subscription = (_event, state) => callback(state);
    ipcRenderer.on('desktop:update-state', subscription);
    return () => ipcRenderer.removeListener('desktop:update-state', subscription);
  },
});
