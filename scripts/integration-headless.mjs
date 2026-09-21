// End-to-end integration test of the packaged app's engine layer, with no
// Electron and no window.
//
// It drives the SAME ChainEngine the app drives, against a THROWAWAY network
// that cannot reach any other chain: its own name and magic, no seed peers,
// and loopback ports well outside the blocks any other SWARM process uses.
//
//   node scripts/integration-headless.mjs
//
// Steps, each of which must pass:
//   1  refuse to start on a manifest with no genesis hash
//   2  start the node from a generated config
//   3  hand it the genesis block (first-node mode)
//   4  refuse to mine while the sync gate is closed
//   5  accept the confirmed first-node override
//   6  validate the payout address by asking the node
//   7  mine blocks with Zebra's internal miner
//   8  check every dashboard number against a fresh RPC read
//   9  stop everything gracefully, leaving no process behind

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
const { generateZebraConfig } = require(path.join(ROOT, 'electron/chain/config-gen.js'));
const { splitSubsidy } = require(path.join(ROOT, 'electron/chain/rewards.js'));

// Zebra's own documented default Testnet unified miner address, from
// zebra-rpc/src/config/mining.rs at v6.3.0. Nobody holds its keys and the coins
// are worthless; it exists so the shielded path can be exercised without any
// wallet, key or seed being involved.
const UNIFIED = 'utest10a8k6aw5w33kvyt7x6fryzu7vvsjru5vgcfnvr288qx2zm6p63ygcajtaze0px08t583dyrgr42vasazjhhnntus2tqrpkzu0dm2l4cgf3ld6wdqdrf3jv8mvfx9c80e73syer9l2wlgawjtf7yvj0eqwdf354trtelxnr0fhpw9792eaf49ghstkyftc9lwqqwy4ye0cleagp4nzyt';

// Zebra's own documented default Testnet TRANSPARENT miner address, from
// zebra-rpc/src/config/mining.rs at v6.3.0. Worthless coins on a throwaway
// network; no key of anybody's is involved.
const TRANSPARENT = 'tmJymvcUCn1ctbghvTJpXBwHiMEB8P6wxNV';

const WANT_BLOCKS = Number(process.env.SWARM_IT_BLOCKS) || 3;
const MINE_TIMEOUT_MS = Number(process.env.SWARM_IT_TIMEOUT) || 360000;

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'test/fixtures/throwaway-network.json'), 'utf8'));
// The canonical manifest names the P2P port public_p2p; keep one local alias.
const P2P = manifest.ports.p2p != null ? manifest.ports.p2p : manifest.ports.public_p2p;
const RPC = manifest.ports.rpc;
const atomic = manifest.economics.atomic_unit_per_coin;
const dataDir = process.env.SWARM_NODE_TEST_DIR || path.join(os.tmpdir(), 'swarm-node-integration');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
let failures = 0;

