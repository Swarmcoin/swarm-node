// Does the packaged app actually show anything?
//
// Draft build 0.2.0-testnet.1 passed lint, 84 unit tests and both string
// sweeps, and then opened a completely blank window: one module in the bundle
// threw at load time, React never mounted, and nothing in the pipeline looked.
// Everything up to this point checks source and text. This checks pixels, or
// as close as a build machine gets to them: it launches the real packaged app,
// waits for the renderer, and fails unless React put something on the page and
// the console is clean.
//
//   node scripts/smoke-renderer.mjs [unpacked dir]
//
// Runs with a throwaway data directory and removes it afterwards.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { WebSocket } from './ws-min.mjs';

const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const unpacked = process.argv[2] || path.join(ROOT, 'release', 'win-unpacked');
const PORT = Number(process.env.SWARM_CDP_PORT) || 9411;
const dataDir = path.join(os.tmpdir(), `swarm-node-smoke-${Date.now()}`);

const exe = fs.existsSync(path.join(unpacked, 'SWARM Node.exe'))
  ? path.join(unpacked, 'SWARM Node.exe')
  : null;
if (!exe) { console.error(`no packaged app under ${unpacked}`); process.exit(2); }

fs.mkdirSync(dataDir, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail != null ? `  — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

console.log(`app      : ${exe}`);
console.log(`data dir : ${dataDir}\n`);

const child = spawn(exe, [`--remote-debugging-port=${PORT}`], {
  env: { ...process.env, SWARM_NODE_DATA_DIR: dataDir, SWARM_NODE_TEST_RUN: '1' },
  stdio: ['ignore', 'pipe', 'pipe']
});
const appOut = [];
child.stdout.on('data', (d) => appOut.push(String(d)));
child.stderr.on('data', (d) => appOut.push(String(d)));

function httpJson(p) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: PORT, path: p, headers: { Host: `127.0.0.1:${PORT}` } }, (res) => {
      const c = [];
      res.on('data', (x) => c.push(x));
      res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(c).toString())); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

async function finish(code) {
  try { child.kill(); } catch { /* gone */ }
  await sleep(2000);
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* best effort */ }
  // Never delete the product's folder: this harness does not own it, and
  // somebody may be using the app right now. An earlier version removed it,
  // which was harmless while nobody had installed anything and became a way to
  // destroy the owner's settings the moment they did.
  const productDir = path.join(os.homedir(), 'AppData', 'Roaming', 'green.swarm.node');
  if (fs.existsSync(productDir)) {
    console.error(`\nNOTE: ${productDir} exists. If THIS run created it, the build ignored`);
    console.error('  SWARM_NODE_DATA_DIR. Nothing here will delete it.');
  }
  process.exit(code);
}

try {
  const until = Date.now() + 120000;
  let page = null;
  while (Date.now() < until && !page) {
    try {
      const list = await httpJson('/json/list');
      page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl) || null;
    } catch { /* not up yet */ }
    if (!page) await sleep(500);
  }
  check('the app opens a window', !!page);
  if (!page) await finish(1);

  const cdp = new WebSocket(page.webSocketDebuggerUrl);
  await cdp.open();
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable').catch(() => {});

  const errors = [];
  cdp.onEvent = (m) => {
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails || {};
      errors.push(d.text + ' ' + ((d.exception && d.exception.description) || ''));
    }
  };

  await sleep(9000);   // first render plus the engine's first state push

  const evaluate = async (expression) => {
    const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
    return r.result.value;
  };

  const rootChildren = await evaluate("document.getElementById('root') ? document.getElementById('root').childElementCount : -1");
  check('React mounted something into #root', rootChildren > 0, `#root has ${rootChildren} child element(s)`);

  const visibleText = await evaluate("(document.body.innerText || '').replace(/\\s+/g,' ').trim().slice(0, 300)");
  check('the window shows words, not an empty page', (visibleText || '').length > 40, JSON.stringify((visibleText || '').slice(0, 120)));

  const brand = await evaluate("(document.body.innerText || '').includes('SWARM')");
  check('the page names the product', brand === true);

  // Anything the renderer threw during start-up. This is the exact signal that
  // was there, in the console, while 0.2.0-testnet.1 was declared good.
  const consoleErrors = appOut.join('').match(/\[renderer:3\][^\n]*/g) || [];
  check('the renderer threw nothing while starting', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));

  console.log(`\n${failures === 0 ? 'renderer smoke test passed' : failures + ' check(s) failed'}`);
  await finish(failures === 0 ? 0 : 1);
} catch (e) {
  check('unexpected error', false, e.message);
  await finish(1);
}
