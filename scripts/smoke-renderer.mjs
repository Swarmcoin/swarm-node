// Does the packaged app actually show anything?
//
// Draft build 0.2.0-testnet.1 passed lint, 84 unit tests and both string
// sweeps, and then opened a completely blank window: one module in the bundle
// threw at load time, React never mounted, and nothing in the pipeline looked.
// Everything else in this repository checks text. This checks that the app
// appears.
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
//     "TEST RUN — do not use".
//   * it leaves nothing running.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocket } from './ws-min.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const unpacked = process.argv[2] || path.join(ROOT, 'release', 'win-unpacked');
const artifactDir = process.argv[3] || path.join(ROOT, 'out');
const PORT = Number(process.env.SWARM_CDP_PORT) || 9411;
const MOUNT_DEADLINE_MS = Number(process.env.SWARM_SMOKE_MOUNT_MS) || 15000;
const HARD_DEADLINE_MS = Number(process.env.SWARM_SMOKE_DEADLINE_MS) || 150000;
const dataDir = path.join(os.tmpdir(), `swarm-node-smoke-${Date.now()}`);

const exe = path.join(unpacked, 'SWARM Node.exe');
if (!fs.existsSync(exe)) { console.error(`no packaged app at ${exe}`); process.exit(2); }
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(artifactDir, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail != null ? `  — ${detail}` : ''}`);
  return !!ok;
};

console.log(`app       : ${exe}`);
console.log(`data dir  : ${dataDir}  (throwaway)`);
console.log(`artifacts : ${artifactDir}`);
console.log(`deadlines : mount ${MOUNT_DEADLINE_MS} ms, overall ${HARD_DEADLINE_MS} ms\n`);

const child = spawn(exe, [`--remote-debugging-port=${PORT}`], {
  env: { ...process.env, SWARM_NODE_DATA_DIR: dataDir, SWARM_NODE_TEST_RUN: '1' },
  stdio: ['ignore', 'pipe', 'pipe']
});
const appOut = [];
child.stdout.on('data', (d) => appOut.push(String(d)));
child.stderr.on('data', (d) => appOut.push(String(d)));

/** Console messages and exceptions the renderer produced. */
const rendererLog = [];

let finished = false;
function killTree() {
  if (!child.pid) return;
  try {
    if (process.platform === 'win32') execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(child.pid, 'SIGKILL');
  } catch { /* already gone */ }
}

async function finish(code, why) {
  if (finished) return;
  finished = true;
  if (why) console.error(`\n${why}`);

  if (code !== 0) {
    const errs = rendererLog.filter((l) => /error|exception/i.test(l.level));
    const rest = rendererLog.filter((l) => !/error|exception/i.test(l.level));
    console.error('\n--- renderer console (errors first) ---');
    if (!rendererLog.length) console.error('  (nothing was reported)');
    for (const l of [...errs, ...rest].slice(0, 40)) console.error(`  [${l.level}] ${l.text}`);
    console.error('\n--- the app’s own output ---');
    const tail = appOut.join('').split('\n').filter(Boolean).slice(-25);
    for (const l of tail) console.error(`  ${l}`);
  }

  killTree();
  await sleep(1500);
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* best effort */ }

  // Never delete the product's folder: this harness does not own it, and
  // somebody may be using the app right now.
  const productDir = path.join(os.homedir(), 'AppData', 'Roaming', 'green.swarm.node');
  if (fs.existsSync(productDir)) {
    console.error(`\nNOTE: ${productDir} exists. If THIS run created it, the build ignored`);
    console.error('  SWARM_NODE_DATA_DIR. Nothing here will delete it.');
  }

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(code);
}

// The whole point: this script ends, always.
const hardStop = setTimeout(() => {
  check('the smoke test finished within its deadline', false, `still running after ${HARD_DEADLINE_MS} ms`);
  finish(1, 'HARD DEADLINE reached.');
}, HARD_DEADLINE_MS);
hardStop.unref?.();
process.on('SIGINT', () => finish(1, 'interrupted'));

function httpJson(p, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { host: '127.0.0.1', port: PORT, path: p, headers: { Host: `127.0.0.1:${PORT}` }, timeout: timeoutMs },
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

try {
  // ---- the window ------------------------------------------------------
  const until = Date.now() + 60000;
  let page = null;
  while (Date.now() < until && !page) {
    try {
      const list = await httpJson('/json/list');
      page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl) || null;
    } catch { /* not up yet */ }
    if (!page) await sleep(500);
  }
  if (!check('the app opens a window', !!page)) await finish(1, 'no debuggable page appeared within 60 s');

  // ---- the debug connection, with a timeout ----------------------------
  const cdp = new WebSocket(page.webSocketDebuggerUrl);
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
    await finish(1, 'could not attach to the renderer');
  }
  check('the debug connection opens', true);

  await cdp.send('Runtime.enable');

  // ---- did React mount, within a hard deadline? ------------------------
  const mountBy = Date.now() + MOUNT_DEADLINE_MS;
  let children = -1;
  while (Date.now() < mountBy) {
    try {
      const r = await cdp.send('Runtime.evaluate', {
        expression: "document.getElementById('root') ? document.getElementById('root').childElementCount : -1",
        returnByValue: true
      });
      children = r.result.value;
      if (children > 0) break;
    } catch { /* the page may still be loading */ }
    await sleep(400);
  }
  const mounted = check('React mounted into #root', children > 0, `#root has ${children} child element(s)`);

  const evaluate = async (expression) => {
    const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
    return r.result.value;
  };

  let visible = '';
  try { visible = await evaluate("(document.body.innerText || '').replace(/\\s+/g,' ').trim().slice(0, 400)"); } catch { /* reported below */ }
  check('the window shows words, not an empty page', (visible || '').length > 40, JSON.stringify((visible || '').slice(0, 140)));
  check('the page names the product', /SWARM/.test(visible || ''));

  const threw = rendererLog.filter((l) => l.level === 'exception');
  const mainSaidThrew = (appOut.join('').match(/\[renderer:3\][^\n]*/g) || []);
  check('the renderer threw nothing while starting', threw.length === 0 && mainSaidThrew.length === 0,
    [...threw.map((t) => t.text), ...mainSaidThrew].slice(0, 2).join(' | '));

  // ---- evidence, pass or fail ------------------------------------------
  try {
    const img = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const out = path.join(artifactDir, mounted ? 'smoke-renderer.png' : 'smoke-renderer-FAILED.png');
    fs.writeFileSync(out, Buffer.from(img.data, 'base64'));
    console.log(`\nscreenshot: ${out}`);
  } catch (e) {
    console.error(`could not take a screenshot: ${e.message}`);
  }

  const failed = results.filter((r) => !r.ok).length;
  await finish(failed === 0 ? 0 : 1, failed === 0 ? null : `${failed} check(s) failed`);
} catch (e) {
  check('unexpected error', false, e && e.stack ? e.stack.split('\n').slice(0, 2).join(' ') : String(e));
  await finish(1, 'the smoke test hit an unexpected error');
}
