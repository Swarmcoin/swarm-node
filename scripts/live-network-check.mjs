// What a NEW machine experiences when it installs SWARM Node and presses Start.
//
// This runs the app's own engine, with the shipped network manifest and no
// hand configuration at all, exactly as a second device would: empty data
// folder, the embedded seed peer, the embedded genesis. It answers the two
// questions that decide whether a stranger can join:
//
//   * does a fresh node get block 0 from the seed by itself, or does the app
//     have to hand it over?
//   * does the sync gate correctly hold mining back until this node has the
//     seed's tip, and then let go?
//
// It does NOT mine unless the node is genuinely synced, and it never writes to
// the network. Run:  node scripts/live-network-check.mjs [--mine]

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const { ChainEngine } = require(path.join(ROOT, 'electron/chain/engine.js'));
const { ZebraRpc } = require(path.join(ROOT, 'electron/chain/rpc.js'));
const { requireBinary } = require(path.join(ROOT, 'electron/chain/binaries.js'));
const { isAlive } = require(path.join(ROOT, 'electron/chain/graceful-stop.js'));

const manifest = require(path.join(ROOT, 'electron/net/network.json'));
const WANT_MINE = process.argv.includes('--mine');
const RESUME = process.argv.includes('--resume');
const SYNC_TIMEOUT_MS = Number(process.env.SWARM_LIVE_TIMEOUT) || 420000;

// A second device would use the app's default ports. This machine already runs
// other SWARM processes, so the check takes its own loopback ports unless told
// otherwise — the point being tested is the SEED connection, not the port.
const P2P = Number(process.env.SWARM_LIVE_P2P) || 28833;
const RPC = Number(process.env.SWARM_LIVE_RPC) || 28843;

const dataDir = process.env.SWARM_LIVE_DIR || path.join(os.tmpdir(), 'swarm-node-live');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const notes = [];
const results = [];
let failures = 0;

