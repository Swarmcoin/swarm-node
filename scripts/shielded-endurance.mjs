// Does shielded mining STAY on?
//
// N-8, the second half. The owner's payout address is a unified one, so their
// only engine is the node's own internal miner, and switching that on
// restarts the node because the node reads that setting once, at start-up.
// The app then read the freshly restarted node's few seconds without peers as
// "the gate closed under us", stopped mining, restarted the node AGAIN to
// switch the miner off, and went round in a circle: "the app updates the node
// BUT it drops out of the mining process ... it keeps loading but never keeps
// going".
//
// Starting it once proves nothing. This watches it for minutes and fails on
// the shape of that loop: mining turning itself off, the node restarting more
// than the one time switching the miner on costs, or the node's height
// standing still while the app claims to be mining.
//
//   node scripts/shielded-endurance.mjs <unpacked dir> <out dir> [minutes]
//
// Same rules as the other harnesses: the window is never shown, a throwaway
// data folder, the product's folder untouched, nothing left running.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocket } from './ws-min.mjs';
import { startShots } from './cdp-shot.mjs';
import { stopApp } from './stop-app.mjs';
import { resolveAppExe } from './app-path.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const unpacked = process.argv[2] || path.join(ROOT, 'release', 'win-unpacked');
const outDir = process.argv[3] || path.join(ROOT, 'out', 'endurance');
const MINUTES = Number(process.argv[4]) || 3;

// The owner's own address, from the SWARM Wallet's Receive page. A public
// testnet receive address; no key for it exists anywhere in this repository.
const UNIFIED = 'utest1ve9q2phl7hgu95nxg96d75v5hltu7wh4u2kpcz0t7dm2x7x8tns7hecem8m67e9uzruj2py7tu0s4sa5m59qcgw7936n3su40s9hrefr';

const exe = resolveAppExe(unpacked);
if (!exe) process.exit(2);
fs.mkdirSync(outDir, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const problems = [];
const note = (m) => { console.log(`  ${m}`); };

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}
function httpJson(port, p) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: p, headers: { Host: `127.0.0.1:${port}` }, timeout: 4000 }, (res) => {
      const c = [];
      res.on('data', (x) => c.push(x));
      res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(c).toString())); } catch (e) { reject(e); } });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

const dataDir = path.join(os.tmpdir(), `swarm-endurance-${Date.now()}`);
fs.mkdirSync(dataDir, { recursive: true });
fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({
  schema: 1,
  consented: true,
  consentedAt: new Date().toISOString(),
  payoutAddress: UNIFIED,
  payoutKind: 'unified',
  payoutDetail: 'Unified address. Shielded mining pays into it directly.',
  miningMode: 'shielded',
  setupCompletedVersion: '0.2.0-testnet.4',
  setupCompletedAt: new Date().toISOString(),
  tourSeenVersion: '0.2.0-testnet.4'
}, null, 2));

const port = await freePort();
const child = spawn(exe, [`--remote-debugging-port=${port}`], {
  env: { ...process.env, SWARM_NODE_DATA_DIR: dataDir, SWARM_NODE_TEST_RUN: '1', SWARM_NODE_HEADLESS: '1' },
  stdio: ['ignore', 'pipe', 'pipe']
});
const appOut = [];
child.stdout.on('data', (d) => appOut.push(String(d)));
child.stderr.on('data', (d) => appOut.push(String(d)));

console.log(`app      : ${exe}`);
console.log(`data dir : ${dataDir}  (throwaway)`);
console.log(`watching : ${MINUTES} minute(s) of shielded mining\n`);

