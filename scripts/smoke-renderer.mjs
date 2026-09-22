// Does the packaged app actually show anything - and the RIGHT thing?
//
// Draft build 0.2.0-testnet.1 passed lint, 84 unit tests and both string
// sweeps, and then opened a completely blank window: one module in the bundle
// threw at load time, React never mounted, and nothing in the pipeline looked.
// Everything else in this repository checks text. This checks that the app
// appears.
//
// It now runs TWICE, because appearing is not enough. The owner installed
// 0.2.0-testnet.2 on a machine whose profile already held a consent flag and a
// payout address, and the app skipped the first-run wizard entirely - it read
// stray data as "this user has been shown around". So:
//
//   * profile "fresh" - an empty folder. The wizard must appear.
//   * profile "stray" - a folder seeded with exactly the leftovers that used
//     to suppress it. The wizard must STILL appear.
//   * profile "done"  - a folder whose settings carry a real completion
//     marker. Only this one may open on the dashboard, and the Mining page's
//     primary button must be enabled with a reason beside it.
//
//   node scripts/smoke-renderer.mjs [unpacked dir] [artifact dir]
//
// RULES THIS SCRIPT KEEPS, because the first version broke all of them:
//   * it cannot hang. A hard deadline ends the run whatever is stuck, and
//     every wait has its own timeout. (The first version printed "the app
//     opens a window" and then sat there until CI killed the step at six
//     minutes, with no verdict and no output.)
//   * it always reports. On failure it prints the renderer's console with
//     errors first and saves a screenshot next to the build's artifacts, so
//     the reason is visible without re-running anything.
//   * it never touches the product's data folder. A throwaway directory via
//     SWARM_NODE_DATA_DIR, removed afterwards, and the app titles its window
//     "TEST RUN - do not use".
//   * it leaves nothing running.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocket } from './ws-min.mjs';
import { startShots } from './cdp-shot.mjs';
import { stopApp } from './stop-app.mjs';
import { resolveAppExe } from './app-path.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const unpacked = process.argv[2] || path.join(ROOT, 'release', 'win-unpacked');
const artifactDir = process.argv[3] || path.join(ROOT, 'out');
const BASE_PORT = Number(process.env.SWARM_CDP_PORT) || 9411;
const MOUNT_DEADLINE_MS = Number(process.env.SWARM_SMOKE_MOUNT_MS) || 15000;
const HARD_DEADLINE_MS = Number(process.env.SWARM_SMOKE_DEADLINE_MS) || 240000;

