// Measured reliability of the graceful stop.
//
// Starts and stops a real zebrad N times through exactly the code path the app
// uses (Node's spawn with windowsHide, then the bundled Ctrl-C helper) and
// reports how many stops were graceful, how long each took, and whether any
// process was left behind.
//
//   node scripts/stop-cycles.mjs [cycles] [--wait-rpc]
//
// It never touches a network other than the throwaway one in
// test/fixtures/throwaway-network.json.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const { ZebraNode } = require(path.join(ROOT, 'electron/chain/zebrad.js'));
const { ZebraRpc } = require(path.join(ROOT, 'electron/chain/rpc.js'));
const { requireBinary } = require(path.join(ROOT, 'electron/chain/binaries.js'));
const { isAlive } = require(path.join(ROOT, 'electron/chain/graceful-stop.js'));

const cycles = Number(process.argv[2]) || 10;
const waitRpc = process.argv.includes('--wait-rpc');

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'test/fixtures/throwaway-network.json'), 'utf8'));
const dataDir = process.env.SWARM_NODE_TEST_DIR || path.join(os.tmpdir(), 'swarm-node-stopcycles');
fs.mkdirSync(path.join(dataDir, 'state'), { recursive: true });

const bin = requireBinary('zebrad', { allowUnpinned: true });
if (!bin.ok) {
  console.error('zebrad is not available:', bin.reason);
  console.error('Set SWARM_NODE_BIN_DIR to a folder containing zebrad.exe.');
  process.exit(2);
}
console.log(`zebrad: ${bin.path}`);
console.log(`sha256: ${bin.sha256}`);
console.log(`data:   ${dataDir}`);
console.log(`cycles: ${cycles}, waitForRpc: ${waitRpc}\n`);

const rpc = new ZebraRpc({ host: '127.0.0.1', port: manifest.ports.rpc, cookieDir: dataDir });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForRpcReady(timeoutMs = 60000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try { const r = await rpc.getInfo(); if (r) return true; } catch { /* not up yet */ }
    await sleep(500);
  }
  return false;
}

const results = [];
for (let i = 1; i <= cycles; i += 1) {
  const node = new ZebraNode({ binaryPath: bin.path, dataDir, manifest });
  const started = await node.start({
    rpcPort: manifest.ports.rpc,
    p2pListen: `127.0.0.1:${manifest.ports.p2p}`,
    seedPeers: [],
    enforceHealthGate: false,
    cpuThreads: 2,
    minerAddress: null,
    internalMiner: false
  });
  const pid = started.pid;

  let ready = false;
  if (waitRpc) ready = await waitForRpcReady();
  else await sleep(4000);

  const report = await node.stop({ timeoutMs: 25000 });
  await sleep(300);
  const leftover = isAlive(pid);

  results.push({ cycle: i, pid, ready, ...report, leftover });
  console.log(
    `cycle ${String(i).padStart(2)}  pid ${String(pid).padEnd(6)}  ` +
    `graceful=${report.graceful}  ${String(report.ms).padStart(6)} ms  ` +
    `attempts=${report.attempts}  hardKilled=${report.hardKilled}  leftover=${leftover}`
  );
}

const graceful = results.filter((r) => r.graceful).length;
const times = results.filter((r) => r.graceful).map((r) => r.ms);
const leftovers = results.filter((r) => r.leftover).length;

console.log('\n--- summary ---');
console.log(`graceful stops : ${graceful}/${cycles}`);
console.log(`hard kills     : ${results.filter((r) => r.hardKilled).length}`);
console.log(`processes left : ${leftovers}`);
if (times.length) {
  times.sort((a, b) => a - b);
  console.log(`graceful ms    : min ${times[0]}  median ${times[Math.floor(times.length / 2)]}  max ${times[times.length - 1]}`);
}

const out = path.join(dataDir, 'stop-cycles.json');
fs.writeFileSync(out, JSON.stringify({
  binary: bin.path, sha256: bin.sha256, cycles, waitRpc, results,
  summary: { graceful, hardKilled: results.filter((r) => r.hardKilled).length, leftovers, times }
}, null, 2));
console.log(`report         : ${out}`);

process.exit(graceful === cycles && leftovers === 0 ? 0 : 1);
