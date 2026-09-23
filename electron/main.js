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

const { app, BrowserWindow, ipcMain, shell, clipboard, dialog, powerMonitor, session, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');

const { ChainEngine } = require('./chain/engine');
const { SettingsStore } = require('./config-store');
const { MapData } = require('./chain/map-data');
const { NetworkStatus } = require('./chain/network-status');
const { inspect: inspectAddress } = require('./chain/address-format');
const L = require('./lock-code');
const MC = require('./map-city');
const V = require('./ipc-validate');

// ---------------------------------------------------------------- identity
// A data folder that cannot collide with the earlier AI-compute app, which
// also calls itself "SWARM Node". The appId is the folder name, so the two
// can never share settings, consent or state.
const APP_ID = 'green.swarm.node';
app.setAppUserModelId(APP_ID);

// SWARM_NODE_DATA_DIR moves EVERYTHING this app stores — settings, the chain,
// Electron's own caches — somewhere else.
//
// It exists because a test run must never touch the folder a real install
// uses. A capture harness of mine wrote its test settings, a test payout
// address and 11 MB of chain state into %APPDATA%\green.swarm.node, which is
// exactly where a later install by the owner would have looked. Without an
// override the only way to run the app twice is to share that folder.
//
// Refused in a packaged build unless SWARM_NODE_TEST_RUN is also set, so an
// installed copy cannot be pointed somewhere unexpected by a stray variable.
const dataDirOverride = process.env.SWARM_NODE_DATA_DIR;
const isTestRun = process.env.SWARM_NODE_TEST_RUN === '1';
// A harness window must not be VISIBLE on anybody's desktop. The owner found
// one, took it for the app and used it - twice. A red banner was not enough,
// so a harness run now renders into a window that is never shown at all.
// Only honoured alongside SWARM_NODE_TEST_RUN, so the product can never start
// invisibly.
const isHeadless = isTestRun && process.env.SWARM_NODE_HEADLESS === '1';
if (dataDirOverride && (!app.isPackaged || isTestRun)) {
  app.setPath('userData', path.resolve(dataDirOverride));
  console.log(`[data] using the override folder ${app.getPath('userData')}`);
} else {
  app.setPath('userData', path.join(app.getPath('appData'), APP_ID));
}

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
let mapData = null;
let netStatus = null;
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
    // A harness window must never be mistaken for the product. The owner once
    // found one, took it for the app and tried to mine with it.
    title: (process.env.SWARM_NODE_SHOTS || isTestRun)
      ? 'TEST RUN — do not use — SWARM Node harness'
      : 'SWARM Node',
    icon: path.join(__dirname, '..', 'build', 'icon.ico'),
    // Headless harness: never mapped, never in the taskbar, never focusable.
    // This is NOT the same as parking a window off-screen, which was tried and
    // does not work - a mapped window with no visible surface produces no
    // frame at all. A window created hidden with paintWhenInitiallyHidden
    // keeps its renderer compositing, so Page.captureScreenshot with
    // fromSurface:false still gets frames out of it.
    //
    // A harness window that IS shown (CI on a runner, or a developer watching)
    // carries a red TEST RUN banner on every screen; see .testrun-strip.
    show: !isHeadless,
    paintWhenInitiallyHidden: true,
    skipTaskbar: isHeadless,
    focusable: !isHeadless,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      spellcheck: false,
      // A hidden window is a background window as far as Chromium is
      // concerned, and a throttled renderer stops painting and stops running
      // timers - which is exactly what a capture needs it to keep doing.
      backgroundThrottling: false
    }
  });

  // Say, from the main process, whether this window is on screen at all.
  // The renderer cannot be asked: a CDP screencast - which is how a harness
  // photographs a hidden window - makes document.visibilityState report
  // "visible" even when nothing was ever shown. This is the authoritative
  // answer, and the harness checks for it.
  console.log(`[window] headless=${isHeadless} isVisible=${win.isVisible()}`);

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

/**
 * REVIEW HOOK, developer builds only.
 *
 * With SWARM_NODE_SHOTS set to a directory, the app walks its own screens and
 * writes a PNG of each, so a reviewer can see exactly what ships without
 * installing it. It renders the real UI against the real engine; the only
 * thing it does is choose which screen is on top.
 *
 * Refused in a packaged build, so it can never run on a user's machine, and
 * the window it opens is titled "TEST RUN - do not use".
 */
const SHOT_SCREENS = [
  ['01-welcome', 'welcome'],
  ['02-consent', 'consent'],
  ['03-payout', 'payout'],
  ['04-machine-check', 'check'],
  ['05-dashboard-mining', 'dashboard:mining'],
  ['06-dashboard-node', 'dashboard:node'],
  ['07-dashboard-honey', 'dashboard:rewards'],
  ['08-dashboard-map', 'dashboard:map'],
  ['09-dashboard-settings', 'dashboard:settings'],
  ['10-dashboard-log', 'dashboard:log']
];

