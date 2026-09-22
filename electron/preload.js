// The only surface the renderer has. No Node API is exposed, and every call
// goes through a main-process handler that validates its arguments.

'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

function subscribe(channel, cb) {
  if (typeof cb !== 'function') return () => {};
  const handler = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld('engine', {
  getState: () => invoke('engine:getState'),
  startNode: () => invoke('engine:startNode'),
  stopNode: () => invoke('engine:stopNode'),
  startMining: () => invoke('engine:startMining'),
  stopMining: () => invoke('engine:stopMining'),
  setMiningMode: (mode) => invoke('engine:setMiningMode', mode),
  setIntensity: (n) => invoke('engine:setIntensity', n),
  setIdleOnly: (v) => invoke('engine:setIdleOnly', v),
  setPayoutAddress: (addr) => invoke('engine:setPayoutAddress', addr),
  inspectAddress: (addr) => invoke('engine:inspectAddress', addr),
  setUserOverride: (on) => invoke('engine:setUserOverride', on),
  setFirstNodeOverride: (on, phrase) => invoke('engine:setFirstNodeOverride', on, phrase),
  setDataDir: (dir) => invoke('engine:setDataDir', dir),
  machineCheck: () => invoke('engine:machineCheck'),
  benchmark: () => invoke('engine:benchmark'),
  getLogs: (limit) => invoke('engine:getLogs', limit),
  onState: (cb) => subscribe('engine:state', cb),
  onLog: (cb) => subscribe('engine:log', cb),
  onReward: (cb) => subscribe('engine:reward', cb)
});

contextBridge.exposeInMainWorld('shell', {
  getConfig: () => invoke('shell:getConfig'),
  setConsent: (v) => invoke('shell:setConsent', v),
  setSetupStep: (step) => invoke('shell:setSetupStep', step),
  setReducedMotion: (v) => invoke('shell:setReducedMotion', v),
  copy: (text) => invoke('shell:copy', text),
  readClipboard: () => invoke('shell:readClipboard'),
  openDataFolder: () => invoke('shell:openDataFolder'),
  openLink: (url) => invoke('shell:openLink', url),
  openWallet: () => invoke('shell:openWallet'),
  chooseDataFolder: () => invoke('shell:chooseDataFolder'),
  getMapData: (force) => invoke('shell:getMapData', force === true)
});
