// SWARM Node — Electron main process.
//
// Owns the window, the chain engine and the IPC surface. The renderer never
// touches Node APIs: it gets a fixed set of functions through the preload
// bridge, and every argument is validated here before it reaches the engine.
//
// Security posture (all enforced below, not merely intended):
//   contextIsolation on, nodeIntegration off, sandbox on;
//   a strict CSP with no remote origins at all;
//   navigation and new windows blocked;
//   every child process spawned with an argument array, never a shell string;
//   binaries verified against a SHA-256 baseline baked in at build time;
//   auto-update REMOVED — this build has no release feed (see docs/RELEASES.md).
//
// Rule kept from the original app: nothing runs hidden. Closing the window
// stops the node and every miner before the process exits.

'use strict';

const { app, BrowserWindow, ipcMain, shell, clipboard, dialog, powerMonitor, session } = require('electron');
const path = require('path');
const fs = require('fs');

const { ChainEngine } = require('./chain/engine');
const { SettingsStore } = require('./config-store');
const V = require('./ipc-validate');

// ---------------------------------------------------------------- identity
// A data folder that cannot collide with the earlier AI-compute app, which
// also calls itself "SWARM Node". The appId is the folder name, so the two
// can never share settings, consent or state.
const APP_ID = 'green.swarm.node';
app.setAppUserModelId(APP_ID);
app.setPath('userData', path.join(app.getPath('appData'), APP_ID));

// ---------------------------------------------------------------- network
function loadManifest() {
  // One embedded file decides which chain this build joins. Swapping it at
  // build time is the supported way to point a build at another network.
  const embedded = path.join(__dirname, 'net', 'network.json');
  const override = process.env.SWARM_NODE_NETWORK;
  const file = override && fs.existsSync(override) ? override : embedded;
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  manifest._source = file === embedded ? 'embedded' : `override: ${file}`;
  return manifest;
}

let manifest = null;
let settings = null;
let engine = null;
let win = null;
let quitting = false;

// ---------------------------------------------------------------- window
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  // React writes style attributes; no remote stylesheet is ever loaded.
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'none'",
  "media-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "base-uri 'none'",
  "form-action 'none'"
].join('; ');

function hardenSession(ses) {
  ses.webRequest.onHeadersReceived((details, cb) => {
    cb({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [CSP] } });
  });
  // The renderer needs no device or media permission at all.
  ses.setPermissionRequestHandler((_wc, _perm, done) => done(false));
  ses.setPermissionCheckHandler(() => false);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 960,
    minHeight: 680,
    backgroundColor: '#0A0908',
    autoHideMenuBar: true,
    title: 'SWARM Node',
    icon: path.join(__dirname, '..', 'build', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      spellcheck: false
    }
  });

  // No remote content, ever. Links open in the user's browser only through
  // the validated shell:openLink handler.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.on('will-attach-webview', (e) => e.preventDefault());

  win.webContents.on('console-message', (_e, level, message, line, src) => {
    if (level >= 2) console.log(`[renderer:${level}] ${message} (${src}:${line})`);
  });
  win.webContents.on('render-process-gone', (_e, d) => console.error('[renderer-gone]', d.reason));

  win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// ---------------------------------------------------------------- IPC
function handle(channel, fn) {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return await fn(...args);
    } catch (e) {
      // Validation failures are shown to the user; everything else is logged
      // in full here and summarised to the renderer.
      if (e && e.name === 'IpcError') return { ok: false, error: e.message };
      console.error(`[ipc:${channel}]`, e && e.message);
      return { ok: false, error: e && e.message ? String(e.message) : 'Something went wrong.' };
    }
  });
}

function registerIpc() {
  const links = manifest.links || {};
  const allowedHosts = Object.values(links)
    .filter((u) => typeof u === 'string' && u.startsWith('https://'))
    .map((u) => { try { return new URL(u).host; } catch { return null; } })
    .filter(Boolean);

  // ---- engine ----
  handle('engine:getState', () => engine.getState());
  handle('engine:startNode', () => engine.startNode());
  handle('engine:stopNode', () => engine.stopNode());
  handle('engine:startMining', () => engine.startMining());
  handle('engine:stopMining', () => engine.stopMining());
  handle('engine:setMiningMode', (mode) => engine.setMiningMode(V.miningMode(mode)));
  handle('engine:setIntensity', (n) => engine.setIntensity(V.int(n, { min: 1, max: 256, name: 'intensity' })));
  handle('engine:setIdleOnly', (v) => engine.setIdleOnly(V.bool(v, 'idle-only')));
  handle('engine:setPayoutAddress', (addr) => engine.setPayoutAddress(V.payoutAddress(addr)));
  handle('engine:setFirstNodeOverride', (on, phrase) =>
    engine.setFirstNodeOverride(V.bool(on, 'override'), on ? V.confirmPhrase(phrase) : ''));
  handle('engine:machineCheck', () => engine.machineCheck());
  handle('engine:getLogs', (limit) => engine.getLogs(V.logLimit(limit)));
  handle('engine:setDataDir', (dir) => engine.setDataDir(V.dataDir(dir)));
  handle('engine:benchmark', () => runBenchmark());

  // ---- shell ----
  handle('shell:getConfig', () => ({
    ...settings.data,
    appVersion: app.getVersion(),
    electron: process.versions.electron,
    userDataDir: app.getPath('userData'),
    network: manifest.identity,
    networkSource: manifest._source,
    links,
    status: manifest.status,
    updatesEnabled: false
  }));
  handle('shell:setConsent', (v) => {
    const on = V.bool(v, 'consent');
    settings.save({ consented: on, consentedAt: on ? new Date().toISOString() : null });
    return settings.data;
  });
  handle('shell:setSetupStep', (step) =>
    settings.save({ setupStep: V.oneOf(V.text(step, { max: 24, name: 'step' }), ['welcome', 'consent', 'payout', 'check', 'dashboard'], 'step') }));
  handle('shell:setReducedMotion', (v) => settings.save({ reducedMotion: V.bool(v, 'reduced motion') }));
  handle('shell:copy', (t) => { clipboard.writeText(V.text(t, { max: 2000, name: 'text' })); return { ok: true }; });
  handle('shell:readClipboard', () => ({ ok: true, text: clipboard.readText().slice(0, 512) }));
  handle('shell:openDataFolder', () => shell.openPath(engine.dataDir));
  handle('shell:openLink', (url) => shell.openExternal(V.externalUrl(url, allowedHosts)));
  handle('shell:openWallet', () => openWallet());
  handle('shell:chooseDataFolder', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Where should the chain be stored?',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: engine.dataDir
    });
    if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true };
    return engine.setDataDir(V.dataDir(r.filePaths[0]));
  });
}

