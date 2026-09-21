// AIInfra Node Client — Electron main process (the Shell's backbone).
// Creates the window, owns the engine bridge, and relays the engine
// interface contract to the renderer over IPC.

const { app, BrowserWindow, ipcMain, shell: shellApi, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { autoUpdater } = require('electron-updater');
const { EngineBridge } = require('./engine-bridge');
const { AccountManager } = require('./account');

let win = null;
let engine = null;
let engineProc = null;
let accounts = null;

// ---- Native compute engine (the Go binary) ----
// Production dispatch endpoint. Until api.swarm.green has TLS, the node connects
// through the app server's nginx on :80, which proxies /node to the dispatch
// server. Override with AIINFRA_DISPATCH_URL for local/dev.
const DISPATCH_URL = process.env.AIINFRA_DISPATCH_URL || 'wss://api.swarm.green/node';
const API_URL = process.env.AIINFRA_API_URL || 'https://api.swarm.green';

function enginePath() {
  // Binary name differs by OS — Windows carries the .exe suffix, mac/linux don't.
  const bin = process.platform === 'win32' ? 'aiinfra-engine.exe' : 'aiinfra-engine';
  // Packaged: electron-builder extraResources places it under resources/engine/.
  const packaged = path.join(process.resourcesPath || '', 'engine', bin);
  if (fs.existsSync(packaged)) return packaged;
  // Dev: built binary in the repo.
  const dev = path.join(__dirname, '..', '..', 'engine', bin);
  return fs.existsSync(dev) ? dev : null;
}

function startEngine() {
  const exe = enginePath();
  if (!exe) { console.log('[engine] native binary not found — using builtin (simulation)'); return; }
  try {
    engineProc = spawn(exe, [], {
      env: { ...process.env, AIINFRA_DISPATCH_URL: DISPATCH_URL, AIINFRA_API_URL: API_URL },
      stdio: 'ignore',
      windowsHide: true,
    });
    engineProc.on('exit', (code) => { console.log('[engine] exited', code); engineProc = null; });
    console.log('[engine] launched ->', DISPATCH_URL);
  } catch (e) {
    console.error('[engine] spawn failed:', e.message);
  }
}

function stopEngine() {
  if (engineProc) { try { engineProc.kill(); } catch {} engineProc = null; }
}

// ---- Auto-update (electron-updater, GitHub release feed) ----
// Checks the public swarm-downloads release on launch, downloads new versions in
// the background, and installs on the next quit. So future fixes ship without a
// manual reinstall. Only runs in the packaged app.
function initAutoUpdate() {
  if (!app.isPackaged) return;
  try {
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on('update-available', (i) => {
      if (win && !win.isDestroyed()) win.webContents.send('engine:update', { status: 'available', version: i?.version });
    });
    autoUpdater.on('update-downloaded', (i) => {
      if (win && !win.isDestroyed()) win.webContents.send('engine:update', { status: 'ready', version: i?.version });
    });
    autoUpdater.on('error', (e) => console.log('[updater]', e?.message || e));
    autoUpdater.checkForUpdatesAndNotify().catch((e) => console.log('[updater] check failed:', e?.message));
  } catch (e) {
    console.log('[updater] init failed:', e.message);
  }
}

// ---- persisted shell config (consent flag, throttle, idle-only) ----
const configPath = () => path.join(app.getPath('userData'), 'config.json');

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(configPath(), 'utf8'));
  } catch {
    return { consented: false, idleOnly: true, throttle: 80, wallet: '' };
  }
}

function saveConfig(cfg) {
  try {
    fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2));
  } catch (e) {
    console.error('config save failed:', e.message);
  }
}

