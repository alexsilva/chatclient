/*
 * ChatClient renderer bridge.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('chatClient', {
  getState: () => ipcRenderer.invoke('chatclient:get-state'),
  setMode: (mode) => ipcRenderer.invoke('chatclient:set-mode', mode),
  updateLayout: (layout) => ipcRenderer.invoke('chatclient:update-layout', layout),
  refresh: () => ipcRenderer.invoke('chatclient:refresh'),
  openSettings: () => ipcRenderer.invoke('chatclient:open-settings'),
  setAppApprovalsEnabled: (enabled) =>
    ipcRenderer.invoke('chatclient:set-app-approvals-enabled', enabled),
  addAppApprovalPolicy: (name) =>
    ipcRenderer.invoke('chatclient:add-app-approval-policy', name),
  updateAppApprovalPolicy: (id, patch) =>
    ipcRenderer.invoke('chatclient:update-app-approval-policy', id, patch),
  removeAppApprovalPolicy: (id) =>
    ipcRenderer.invoke('chatclient:remove-app-approval-policy', id),
  setAppReasoningLevel: (level) =>
    ipcRenderer.invoke('chatclient:set-app-reasoning-level', level),
  setRestoreWorkspace: (enabled) =>
    ipcRenderer.invoke('chatclient:set-restore-workspace', enabled),
  setShellOverlay: (visible) => ipcRenderer.invoke('chatclient:set-shell-overlay', visible),
  revealChrome: (target) => ipcRenderer.invoke('chatclient:chrome-reveal', target),
  onState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('chatclient:state', listener);
    return () => ipcRenderer.removeListener('chatclient:state', listener);
  },
  onProviderStatus: (callback) => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on('chatclient:provider-status', listener);
    return () => ipcRenderer.removeListener('chatclient:provider-status', listener);
  },
  onLoadingState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('chatclient:loading-state', listener);
    return () => ipcRenderer.removeListener('chatclient:loading-state', listener);
  },
  onChromeState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('chatclient:chrome-state', listener);
    return () => ipcRenderer.removeListener('chatclient:chrome-state', listener);
  },
  onOpenSettings: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('chatclient:open-settings', listener);
    return () => ipcRenderer.removeListener('chatclient:open-settings', listener);
  }
});
