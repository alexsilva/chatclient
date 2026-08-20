/*
 * ChatClient renderer bridge.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('chatClient', {
  getState: () => ipcRenderer.invoke('chatclient:get-state'),
  setMode: (mode) => ipcRenderer.invoke('chatclient:set-mode', mode),
  updateLayout: (layout) => ipcRenderer.invoke('chatclient:update-layout', layout),
  refresh: () => ipcRenderer.invoke('chatclient:refresh'),
  setQuimeraAutoApprove: (enabled) =>
    ipcRenderer.invoke('chatclient:set-quimera-auto-approve', enabled),
  setShellOverlay: (visible) => ipcRenderer.invoke('chatclient:set-shell-overlay', visible),
  onState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('chatclient:state', listener);
    return () => ipcRenderer.removeListener('chatclient:state', listener);
  },
  onProviderStatus: (callback) => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on('chatclient:provider-status', listener);
    return () => ipcRenderer.removeListener('chatclient:provider-status', listener);
  }
});