let config = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 900,
    minHeight: 640,
    backgroundColor: '#0a0e14',
    autoHideMenuBar: true,
    title: 'SWARM Node',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  // Surface renderer problems in the main process log.
  win.webContents.on('console-message', (_e, level, message, line, src) => {
    if (level >= 2) console.log(`[renderer:${level}] ${message} (${src}:${line})`);
  });
  win.webContents.on('preload-error', (_e, preloadPath, err) => {
    console.error('[preload-error]', preloadPath, err.message);
  });
  win.webContents.on('render-process-gone', (_e, details) => {
    console.error('[renderer-gone]', details.reason);
  });

  // Dev/QA hook: AIINFRA_SHOT=<path> writes a real capture of the rendered
  // page shortly after load (PrintWindow shows black with GPU compositing).
  if (process.env.AIINFRA_SHOT) {
    win.webContents.once('did-finish-load', () => {
      win.show();
      win.moveTop();
      win.focus();
      setTimeout(() => {
        win.webContents.capturePage().then((img) => {
          fs.writeFileSync(process.env.AIINFRA_SHOT, img.toPNG());
          console.log('[shot] saved', process.env.AIINFRA_SHOT, img.getSize().width + 'x' + img.getSize().height);
        });
      }, 2500);
    });
  }

  win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
}

