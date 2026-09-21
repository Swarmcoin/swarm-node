// Exposes the engine interface contract to the React UI.
// The renderer never touches Node APIs directly — only this surface.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('engine', {
  getStatus: () => ipcRenderer.invoke('engine:getStatus'),
  getHardware: () => ipcRenderer.invoke('engine:getHardware'),
  getEarnings: () => ipcRenderer.invoke('engine:getEarnings'),
  scan: () => ipcRenderer.invoke('engine:scan'),
  start: () => ipcRenderer.invoke('engine:start'),
  stop: () => ipcRenderer.invoke('engine:stop'),
  pause: () => ipcRenderer.invoke('engine:pause'),
  resume: () => ipcRenderer.invoke('engine:resume'),
  getHistory: () => ipcRenderer.invoke('engine:getHistory'),
  getLogs: () => ipcRenderer.invoke('engine:getLogs'),
  getMachineId: () => ipcRenderer.invoke('engine:getMachineId'),
  setIdleOnly: (v) => ipcRenderer.invoke('engine:setIdleOnly', v),
  setThrottle: (v) => ipcRenderer.invoke('engine:setThrottle', v),
  withdraw: (addr) => ipcRenderer.invoke('engine:withdraw', addr),
  onState: (cb) => {
    const handler = (_e, state) => cb(state);
    ipcRenderer.on('engine:state', handler);
    return () => ipcRenderer.removeListener('engine:state', handler);
  }
});

contextBridge.exposeInMainWorld('shell', {
  getConfig: () => ipcRenderer.invoke('shell:getConfig'),
  setConsent: (v) => ipcRenderer.invoke('shell:setConsent', v),
  getClaims: () => ipcRenderer.invoke('shell:getClaims'),
  getOperator: () => ipcRenderer.invoke('shell:getOperator'),
  getAffiliate: () => ipcRenderer.invoke('shell:getAffiliate'),
  getPendingReferral: () => ipcRenderer.invoke('shell:getPendingReferral'),
  getNftStatus: () => ipcRenderer.invoke('shell:getNftStatus'),
  copy: (text) => ipcRenderer.invoke('shell:copy', text),
  openDataFolder: () => ipcRenderer.invoke('shell:openDataFolder'),
  openWeb: () => ipcRenderer.invoke('shell:openWeb'),
  getAppInfo: () => ipcRenderer.invoke('shell:getAppInfo')
});

contextBridge.exposeInMainWorld('account', {
  get: () => ipcRenderer.invoke('account:get'),
  validate: (addr) => ipcRenderer.invoke('account:validate', addr),
  create: (password) => ipcRenderer.invoke('account:create', password),
  import: (value, password) => ipcRenderer.invoke('account:import', { value, password }),
  registerOperator: (email, profile) => ipcRenderer.invoke('account:registerOperator', { email, profile }),
  exportKey: (password) => ipcRenderer.invoke('account:exportKey', password),
  signOut: () => ipcRenderer.invoke('account:signOut')
});