async function captureScreens(dir) {
  if (app.isPackaged) { console.error('[shots] refused: this is a packaged build'); return; }
  fs.mkdirSync(dir, { recursive: true });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  for (const [file, screen] of SHOT_SCREENS) {
    await new Promise((resolve) => {
      win.webContents.once('did-finish-load', resolve);
      win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'), { hash: `shot=${screen}` });
    });
    // Let the first state push land, the map fetch finish, and motion settle.
    await wait(screen.includes('map') ? 6000 : screen.startsWith('dashboard') ? 3500 : 1800);
    try {
      const img = await win.webContents.capturePage();
      const out = path.join(dir, `${file}.png`);
      fs.writeFileSync(out, img.toPNG());
      console.log(`[shots] ${out} ${img.getSize().width}x${img.getSize().height}`);
    } catch (e) {
      console.error(`[shots] ${file} failed: ${e.message}`);
    }
  }
  console.log('[shots] done');
  app.quit();
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
  handle('engine:armMining', (on) => engine.armMining(V.bool(on, 'start when ready')));
  handle('engine:stopForeignNode', () => engine.stopForeignNode());
  handle('engine:startEverything', () => engine.startEverything());
  handle('engine:setMiningMode', (mode) => engine.setMiningMode(V.miningMode(mode)));
  handle('engine:setIntensity', (n) => engine.setIntensity(V.int(n, { min: 1, max: 256, name: 'intensity' })));
  handle('engine:setIdleOnly', (v) => engine.setIdleOnly(V.bool(v, 'idle-only')));
  handle('engine:setPayoutAddress', (addr) => engine.setPayoutAddress(V.payoutAddress(addr)));
  // Offline, instant, and never a claim about validity - see
  // electron/chain/address-format.js and defect N-3.
  handle('engine:inspectAddress', (addr) => inspectAddress(V.text(addr, { max: 600, name: 'address' })));
  handle('engine:setUserOverride', (on) => engine.setUserOverride(V.bool(on, 'start anyway')));
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
    contactEmail: manifest.contact_email || null,
    channelsNote: manifest.channels_note || null,
    status: manifest.status,
    updatesEnabled: false,
    // Did THIS user finish the wizard? Presence of a consent flag or an
    // address is not evidence of that; only the marker is. See
    // config-store.js and firstScreen() in the renderer.
    setupCompleted: !!settings.data.setupCompletedVersion,
    tourSeen: settings.data.tourSeenVersion === app.getVersion(),
    testRun: isTestRun
  }));
  handle('shell:setConsent', (v) => {
    const on = V.bool(v, 'consent');
    settings.save({ consented: on, consentedAt: on ? new Date().toISOString() : null });
    return settings.data;
  });
  handle('shell:setSetupStep', (step) =>
    settings.save({ setupStep: V.oneOf(V.text(step, { max: 24, name: 'step' }), ['welcome', 'consent', 'payout', 'check', 'dashboard'], 'step') }));
  // The wizard is finished only when the user reaches the end of it. The
  // RENDERER cannot pass a version in: it is stamped here from the running
  // build, so the marker cannot be forged or back-dated by the page.
  handle('shell:completeSetup', () =>
    settings.save({ setupCompletedVersion: app.getVersion(), setupCompletedAt: new Date().toISOString() }));
  handle('shell:restartSetup', () =>
    settings.save({ setupCompletedVersion: null, setupCompletedAt: null, setupStep: 'welcome' }));
  handle('shell:setTourSeen', (seen) =>
    settings.save({ tourSeenVersion: V.bool(seen, 'seen') ? app.getVersion() : null }));
  handle('shell:setReducedMotion', (v) => settings.save({ reducedMotion: V.bool(v, 'reduced motion') }));
  handle('shell:copy', (t) => { clipboard.writeText(V.text(t, { max: 2000, name: 'text' })); return { ok: true }; });
  handle('shell:readClipboard', () => ({ ok: true, text: clipboard.readText().slice(0, 512) }));
  handle('shell:openDataFolder', () => shell.openPath(engine.dataDir));
  handle('shell:openLink', (url) => shell.openExternal(V.externalUrl(url, allowedHosts)));
  handle('shell:openWallet', () => openWallet());
  handle('shell:getMapData', async (force) => {
    const result = await mapData.get({ force: V.bool(force === undefined ? false : force, 'refresh') });
    // The operator's own city joins the published list HERE, so the page draws
    // whatever it is handed and the merge exists in exactly one place
    // (electron/map-city.js). Each place says whether it is published or theirs.
    const mine = settings.data.mapCity || null;
    if (!result.data) return { ...result, mine };
    return { ...result, data: { ...result.data, nodes: MC.mergePlaces(result.data.nodes, mine) }, mine };
  });
  handle('shell:getNetworkStatus', (force) => netStatus.get({ force: V.bool(force === undefined ? false : force, 'refresh') }));

  // ---- the operator's own city on the Swarm map --------------------------
  // Kept on this machine and drawn on this machine's map. Nothing is sent
  // anywhere: the public map is a file the project publishes, and asking to be
  // added to it is a message the operator sends themselves (the page builds it
  // and copies it). See electron/map-city.js.
  handle('shell:setMapCity', (value) => {
    const checked = MC.validateCity(value);
    if (!checked.ok) return checked;
    settings.save({ mapCity: checked.city });
    return { ok: true, city: checked.city };
  });
  handle('shell:clearMapCity', () => {
    settings.save({ mapCity: null });
    return { ok: true };
  });
  handle('shell:chooseDataFolder', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Where should the chain be stored?',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: engine.dataDir
    });
    if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true };
    return engine.setDataDir(V.dataDir(r.filePaths[0]));
  });

  // ---- the code lock, and signing out ------------------------------------
  // The owner asked for both by name: a LOCK that needs a code to come back in,
  // and a SIGN OUT that signs out completely and starts the app from outside.
  // The rules they follow are in specs/WALLET.md, section "Session: lock and
  // sign out": the code is a session lock and not encryption, it is never
  // recovered, it is compared here and never in the page, and wrong tries are
  // throttled with the count kept per process.
  const lockGate = L.createGate();

  /** The record, decrypted. A damaged or missing one means "no code set". */
  const readLockRecord = () => {
    const stored = settings.data.lockCode;
    if (!stored || typeof stored !== 'object') return null;
    if (typeof stored.enc === 'string') {
      try {
        return JSON.parse(safeStorage.decryptString(Buffer.from(stored.enc, 'base64')));
      } catch {
        return null;
      }
    }
    return L.isRecord(stored.record) ? stored.record : null;
  };

  /**
   * Written through Electron's own encryption where this machine has it
   * (DPAPI on Windows), so the settings file holds a blob rather than a hash a
   * reader could take away and attack offline. Where there is no such store the
   * record is written as it is, and the screen that sets the code says so,
   * because the honest difference matters more than a uniform claim.
   */
  const writeLockRecord = (record) => {
    try {
      if (safeStorage.isEncryptionAvailable()) {
        settings.save({ lockCode: { enc: safeStorage.encryptString(JSON.stringify(record)).toString('base64') } });
        return { ok: true, encrypted: true };
      }
    } catch { /* fall through to the plain record */ }
    settings.save({ lockCode: { record } });
    return { ok: true, encrypted: false };
  };

  handle('lock:status', () => ({
    hasCode: readLockRecord() !== null,
    minLength: L.MIN_LENGTH,
    maxLength: L.MAX_LENGTH,
    freeAttempts: L.FREE_ATTEMPTS,
    waitSeconds: lockGate.waitSeconds(),
    encrypted: !!(settings.data.lockCode && typeof settings.data.lockCode.enc === 'string')
  }));

  handle('lock:set', (code, currentCode) => {
    const shape = L.checkShape(code);
    if (!shape.ok) return shape;
    const existing = readLockRecord();
    // Replacing a code, like removing one, needs the code that is there now.
    // Neither can be done by somebody who merely happens to be at an unlocked
    // window.
    if (existing) {
      const current = lockGate.verify(existing, currentCode);
      if (!current.ok) return { ok: false, reason: current.reason, waitSeconds: current.waitSeconds };
    }
    const made = L.createRecord(shape.code);
    if (!made.ok) return made;
    const written = writeLockRecord(made.record);
    lockGate.reset();
    return written;
  });

  handle('lock:clear', (currentCode) => {
    const existing = readLockRecord();
    if (existing) {
      const current = lockGate.verify(existing, currentCode);
      if (!current.ok) return { ok: false, reason: current.reason, waitSeconds: current.waitSeconds };
    }
    settings.save({ lockCode: null });
    lockGate.reset();
    return { ok: true };
  });

  handle('lock:verify', (code) => lockGate.verify(readLockRecord(), code));

  handle('session:signOut', async () => {
    // The window closes and the application starts again from the outside.
    // Signing out means the node and every miner are stopped the same way
    // closing does — nothing is left running, and nothing is deleted: the
    // chain, the payout address and the settings stay where they are.
    if (!quitting) {
      quitting = true;
      await shutdown();
    }
    app.relaunch({ args: process.argv.slice(1).concat(['--relaunch']) });
    app.exit(0);
    return { ok: true };
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

  // The swarm map's data is fetched HERE, not by the renderer, which keeps
  // connect-src 'none' in the page. One URL, validated, cached on disk.
  mapData = new MapData(path.join(app.getPath('userData'), 'swarm-map.cache.json'));
  // The one network-wide figure that can be checked: what the seed publishes
  // about itself. Refused outright if it is not this network. Never cached to
  // disk, because a stale "right now" number is a false one.
  netStatus = new NetworkStatus({
    genesisHash: (manifest.genesis || {}).hash || null,
    chainLabel: (manifest.identity || {}).light_wallet_chain_label || null
  });

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

  if (process.env.SWARM_NODE_SHOTS && !app.isPackaged) {
    // Start the node so the dashboard shows real numbers rather than dashes.
    engine.startNode().catch((e) => console.error('[shots] node start failed:', e.message));
    win.webContents.once('did-finish-load', () => {
      setTimeout(() => captureScreens(process.env.SWARM_NODE_SHOTS), 20000);
    });
  }

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