let cdp = null;
let code = 0;
try {
  const until = Date.now() + 60000;
  let page = null;
  while (Date.now() < until && !page) {
    try {
      const list = await httpJson(port, '/json/list');
      page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl) || null;
    } catch { /* not up yet */ }
    if (!page) await sleep(500);
  }
  if (!page) throw new Error('the app never opened a debuggable page');

  cdp = new WebSocket(page.webSocketDebuggerUrl);
  await cdp.open(15000);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  const shots = await startShots(cdp);

  const evaluate = async (expression) => {
    const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
    return r.result.value;
  };
  const shot = async (name) => {
    const buf = await shots.take();
    fs.writeFileSync(path.join(outDir, `${name}.png`), buf);
    console.log(`  ${name}.png  (${(buf.length / 1024).toFixed(0)} KB)`);
  };
  const state = async () => JSON.parse(await evaluate(`(async () => JSON.stringify(await window.engine.getState()))()`));

  const line = (appOut.join('').split('\n').find((l) => l.includes('[window]')) || '(not printed)').trim();
  console.log(`  ${line}`);
  if (!/headless=true isVisible=false/.test(line)) problems.push(`the window was not hidden (${line})`);

  let s = await state();
  if (s.payout.kind !== 'unified') problems.push(`the profile is not unified: ${s.payout.kind}`);
  if (s.mining.mode !== 'shielded') problems.push(`the engine is not shielded: ${s.mining.mode}`);

  await evaluate('window.engine.startNode()');
  note('node starting');
  const synced = Date.now() + 15 * 60_000;
  while (Date.now() < synced) {
    s = await state();
    if (s.gate && s.gate.allow) break;
    await sleep(4000);
  }
  if (!s.gate || !s.gate.allow) { problems.push('the node never caught up, so nothing could be proved'); throw new Error('not synced'); }
  note(`gate open at block ${s.node.height}`);
  await shot('01-ready-to-mine-unified-address');

  const startedAtHeight = s.node.height;
  await evaluate('window.engine.startMining()');
  note('shielded mining asked for (this restarts the node once, by design)');

  // It is allowed ONE restart - the one that switches the miner on.
  let restarts = 0;
  let lastPid = null;
  let offAfterOn = 0;
  let sawOn = false;
  let minedPeak = 0;
  const deadline = Date.now() + MINUTES * 60_000;
  let first = true;

  while (Date.now() < deadline) {
    await sleep(5000);
    s = await state();
    const pid = s.node.pid;
    if (pid && lastPid && pid !== lastPid) { restarts += 1; note(`the node restarted (now ${pid})`); }
    if (pid) lastPid = pid;
    if (s.mining.on) {
      if (!sawOn) { sawOn = true; note('mining is on'); }
    } else if (sawOn) {
      offAfterOn += 1;
      note(`mining turned itself OFF (${offAfterOn})`);
    }
    minedPeak = Math.max(minedPeak, s.rewards.blocksFound || 0);
    if (first && s.mining.on) { first = false; await sleep(3000); await shot('02-shielded-mining-on'); }
  }

  s = await state();
  const grew = Number.isInteger(s.node.height) && Number.isInteger(startedAtHeight) && s.node.height > startedAtHeight;
  await shot('03-shielded-mining-after-the-watch');

  console.log('');
  console.log(`  mining on at the end      : ${s.mining.on}`);
  console.log(`  node restarts observed    : ${restarts}  (one is expected, and only one)`);
  console.log(`  times mining turned off   : ${offAfterOn}`);
  console.log(`  height ${startedAtHeight} -> ${s.node.height}  (${grew ? 'moving' : 'STOOD STILL'})`);
  console.log(`  blocks found by this node : ${minedPeak}`);

  if (!sawOn) problems.push('shielded mining never started at all');
  if (!s.mining.on) problems.push('shielded mining was not running at the end of the watch');
  if (offAfterOn > 0) problems.push(`mining turned itself off ${offAfterOn} time(s) - that is the loop`);
  if (restarts > 1) problems.push(`the node restarted ${restarts} times; switching the miner on costs exactly one`);
  if (!grew) problems.push('the node made no progress while the app claimed to be mining');
} catch (e) {
  problems.push(`unexpected: ${e && e.message ? e.message : e}`);
  console.error(`\n${e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n') : e}`);
  const tail = appOut.join('').split('\n').filter(Boolean).slice(-15);
  for (const l of tail) console.error(`  app: ${l}`);
} finally {
  await stopApp(child, cdp, dataDir);
  try { cdp?.close?.(); } catch { /* fine */ }
  await sleep(1500);
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* best effort */ }
}

if (problems.length) {
  console.error(`\n${problems.length} problem(s):`);
  for (const p of problems) console.error(`  ${p}`);
  code = 1;
} else {
  console.log('\nshielded mining started once and stayed on');
}
process.exit(code);