app.whenReady().then(() => {
  config = loadConfig();

  // Launch the native Go compute engine (it binds 127.0.0.1:48916 and connects
  // out to the dispatch network). The bridge connects to it; if it's missing,
  // the bridge falls back to the built-in simulation.
  startEngine();
  engine = new EngineBridge();
  engine.init(config);

  // Push live state to the renderer (status + earnings, 1 Hz while running).
  engine.on('state', (state) => {
    if (win && !win.isDestroyed()) win.webContents.send('engine:state', state);
  });

  // ---- engine interface contract, relayed over IPC ----
  ipcMain.handle('engine:getStatus', () => engine.getStatus());
  ipcMain.handle('engine:getHardware', () => engine.getHardware());
  ipcMain.handle('engine:getEarnings', () => engine.getEarnings());
  ipcMain.handle('engine:scan', () => engine.scan());
  ipcMain.handle('engine:start', () => engine.start());
  ipcMain.handle('engine:stop', () => engine.stop());
  ipcMain.handle('engine:pause', () => engine.pause());
  ipcMain.handle('engine:resume', () => engine.resume());
  ipcMain.handle('engine:getHistory', () => engine.getHistory());
  ipcMain.handle('engine:getLogs', () => engine.getLogs());
  ipcMain.handle('engine:getMachineId', () => engine.getMachineId());
  ipcMain.handle('engine:setIdleOnly', (_e, v) => {
    config.idleOnly = !!v; saveConfig(config);
    return engine.setIdleOnly(!!v);
  });
  ipcMain.handle('engine:setThrottle', (_e, v) => {
    config.throttle = Math.max(0, Math.min(100, Number(v) || 0)); saveConfig(config);
    return engine.setThrottle(config.throttle);
  });
  ipcMain.handle('engine:withdraw', (_e, addr) => {
    // EIP-55 checksum gate in the Shell, before the engine sees it.
    const check = accounts.validate(addr);
    if (!check.ok) return { ok: false, error: check.error };
    config.wallet = check.address; saveConfig(config);
    return engine.withdraw(config.wallet);
  });

  // ---- shell config (consent gate, restored controls) ----
  ipcMain.handle('shell:getConfig', () => config);
  ipcMain.handle('shell:setConsent', (_e, v) => {
    config.consented = !!v; saveConfig(config);
    return config;
  });

  // ---- account (network identity + payout wallet) ----
  accounts = new AccountManager(app.getPath('userData'));
  const pushAccountToEngine = () => {
    const acc = accounts.get();
    if (acc) engine.setAccount(acc.address);
  };
  ipcMain.handle('account:get', () => accounts.get());
  ipcMain.handle('account:validate', (_e, addr) => accounts.validate(addr));
  ipcMain.handle('account:create', async (_e, password) => {
    const res = await accounts.create(password);
    if (res.ok) pushAccountToEngine();
    return res;
  });
  ipcMain.handle('account:import', async (_e, { value, password }) => {
    const res = await accounts.import(value, password);
    if (res.ok) pushAccountToEngine();
    return res;
  });
  ipcMain.handle('account:exportKey', (_e, password) => accounts.exportPrivateKey(password));
  ipcMain.handle('account:signOut', () => {
    // Stop earning to the account being left, then forget it. Keystore stays
    // on disk for recovery (see AccountManager.clear).
    try { engine.stop(); } catch (e) { /* engine may be idle */ }
    return accounts.clear();
  });
  // Operator sign-up: email + onboarding answers go to the network's
  // operator registry, keyed by the account's payout address.
  const API_BASE = API_URL;
  ipcMain.handle('account:registerOperator', async (_e, { email, profile }) => {
    const acc = accounts.get();
    if (!acc) return { ok: false, error: 'Create your wallet first.' };
    try {
      const r = await fetch(`${API_BASE}/api/operators`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ payoutAddress: acc.address, email, profile })
      });
      const data = await r.json();
      if (data.ok) accounts.saveProfile(email, profile);
      return data;
    } catch {
      // Network unreachable: keep the profile locally; it syncs on demand.
      accounts.saveProfile(email, profile);
      return { ok: true, offline: true };
    }
  });

  // Network-side reads for the Earnings/Account views: payout claims,
  // operator record, and Node Right status. All best-effort — the app
  // stays usable when the network is unreachable.
  const SETTLE_BASE = process.env.AIINFRA_SETTLEMENT_URL || 'http://127.0.0.1:7790';
  const tryFetch = async (url) => {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(4000) });
      return await r.json();
    } catch { return null; }
  };
  ipcMain.handle('shell:getClaims', async () => {
    const acc = accounts.get();
    if (!acc) return [];
    return (await tryFetch(`${API_BASE}/api/claims/${acc.address}`)) || [];
  });
  ipcMain.handle('shell:getOperator', async () => {
    const acc = accounts.get();
    if (!acc) return null;
    return tryFetch(`${API_BASE}/api/operators/${acc.address}`);
  });
  ipcMain.handle('shell:getNftStatus', async () => {
    const acc = accounts.get();
    if (!acc) return null;
    return tryFetch(`${SETTLE_BASE}/nft/${acc.address}`);
  });
  // Affiliate dashboard: sponsor, downline, rank, and commission income.
  ipcMain.handle('shell:getAffiliate', async () => {
    const acc = accounts.get();
    if (!acc) return null;
    return tryFetch(`${API_BASE}/api/affiliate/${acc.address}`);
  });
  // A referral can arrive via env (SWARM_REF) or a deep link / CLI arg
  // (swarm://join?ref=0x…). Surfaced to onboarding so invitees don't type it.
  ipcMain.handle('shell:getPendingReferral', () => {
    for (const a of [process.env.SWARM_REF, ...process.argv]) {
      const m = a && String(a).match(/0x[0-9a-fA-F]{40}/);
      if (m) return m[0];
    }
    return null;
  });
  ipcMain.handle('shell:copy', (_e, text) => { clipboard.writeText(String(text || '')); return true; });
  ipcMain.handle('shell:openDataFolder', () => shellApi.openPath(app.getPath('userData')));
  // Cross-link to the SWARM web app, carrying the wallet so the web side
  // recognizes the same member (same wallet = same user across both apps).
  const WEB_URL = process.env.AIINFRA_WEB_URL || 'http://localhost:3000';
  ipcMain.handle('shell:openWeb', () => {
    const acc = accounts.get();
    return shellApi.openExternal(WEB_URL + (acc ? '/?wallet=' + acc.address : '/'));
  });
  ipcMain.handle('shell:getAppInfo', () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    dataDir: app.getPath('userData'),
    dispatchUrl: API_BASE
  }));

  // Engine (re)connects after boot — make sure it learns the payout address.
  pushAccountToEngine();
  setInterval(pushAccountToEngine, 30000);

  createWindow();
  initAutoUpdate();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  // Rule 1: nothing runs hidden. Closing the window stops all compute.
  if (engine) engine.stop();
  stopEngine();
  app.quit();
});

app.on('will-quit', stopEngine);