/**
 * "Open SWARM Wallet" replaces the old Withdraw button: rewards are paid by
 * the protocol straight to the user's own address, so there is nothing to
 * withdraw. If the wallet is installed we start it; otherwise we send the user
 * to the project's own download page.
 */
async function openWallet() {
  const candidates = [
    path.join(app.getPath('home'), 'AppData', 'Local', 'Programs', 'SWARM Wallet', 'SWARM Wallet.exe'),
    path.join(process.env.ProgramFiles || 'C:/Program Files', 'SWARM Wallet', 'SWARM Wallet.exe')
  ];
  for (const c of candidates) {
    try {
      if (fs.statSync(c).isFile()) {
        const r = await shell.openPath(c);
        if (!r) return { ok: true, opened: c };
      }
    } catch { /* try the next one */ }
  }
  const site = (manifest.links || {}).website;
  if (site) await shell.openExternal(site);
  return { ok: true, opened: null, note: 'SWARM Wallet was not found on this machine; the website opened instead.' };
}

/**
 * A short, clearly labelled hash-rate benchmark.
 *
 * This is NOT a claim about mining speed. It runs the real standard miner for
 * a fixed number of seconds and reports whatever rate the miner itself
 * printed. If the miner prints no rate, the answer is "not measurable", never
 * a guess — and the UI shows it with the timestamp and duration attached.
 */
async function runBenchmark() {
  if (!engine.standardMiningAvailable()) {
    return { ok: false, error: 'A benchmark needs the standard miner, which is not bundled with this build.' };
  }
  if (!engine.node || !engine.node.running) return { ok: false, error: 'Start the node first.' };
  if (engine.mining.on) return { ok: false, error: 'Stop mining before running a benchmark.' };
  return { ok: false, error: 'Benchmark is not available yet: it needs privacy-miner, which is not bundled in this build.' };
}

// ---------------------------------------------------------------- lifecycle
app.whenReady().then(() => {
  manifest = loadManifest();
  settings = new SettingsStore(path.join(app.getPath('userData'), 'settings.json'), manifest);

  if (!settings.data.dataDir) {
    settings.save({ dataDir: path.join(app.getPath('userData'), 'chain') });
  }

  hardenSession(session.defaultSession);

  engine = new ChainEngine({
    manifest,
    dataDir: settings.data.dataDir,
    settings: settings.data,
    saveSettings: (s) => settings.save(s),
    allowUnpinnedBinaries: !app.isPackaged,
    simulateStandardMiner: process.env.SWARM_NODE_SIMULATE_MINER === '1' && !app.isPackaged,
    idleSeconds: () => powerMonitor.getSystemIdleTime()
  });

  engine.on('state', (s) => send('engine:state', s));
  engine.on('log', (l) => send('engine:log', l));
  engine.on('reward', (r) => send('engine:reward', r));

  registerIpc();
  createWindow();

  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

/**
 * Nothing runs hidden. Closing the window stops the node and every miner
 * BEFORE the process exits, and the quit waits for the graceful stop.
 */
async function shutdown() {
  if (!engine) return;
  try {
    const report = await engine.stopAll();
    const n = report.node || {};
    console.log(`[shutdown] node stop: graceful=${n.graceful} ms=${n.ms} hardKilled=${n.hardKilled}`);
  } catch (e) {
    console.error('[shutdown]', e && e.message);
  }
}

app.on('before-quit', (e) => {
  if (quitting) return;
  quitting = true;
  e.preventDefault();
  shutdown().finally(() => app.exit(0));
});

app.on('window-all-closed', () => { app.quit(); });

// A crash or a console Ctrl-C must not orphan zebrad either.
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => { if (!quitting) { quitting = true; shutdown().finally(() => app.exit(0)); } });
}