// Windows, Linux and macOS each put it somewhere different; see app-path.mjs.
const exe = resolveAppExe(unpacked);
if (!exe) process.exit(2);
fs.mkdirSync(artifactDir, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail != null ? `  - ${detail}` : ''}`);
  return !!ok;
};

// The exact leftovers that used to suppress the wizard. Not invented: this is
// the shape of a profile that consented and pasted an address under an earlier
// build and never reached the end of setup.
const STRAY = {
  schema: 1,
  consented: true,
  consentedAt: '2026-09-21T10:00:00.000Z',
  payoutAddress: 'tmEXAMPLEEXAMPLEEXAMPLEEXAMPLEEXAMP',
  payoutKind: 'transparent',
  payoutDetail: 'a transparent address',
  setupStep: 'dashboard',
  reducedMotion: true
};

const PROFILES = [
  { name: 'fresh', seed: null, expect: 'wizard' },
  { name: 'stray', seed: STRAY, expect: 'wizard' },
  {
    name: 'done',
    seed: { ...STRAY, setupCompletedVersion: '0.0.0-any', setupCompletedAt: '2026-09-21T10:05:00.000Z', tourSeenVersion: '0.0.0-any' },
    expect: 'dashboard'
  }
];

const running = new Set();
function killTree(child) {
  if (!child || !child.pid) return;
  try {
    if (process.platform === 'win32') execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(child.pid, 'SIGKILL');
  } catch { /* already gone */ }
}

let finished = false;
async function finish(code, why) {
  if (finished) return;
  finished = true;
  if (why) console.error(`\n${why}`);
  for (const c of running) killTree(c);
  await sleep(1200);

  // Never delete the product's folder: this harness does not own it, and
  // somebody may be using the app right now.
  const productDir = path.join(os.homedir(), 'AppData', 'Roaming', 'green.swarm.node');
  if (process.platform === 'win32' && fs.existsSync(productDir)) {
    console.error(`\nNOTE: ${productDir} exists. If THIS run created it, the build ignored`);
    console.error('  SWARM_NODE_DATA_DIR. Nothing here will delete it.');
  }

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(code);
}

const hardStop = setTimeout(() => {
  check('the smoke test finished within its deadline', false, `still running after ${HARD_DEADLINE_MS} ms`);
  finish(1, 'HARD DEADLINE reached.');
}, HARD_DEADLINE_MS);
hardStop.unref?.();
process.on('SIGINT', () => finish(1, 'interrupted'));

function httpJson(port, p, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { host: '127.0.0.1', port, path: p, headers: { Host: `127.0.0.1:${port}` }, timeout: timeoutMs },
      (res) => {
        const c = [];
        res.on('data', (x) => c.push(x));
        res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(c).toString())); } catch (e) { reject(e); } });
      }
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

/** One profile, start to finish. Returns nothing; it records checks. */
async function runProfile(profile, port) {
  console.log(`\n=== profile "${profile.name}" (expects the ${profile.expect}) ===`);
  const firstResult = results.length;   // so the screenshot names THIS profile's verdict
  const dataDir = path.join(os.tmpdir(), `swarm-node-smoke-${profile.name}-${Date.now()}`);
  fs.mkdirSync(dataDir, { recursive: true });
  if (profile.seed) fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify(profile.seed, null, 2));

  const child = spawn(exe, [`--remote-debugging-port=${port}`], {
    env: { ...process.env, SWARM_NODE_DATA_DIR: dataDir, SWARM_NODE_TEST_RUN: '1', SWARM_NODE_HEADLESS: '1' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  running.add(child);
  const appOut = [];
  child.stdout.on('data', (d) => appOut.push(String(d)));
  child.stderr.on('data', (d) => appOut.push(String(d)));

  const rendererLog = [];
  let cdp = null;

  const bail = async (why) => {
    const errs = rendererLog.filter((l) => /error|exception/i.test(l.level));
    const rest = rendererLog.filter((l) => !/error|exception/i.test(l.level));
    console.error(`\n--- renderer console, profile "${profile.name}" (errors first) ---`);
    if (!rendererLog.length) console.error('  (nothing was reported)');
    for (const l of [...errs, ...rest].slice(0, 40)) console.error(`  [${l.level}] ${l.text}`);
    console.error(`\n--- the app's own output, profile "${profile.name}" ---`);
    for (const l of appOut.join('').split('\n').filter(Boolean).slice(-25)) console.error(`  ${l}`);
    if (why) console.error(`\n${why}`);
  };

  try {
    // ---- the window ----------------------------------------------------
    const until = Date.now() + 60000;
    let page = null;
    while (Date.now() < until && !page) {
      try {
        const list = await httpJson(port, '/json/list');
        page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl) || null;
      } catch { /* not up yet */ }
      if (!page) await sleep(500);
    }
    if (!check('the app opens a window', !!page)) { await bail('no debuggable page appeared within 60 s'); return; }

    cdp = new WebSocket(page.webSocketDebuggerUrl);
    cdp.onEvent = (m) => {
      if (m.method === 'Runtime.consoleAPICalled') {
        const args = (m.params.args || []).map((a) => a.value ?? a.description ?? a.type).join(' ');
        rendererLog.push({ level: m.params.type, text: String(args).slice(0, 400) });
      } else if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails || {};
        rendererLog.push({
          level: 'exception',
          text: `${d.text || ''} ${(d.exception && d.exception.description) || ''}`.trim().slice(0, 600)
        });
      }
    };
    try {
      await cdp.open(15000);
    } catch (e) {
      check('the debug connection opens', false, e.message);
      await bail('could not attach to the renderer');
      return;
    }
    check('the debug connection opens', true);
    await cdp.send('Runtime.enable');
    // The window is never shown, so frames have to be asked for. See
    // cdp-shot.mjs.
    const shots = await startShots(cdp);

    const evaluate = async (expression) => {
      const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
      return r.result.value;
    };

    // ---- did React mount, within a hard deadline? ----------------------
    const mountBy = Date.now() + MOUNT_DEADLINE_MS;
    let children = -1;
    while (Date.now() < mountBy) {
      try {
        children = await evaluate("document.getElementById('root') ? document.getElementById('root').childElementCount : -1");
        if (children > 0) break;
      } catch { /* the page may still be loading */ }
      await sleep(400);
    }
    const mounted = check('React mounted into #root', children > 0, `#root has ${children} child element(s)`);

    // The rule this harness exists under: no window of its own on anybody's
    // desktop. A banner was not enough - the owner used a harness window
    // twice. SWARM_NODE_HEADLESS creates the window with show:false.
    //
    // The RENDERER cannot answer this: the screencast used to photograph a
    // hidden window makes document.visibilityState report "visible". The main
    // process prints win.isVisible() at start-up, and that is what is checked.
    const windowLine = (appOut.join('').split('\n').find((l) => l.includes('[window]')) || '(not printed)').trim();
    check('the harness window is never shown', /headless=true isVisible=false/.test(windowLine), windowLine);

    // React mounting is not the same as the app having decided what to show:
    // the first paint is a "Starting SWARM Node..." placeholder while the main
    // process answers. Wait for that to clear before judging the page, or the
    // check races the splash and fails for the wrong reason. It did once.
    let visible = '';
    const readyBy = Date.now() + MOUNT_DEADLINE_MS;
    while (Date.now() < readyBy) {
      try {
        visible = await evaluate("(document.body.innerText || '').replace(/\\s+/g,' ').trim().slice(0, 600)");
      } catch { /* the page may still be loading */ }
      if (visible && !/^Starting SWARM Node/i.test(visible)) break;
      await sleep(250);
    }
    check('the window shows words, not an empty page', (visible || '').length > 40, JSON.stringify((visible || '').slice(0, 120)));
    check('the page names the product', /SWARM/.test(visible || ''));

    // ---- the right screen ----------------------------------------------
    // The wizard is identified by its own furniture, not by a word that could
    // appear anywhere: the setup card carries the step dots.
    const inWizard = await evaluate("!!document.querySelector('.setup')").catch(() => null);
    const inDashboard = await evaluate("!!document.querySelector('.rail .nav')").catch(() => null);

    if (profile.expect === 'wizard') {
      check('the first-run wizard is shown', inWizard === true && inDashboard !== true,
        `setup=${inWizard} dashboard=${inDashboard}`);
    } else {
      check('a completed profile opens on the dashboard', inDashboard === true && inWizard !== true,
        `setup=${inWizard} dashboard=${inDashboard}`);

      // ---- never a dead end -------------------------------------------
      // The owner's complaint was a greyed-out "Start mining" with no way on.
      // Whatever this machine's node is doing, the Mining page's big button
      // must be clickable and must carry a reason next to it.
      const mining = await evaluate(`(() => {
        const btn = document.querySelector('.card.glow .btn.big');
        if (!btn) return { found: false };
        const card = btn.closest('.card.glow');
        const why = card ? (card.querySelector('.small.muted') || {}).innerText || '' : '';
        return { found: true, disabled: !!btn.disabled, label: (btn.innerText || '').trim(), why: why.trim() };
      })()`).catch((e) => ({ found: false, error: e.message }));

      check('the Mining page has a primary button', mining.found === true, JSON.stringify(mining).slice(0, 160));
      check('that button is enabled', mining.found === true && mining.disabled === false, `label=${JSON.stringify(mining.label)}`);
      check('it says what it will do', (mining.label || '').length > 3, JSON.stringify(mining.label));
      check('a one-line reason sits beside it', (mining.why || '').length > 10, JSON.stringify((mining.why || '').slice(0, 100)));

      // ---- the tour, on demand ----------------------------------------
      const tour = await evaluate(`(() => {
        const btns = Array.from(document.querySelectorAll('.nav-item'));
        const settings = btns.find((b) => /settings/i.test(b.innerText));
        if (!settings) return { step: 'no settings tab' };
        settings.click();
        return { step: 'opened settings' };
      })()`).catch((e) => ({ step: e.message }));
      await sleep(400);
      const started = await evaluate(`(() => {
        const b = Array.from(document.querySelectorAll('button')).find((x) => /show me around/i.test(x.innerText || ''));
        if (!b) return { found: false };
        b.click();
        return { found: true };
      })()`).catch(() => ({ found: false }));
      await sleep(600);
      const tourText = await evaluate("(document.querySelector('.tour') || {}).innerText || ''").catch(() => '');
      check('the guided tour can be replayed from Settings', started.found === true && /step 1 of 5/i.test(tourText),
        `${tour.step}; tour=${JSON.stringify((tourText || '').slice(0, 60))}`);
      // It must also be possible to leave it.
      const left = await evaluate(`(() => {
        const b = Array.from(document.querySelectorAll('.tour button')).find((x) => /skip/i.test(x.innerText || ''));
        if (!b) return false;
        b.click();
        return true;
      })()`).catch(() => false);
      await sleep(300);
      const gone = await evaluate("!document.querySelector('.tour')").catch(() => false);
      check('the tour can be left in one click', left === true && gone === true);
    }

    const threw = rendererLog.filter((l) => l.level === 'exception');
    const mainSaidThrew = (appOut.join('').match(/\[renderer:3\][^\n]*/g) || []);
    check('the renderer threw nothing while starting', threw.length === 0 && mainSaidThrew.length === 0,
      [...threw.map((t) => t.text), ...mainSaidThrew].slice(0, 2).join(' | '));

    // ---- evidence, pass or fail ------------------------------------------
    try {
      const buf = await shots.take();
      const bad = results.slice(firstResult).some((r) => !r.ok);
      const out = path.join(artifactDir, `smoke-${profile.name}${bad ? '-FAILED' : ''}.png`);
      fs.writeFileSync(out, buf);
      console.log(`  screenshot: ${out}  (${(buf.length / 1024).toFixed(0)} KB)`);
      await shots.stop();
    } catch (e) {
      console.error(`  could not take a screenshot: ${e.message}`);
    }

    if (!mounted) await bail(null);
  } finally {
    // The node and miner are not in the app's process tree; see stop-app.mjs.
    await stopApp(child, cdp, dataDir);
    try { cdp?.close?.(); } catch { /* closing a dead socket is fine */ }
    killTree(child);
    running.delete(child);
    await sleep(800);
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

console.log(`app       : ${exe}`);
console.log(`artifacts : ${artifactDir}`);
console.log(`deadlines : mount ${MOUNT_DEADLINE_MS} ms, overall ${HARD_DEADLINE_MS} ms`);

try {
  // One at a time: two packaged instances would fight over the debug port and
  // over any port the node tries to bind.
  for (let i = 0; i < PROFILES.length; i += 1) await runProfile(PROFILES[i], BASE_PORT + i);
  const failed = results.filter((r) => !r.ok).length;
  await finish(failed === 0 ? 0 : 1, failed === 0 ? null : `${failed} check(s) failed`);
} catch (e) {
  check('unexpected error', false, e && e.stack ? e.stack.split('\n').slice(0, 2).join(' ') : String(e));
  await finish(1, 'the smoke test hit an unexpected error');
}