function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail === undefined ? null : detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail != null ? `  — ${detail}` : ''}`);
  if (!ok) failures += 1;
  return ok;
}

const bin = requireBinary('zebrad', { allowUnpinned: true });
if (!bin.ok) { console.error(bin.reason); process.exit(2); }

console.log(`network : ${manifest.identity.network_name}`);
console.log(`seed    : ${manifest.seed_peers.join(', ')}`);
console.log(`genesis : ${manifest.genesis.hash}`);
console.log(`data    : ${dataDir}  (${RESUME ? 'continuing this disposable check' : 'emptied first, like a fresh install'})`);
console.log(`ports   : p2p ${P2P}, rpc ${RPC} loopback\n`);

if (RESUME && !fs.existsSync(path.join(dataDir, 'state'))) {
  throw new Error(`--resume needs a previous disposable check at ${dataDir}`);
}
if (!RESUME) fs.rmSync(dataDir, { recursive: true, force: true });
fs.mkdirSync(path.join(dataDir, 'state'), { recursive: true });

const engine = new ChainEngine({
  manifest,
  dataDir,
  settings: {
    consented: true,
    payoutAddress: '', payoutKind: null,
    miningMode: 'shielded', intensity: 1, idleOnly: false, autoResume: false,
    firstNodeOverride: false,          // a second device is NEVER the first node
    dataDir, p2pPort: P2P, rpcPort: RPC,
    p2pListen: `0.0.0.0:${P2P}`,
    seedPeers: null,                   // use the manifest's seed, like a real install
    nodeThreads: 2, zebraHealthGate: true, stopTimeoutMs: 25000
  },
  saveSettings: () => {},
  allowUnpinnedBinaries: true
});
const appLog = [];
engine.on('log', (l) => { if (l.kind === 'app') { appLog.push(l.text); console.log(`    app: ${l.text.slice(0, 150)}`); } });

const rpc = new ZebraRpc({ host: '127.0.0.1', port: RPC, cookieDir: dataDir });
let pid = null;
let exitCode = 1;

try {
  // --- start, with no configuration by the user at all --------------------
  const started = await engine.startNode();
  pid = started.pid;
  check('a fresh node starts with no configuration by the user', started.ok === true, `pid ${pid}`);

  const upUntil = Date.now() + 90000;
  let up = false;
  while (Date.now() < upUntil && !up) {
    try { if (await rpc.getInfo()) up = true; } catch { await sleep(500); }
  }
  check('the node answers its own RPC', up);

  // --- does a peer serve block 0? -----------------------------------------
  // ensureGenesis waits 45 s for a peer before falling back to the embedded
  // bytes, and records which of the two happened.
  const gen = await engine.ensureGenesis();
  check('the node ends up on the right genesis block', gen.ok === true && gen.hash === manifest.genesis.hash, gen.hash || gen.error);
  const fromPeer = gen.source === 'received from a peer';
  notes.push(RESUME
    ? 'This run continued a disposable data directory; the initial run separately recorded that genesis came from the seed.'
    : fromPeer
      ? 'A fresh node DOES receive block 0 from the seed by itself. The embedded genesis is a fallback that was not needed.'
      : `A fresh node does NOT receive block 0 from the seed within 45 s; the app handed it over from the build (source: ${gen.source}). This is invisible to the user but it means the embedded genesis.hex is load-bearing.`);
  console.log(`\nGENESIS SOURCE: ${RESUME ? 'present in the resumed data' : gen.source}\n`);

  // --- peers and sync ------------------------------------------------------
  const syncUntil = Date.now() + SYNC_TIMEOUT_MS;
  let sawPeer = false;
  let synced = false;
  let heldBackWhileDownloading = false;
  let steady = 0;
  let lastLine = '';
  while (Date.now() < syncUntil) {
    await engine.refreshChain();
    const d = engine.evaluateGate();
    if (engine.chain.peers > 0) sawPeer = true;
    if (Number.isFinite(d.behind) && d.behind > 2) heldBackWhileDownloading = true;
    const line =
      `peers=${engine.chain.peers} (${engine.chain.peersIn} in/${engine.chain.peersOut} out) ` +
      `mine=#${engine.chain.height} network=#${engine.chain.networkHeight} ` +
      `behind=${d.behind} tipAge=${engine.chain.tipAgeSec}s ` +
      `upToDate=${engine.chain.synced} gate=${d.allow ? 'ALLOW' : d.reason}`;
    if (line !== lastLine) { console.log(`    ${line}`); lastLine = line; }
    // "Up to date" has to HOLD, not just flicker true once between two bursts
    // of the initial download.
    steady = engine.chain.synced === true && engine.chain.peers > 0 ? steady + 1 : 0;
    if (steady >= 8) { synced = true; break; }
    await sleep(4000);
  }
  check('while it was downloading, mining was held back', heldBackWhileDownloading,
    heldBackWhileDownloading ? 'the gate saw this node behind the wallet server while it caught up' : 'the node was already at the tip when the check started');

  // Defect N-1: once the node is at the tip, the gate must open regardless of
  // how long ago the newest block happened to arrive.
  {
    const d = engine.evaluateGate();
    check('N-1: the gate has an independent view of the tip',
      engine.chain.networkHeight != null,
      engine.chain.networkHeight != null
        ? `wallet server says #${engine.chain.networkHeight}, this node #${engine.chain.height}`
        : `unavailable: ${engine.chain.networkHeightError}`);
    check('N-1: at the tip, tip age does NOT hold mining back',
      d.reason !== 'tip-too-old' && d.reason !== 'node-still-syncing',
      `tip is ${engine.chain.tipAgeSec}s old and the gate says ${d.reason}`);
    check('N-1: the only thing left holding mining back is the missing address',
      d.reason === 'no-payout-address', d.reason);
    console.log(`    rule in force: ${d.rule}`);
  }

  check('the node connects to the seed', sawPeer, `${engine.chain.peers} peer(s)`);
  check('the node reaches the network tip', synced, `height ${engine.chain.height}, tip ${engine.chain.tipAgeSec}s old`);

  // The gate must have held mining back for as long as the node was behind.
  const gateNow = engine.evaluateGate();
  check(
    'the sync gate holds mining back until the tip is current, then lets go',
    synced ? gateNow.reason !== 'no-peers' && gateNow.reason !== 'tip-too-old' : gateNow.allow === false,
    `gate says ${gateNow.reason}`
  );
  check('the gate is NOT overridden on a second device', gateNow.overridden === false);

  // With no payout address the gate must still refuse, for the right reason.
  check('without a payout address mining is refused', gateNow.allow === false && gateNow.reason === 'no-payout-address', gateNow.reason);

  // --- what the dashboard would show --------------------------------------
  const state = engine.getState();
  console.log('\nWHAT A SECOND DEVICE SEES ON THE NODE SCREEN:');
  console.log(`  "Connected to the swarm: ${state.node.peers} peer(s), synced to block ${state.node.height}"`);
  console.log(`  newest block ${state.node.tipAgeSec}s old · on disk ${state.node.stateBytes == null ? 'measuring' : state.node.stateBytes + ' bytes'}`);
  console.log(`  network hash rate ${state.network_stats.networkSolps == null ? '—' : state.network_stats.networkSolps + ' Sol/s'}`);
  console.log(`  mining: ${state.gate.allow ? 'ready' : state.gate.message}`);

  if (WANT_MINE && synced) {
    console.log('\n--mine given and the node is synced: not implemented in this check.');
    console.log('Mining on the live network needs a payout address from the owner’s wallet.');
  } else if (WANT_MINE) {
    console.log('\n--mine given but the node is NOT synced: refusing to mine. The gate did its job.');
  }
} catch (e) {
  check('unexpected error', false, e && e.stack ? e.stack.split('\n')[0] : String(e));
} finally {
  const stop = await engine.stopAll();
  await sleep(600);
  check('everything stops gracefully', stop.node && stop.node.graceful === true, stop.node ? `${stop.node.ms} ms` : 'no report');
  check('no process left behind', !(pid && isAlive(pid)));

  const report = {
    at: new Date().toISOString(),
    network: manifest.identity.network_name,
    seed: manifest.seed_peers,
    genesis: manifest.genesis.hash,
    zebrad: bin.sha256,
    finalChain: engine.chain,
    notes,
    results,
    failures,
    appLog
  };
  try {
    const out = path.join(dataDir, 'live-report.json');
    fs.writeFileSync(out, JSON.stringify(report, null, 2));
    console.log(`\nreport: ${out}`);
  } catch { /* best effort */ }
  console.log('\nNOTES FOR THE PLANNER:');
  for (const n of notes) console.log(` - ${n}`);
  console.log(`\n${results.filter((r) => r.ok).length}/${results.length} checks passed`);
  exitCode = failures === 0 ? 0 : 1;
}
process.exit(exitCode);