function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail === undefined ? null : detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail != null ? `  — ${detail}` : ''}`);
  if (!ok) failures += 1;
  return ok;
}

// A hard safety rail: this test must never be able to touch the live network.
for (const port of [P2P, RPC]) {
  if ((port >= 19300 && port < 19400) || (port >= 19500 && port < 19600) ||
      (port >= 19700 && port < 19800) || port === 18500 || port === 18232 || port === 18233) {
    console.error(`refusing to run: port ${port} is reserved for another SWARM network`);
    process.exit(2);
  }
}
if (manifest.identity.network_name === 'SwarmTestnet' || manifest.seed_peers.length) {
  console.error('refusing to run: the fixture must be a throwaway network with no seed peers');
  process.exit(2);
}

const bin = requireBinary('zebrad', { allowUnpinned: true });
if (!bin.ok) {
  console.error(`zebrad is not available: ${bin.reason}`);
  console.error('Set SWARM_NODE_BIN_DIR to a folder containing zebrad.exe.');
  process.exit(2);
}

console.log(`network : ${manifest.identity.network_name} (magic ${manifest.identity.network_magic.join(',')})`);
console.log(`ports   : p2p ${P2P}, rpc ${RPC} (loopback)`);
console.log(`zebrad  : ${bin.path}`);
console.log(`sha256  : ${bin.sha256}`);
console.log(`data    : ${dataDir}\n`);

fs.rmSync(dataDir, { recursive: true, force: true });
fs.mkdirSync(path.join(dataDir, 'state'), { recursive: true });

const settings = {
  consented: true,
  payoutAddress: '',
  payoutKind: null,
  miningMode: 'shielded',
  intensity: 1,
  idleOnly: false,
  autoResume: false,
  firstNodeOverride: false,
  dataDir,
  p2pPort: P2P,
  rpcPort: RPC,
  p2pListen: `127.0.0.1:${P2P}`,
  seedPeers: [],
  nodeThreads: 2,
  zebraHealthGate: true,
  stopTimeoutMs: 25000
};

const engine = new ChainEngine({
  manifest,
  dataDir,
  settings,
  saveSettings: () => {},
  allowUnpinnedBinaries: true,
  idleSeconds: null
});
const logLines = [];
engine.on('log', (l) => { logLines.push(l); });

const rpc = new ZebraRpc({ host: '127.0.0.1', port: RPC, cookieDir: dataDir });

let nodePid = null;

async function main() {
  // --- 1. a build without a genesis hash must refuse to start a node -------
  {
    const blank = JSON.parse(JSON.stringify(manifest));
    blank.genesis.hash = null;
    let threw = null;
    try { generateZebraConfig(blank, { dataDir }); } catch (e) { threw = e.message; }
    check('1  refuses to configure a node with no genesis hash', !!threw && /genesis\.hash is empty/.test(threw), threw);
  }

  // --- 5. the first-node override, before anything starts ------------------
  // This network has no peers at all, so without the override there is nobody
  // to send block 0 and nobody to confirm a block.
  {
    const wrong = await engine.setFirstNodeOverride(true, 'yes please');
    check('5  a wrong confirmation phrase is refused', wrong.ok === false, wrong.error);
    const ok = await engine.setFirstNodeOverride(true, 'FIRST NODE');
    check('5b the typed confirmation turns the override on', ok.ok === true && ok.firstNode === true);
  }

  // --- 2. start the node ---------------------------------------------------
  const started = await engine.startNode();
  nodePid = started.pid;
  check('2  node starts from the generated config', started.ok === true, `pid ${started.pid}`);
  if (!started.ok) return;

  const upUntil = Date.now() + 90000;
  let up = false;
  while (Date.now() < upUntil) {
    try { if (await rpc.getInfo()) { up = true; break; } } catch { /* not yet */ }
    await sleep(500);
  }
  check('2b RPC answers on loopback with cookie auth', up);
  if (!up) return;

  // --- 3. genesis ----------------------------------------------------------
  // No peer exists here, so the app has to fall back to the bytes it ships.
  const seeded = await engine.ensureGenesis();
  let genesisHash = null;
  try { genesisHash = await rpc.getBlockHash(0); } catch { /* reported below */ }
  check('3  the node accepted the genesis block', genesisHash === manifest.genesis.hash, `${genesisHash} (${seeded.source || seeded.error})`);
  check('3b the app verified the genesis hash against its manifest', seeded.ok === true && seeded.hash === manifest.genesis.hash);

  // --- 6. payout address ---------------------------------------------------
  {
    const bad = await engine.setPayoutAddress('tmNotARealAddressAtAll123456');
    check('6  the node rejects an invalid address', bad.ok === false, bad.error);

    const good = await engine.setPayoutAddress(UNIFIED);
    check('6b the node identifies the unified address', good.ok === true && good.kind === 'unified', good.kind || good.error);
    check('6c a unified address allows shielded mining only', JSON.stringify(good.modes) === JSON.stringify(['shielded']), JSON.stringify(good.modes));

    // A unified address must NOT be accepted for the transparent engine.
    await engine.setMiningMode('standard');
    await engine.refreshChain();
    const mismatch = engine.evaluateGate();
    check('6d standard mining is blocked by a unified address', mismatch.allow === false && mismatch.reason === 'address-wrong-type-for-mode', mismatch.reason);
    await engine.setMiningMode('shielded');
  }

  // --- 4. the sync gate refuses to mine, now that everything else is ready --
  {
    engine.gate.setFirstNode(false);
    await engine.refreshChain();
    const d = engine.evaluateGate();
    check('4  with no peers and no override, mining is refused', d.allow === false && d.reason === 'no-peers', d.reason);
    const attempt = await engine.startMining();
    check('4b startMining() is refused too, and says why', attempt.ok === false, attempt.error);
    engine.gate.setFirstNode(true);
  }

  // --- 7. mine -------------------------------------------------------------
  await engine.refreshChain();
  const gate = engine.evaluateGate();
  check('7  with the override, the gate allows shielded mining', gate.allow === true && gate.overridden === true, gate.reason);

  const startMine = await engine.startMining();
  check('7b shielded mining starts (the node restarts to pick it up)', startMine.ok === true, JSON.stringify(startMine));
  nodePid = engine.node ? engine.node.pid : nodePid;

  const deadline = Date.now() + MINE_TIMEOUT_MS;
  let height = 0;
  while (Date.now() < deadline) {
    await engine.tick();
    height = engine.chain.height || 0;
    if (engine.ledger.blocks.size >= WANT_BLOCKS) break;
    await sleep(1500);
  }
  check(
    `7c mined at least ${WANT_BLOCKS} blocks with the internal miner`,
    engine.ledger.blocks.size >= WANT_BLOCKS,
    `${engine.ledger.blocks.size} recorded, chain height ${height}`
  );

  // --- 8. the dashboard numbers against a fresh RPC read -------------------
  await engine.tick();
  const state = engine.getState();
  const info = await rpc.getBlockchainInfo();
  const peers = await rpc.getPeerInfo();

  check('8  height on screen equals getblockchaininfo', state.node.height === Number(info.blocks), `${state.node.height} vs ${info.blocks}`);
  check('8b best block hash on screen equals the node’s', state.node.bestHash === info.bestblockhash, state.node.bestHash);
  check('8c peer count on screen equals getpeerinfo', state.node.peers === peers.length, `${state.node.peers} vs ${peers.length}`);
  check('8d blocks found equals what the ledger recorded', state.rewards.blocksFound === engine.ledger.blocks.size, String(state.rewards.blocksFound));
  check('8e shielded rewards are never shown as a spendable balance', state.rewards.spendableZat === 0 && state.rewards.maturingZat === 0);
  check('8f shielded rewards are labelled as such, not claimed', state.rewards.shieldedIsLabelOnly === true && state.rewards.shieldedBlocks > 0);

  // The miner's share must be what the node itself states, and must be 80% of
  // the subsidy — 5.00 SWM of 6.25 in era 0, never 6.25.
  const mined = [...engine.ledger.blocks.values()];
  const expected = splitSubsidy(Math.round(manifest.economics.era0_block_reward_coins * atomic), manifest.economics.recipients).minerZat;
  if (mined.length) {
    const subsidy = await rpc.getBlockSubsidy(mined[0].height);
    const minerZat = Math.round(Number(subsidy.miner) * atomic);
    check('8g the node states the miner share as 80% of the subsidy', minerZat === expected, `${minerZat / atomic} SWM (expected ${expected / atomic})`);
    check('8h 6.25 is never reported as the miner’s income', state.rewards.shieldedSubsidyZat !== Math.round(6.25 * atomic) * state.rewards.shieldedBlocks);
    check(
      '8i honey on screen equals blocks x the stated miner share',
      state.rewards.shieldedSubsidyZat === expected * state.rewards.shieldedBlocks,
      `${state.rewards.shieldedSubsidyZat / atomic} SWM over ${state.rewards.shieldedBlocks} blocks`
    );
    // The three allocations must also be exactly what the manifest promises.
    const streams = Array.isArray(subsidy.fundingstreams) ? subsidy.fundingstreams : [];
    const byAddr = new Map(streams.map((f) => [f.address, Math.round(Number(f.value) * atomic)]));
    let allocOk = streams.length === manifest.economics.recipients.length;
    for (const r of manifest.economics.recipients) {
      const want = Math.round((Math.round(manifest.economics.era0_block_reward_coins * atomic) * r.numerator) / 100);
      if (byAddr.get(r.address) !== want) allocOk = false;
    }
    check('8k the three allocations go to the manifest addresses at 8/4/8%', allocOk,
      streams.map((f) => `${f.recipient}:${f.value}`).join(' '));
  } else {
    check('8g the node states the miner share as 80% of the subsidy', false, 'no blocks were mined');
  }

  // Sol/s must be "—", not an invented figure: the internal miner reports none.
  check('8j hash rate is unknown rather than invented for the internal miner', state.mining.solps === null);

  // --- 9. auto-pause when the gate closes ----------------------------------
  {
    engine.gate.setFirstNode(false);
    engine.settings.autoResume = false;
    await engine.tick();
    check('9  mining pauses by itself when the gate closes', engine.mining.on === false && engine.mining.pausedByGate === true);
    engine.gate.setFirstNode(true);
  }

  // --- 11. the standard engine: N privacy-miner copies, transparent payout --
  // This is the half the shielded run cannot reach: a payout that is visible
  // on the chain, so the amount can be read back and checked rather than
  // labelled.
  if (!engine.standardMiningAvailable()) {
    check('11  standard mining is available', false, 'privacy-miner is not bundled in this build');
    return;
  }

  await engine.stopMiningInternal('switching to the standard engine');
  const before = engine.ledger.blocks.size;

  const t = await engine.setPayoutAddress(TRANSPARENT);
  check('11  the node identifies the transparent address', t.ok === true && t.kind === 'transparent', t.kind || t.error);
  await engine.setMiningMode('standard');
  await engine.setIntensity(2);
  await engine.refreshChain();

  const sm = await engine.startMining();
  check('11b standard mining starts N workers, one core each', sm.ok === true && sm.workers === 2, JSON.stringify(sm));
  check('11c the node was NOT restarted to start or stop the standard miner', engine.node && engine.node.running === true);

  const stdDeadline = Date.now() + MINE_TIMEOUT_MS;
  while (Date.now() < stdDeadline) {
    await engine.tick();
    if (engine.ledger.totals(engine.chain.height || 0).transparentBlocks >= 1) break;
    await sleep(1500);
  }
  const st2 = engine.getState();
  const tBlocks = st2.rewards.transparentBlocks;
  check('11d the standard miner found a block', tBlocks >= 1, `${tBlocks} transparent block(s), height ${engine.chain.height}`);

  if (tBlocks >= 1) {
    const rec = engine.ledger.list().find((b) => b.mode === 'transparent');
    const sub = await rpc.getBlockSubsidy(rec.height);
    const minerZat = Math.round(Number(sub.miner) * atomic);
    check(
      '11e the amount on screen is what the chain actually paid, fees included',
      rec.paidZat >= minerZat,
      `coinbase paid ${rec.paidZat / atomic} SWM, node states a ${minerZat / atomic} SWM subsidy share`
    );
    check('11f a fresh reward is maturing, never spendable', st2.rewards.maturingZat > 0 && st2.rewards.spendableZat === 0,
      `maturing ${st2.rewards.maturingZat / atomic}, spendable ${st2.rewards.spendableZat / atomic}`);
    check('11g maturity counts down from the network’s 100 confirmations',
      st2.rewards.nextMaturesInBlocks != null && st2.rewards.nextMaturesInBlocks <= 100,
      `${st2.rewards.nextMaturesInBlocks} blocks to go`);
  }

  const stopped = await engine.stopMining();
  check('11h stopping the standard miner leaves the node running', stopped.ok === true && engine.node.running === true);
  void before;
}

let exitCode = 1;
try {
  await main();
} catch (e) {
  check('unexpected error', false, e && e.stack ? e.stack.split('\n')[0] : String(e));
} finally {
  // --- 10. stop everything -------------------------------------------------
  const stop = await engine.stopAll();
  await sleep(600);
  const leftover = nodePid && isAlive(nodePid);
  check('10  node stopped gracefully', stop.node && stop.node.graceful === true, stop.node ? `${stop.node.ms} ms, hardKilled=${stop.node.hardKilled}` : 'no report');
  check('10b no process left behind', !leftover, leftover ? `pid ${nodePid} still alive` : 'clean');

  const report = {
    at: new Date().toISOString(),
    network: manifest.identity.network_name,
    zebrad: { path: bin.path, sha256: bin.sha256 },
    dataDir,
    blocksMined: engine.ledger.blocks.size,
    chainHeight: engine.chain.height,
    stop: stop.node,
    results,
    failures,
    // The app's own narration, not the node's firehose: this is what the user
    // would have seen in the log panel.
    appLog: logLines.filter((l) => l.kind === 'app').map((l) => l.text),
    logTail: logLines.slice(-40)
  };
  const out = path.join(dataDir, 'integration-report.json');
  try { fs.writeFileSync(out, JSON.stringify(report, null, 2)); console.log(`\nreport: ${out}`); } catch { /* best effort */ }

  console.log(`\n${results.filter((r) => r.ok).length}/${results.length} checks passed`);
  exitCode = failures === 0 ? 0 : 1;
}
process.exit(exitCode);
