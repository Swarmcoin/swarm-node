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
  armMining: (on) => invoke('engine:armMining', on === true),
  stopForeignNode: () => invoke('engine:stopForeignNode'),
  startEverything: () => invoke('engine:startEverything'),
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
  completeSetup: () => invoke('shell:completeSetup'),
  restartSetup: () => invoke('shell:restartSetup'),
  setTourSeen: (seen) => invoke('shell:setTourSeen', seen === true),
  setReducedMotion: (v) => invoke('shell:setReducedMotion', v),
  copy: (text) => invoke('shell:copy', text),
  readClipboard: () => invoke('shell:readClipboard'),
  openDataFolder: () => invoke('shell:openDataFolder'),
  openLink: (url) => invoke('shell:openLink', url),
  openWallet: () => invoke('shell:openWallet'),
  chooseDataFolder: () => invoke('shell:chooseDataFolder'),
  getMapData: (force) => invoke('shell:getMapData', force === true),
  getNetworkStatus: (force) => invoke('shell:getNetworkStatus', force === true)
});

// The code lock and signing out. Both were asked for by name by the owner; the
// rules they follow are in specs/WALLET.md ("Session: lock and sign out"). The
// code is compared in the main process — this bridge cannot see the stored
// record, only ask whether a code is set and hand one over to be checked.
contextBridge.exposeInMainWorld('sessionLock', {
  status: () => invoke('lock:status'),
  set: (code, currentCode) => invoke('lock:set', code, currentCode),
  clear: (currentCode) => invoke('lock:clear', currentCode),
  verify: (code) => invoke('lock:verify', code),
  // Signs out completely: the node and the miner are stopped, and the
  // application starts again as a new process.
  signOut: () => invoke('session:signOut')
});
