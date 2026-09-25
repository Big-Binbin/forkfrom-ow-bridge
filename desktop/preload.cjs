const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('buddy', {
  action: (name, value) => ipcRenderer.invoke('action', name, value),
  onState: callback => ipcRenderer.on('state', (_event, state) => callback(state)),
  onDismiss: callback => ipcRenderer.on('dismiss-details', () => callback()),
});
