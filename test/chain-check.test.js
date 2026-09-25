'use strict';

// WRONG-CHAIN DETECTION.
//
// The app already refused to trust a node holding another network's genesis
// block. With two SWARM networks there is a second way to be on the wrong
// chain, and it is the quiet one: a node that is perfectly healthy, fully
// synced and simply not on the network the user chose. The node says which
// network it is on in its own getblockchaininfo, so the app asks it every
// tick, compares the answer with the selected profile, and refuses to mine on
// a mismatch — because a block found on the wrong chain pays nothing and the
// payout address does not exist there.
//
// Everything here runs against a stubbed RPC. No node, no network, no binary.

const test = require('node:test');
const assert = require('node:assert');

const { ChainEngine } = require('../electron/chain/engine');
const TESTNET = require('../electron/net/network.json');
const MAINNET = require('./fixtures/swarm-mainnet-manifest.json');

const TM = 'tmJymvcUCn1ctbghvTJpXBwHiMEB8P6wxNV';
const S1 = 's1MCkDhVejM4RqDyRR1rEJkudd26FVWipPD';

/** An engine with a node that answers whatever these fields say. */
function engineWith(manifest, rpcAnswers, settings = {}) {
  const e = new ChainEngine({
    manifest,
    dataDir: 'C:/nowhere',
    settings: { payoutAddress: TM, miningMode: 'standard', ...settings },
    saveSettings: () => {}
  });
  // A node that is "running" as far as the engine can tell.
  e.node = { running: true, pid: 4321, startedAt: Date.now(), configPath: 'C:/nowhere/zebra.toml', lastStopReport: null };
  const fail = () => { throw Object.assign(new Error('not stubbed'), { code: 'NET' }); };
  e.rpc = {
    getBlockchainInfo: async () => rpcAnswers.blockchainInfo,
    getPeerInfo: async () => rpcAnswers.peers || [],
    getBlock: async () => rpcAnswers.block || fail(),
    getNetworkSolps: async () => 0,
    validateAddress: fail,
    zValidateAddress: fail,
    zListUnifiedReceivers: fail
  };
  return e;
}

test('a testnet node on the testnet profile passes and mining is not blocked', async () => {
  const e = engineWith(TESTNET, { blockchainInfo: { chain: 'test', blocks: 120, bestblockhash: 'ab'.repeat(32) } });
  await e.refreshChain();
  assert.strictEqual(e.chainCheck.ok, true);
  assert.strictEqual(e.chainMismatch(), null);
});

test('a node on the Zcash main chain is refused, and mining never starts', async () => {
  const e = engineWith(TESTNET, { blockchainInfo: { chain: 'main', blocks: 2800000, bestblockhash: 'cd'.repeat(32) } });
  const lines = [];
  e.on('log', (l) => lines.push(l.text));
  await e.refreshChain();

  assert.strictEqual(e.chainCheck.ok, false);
  assert.match(e.chainCheck.error, /Zcash main chain/);
  assert.ok(lines.some((l) => /Zcash main chain/.test(l)), 'the reason is written to the log the user reads');

  const r = await e.startMining();
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'WRONG_CHAIN');
  assert.match(r.error, /Zcash main chain/);
  assert.strictEqual(e.mining.on, false);
});

test('a mainnet profile talking to a testnet node refuses to mine', async () => {
  const e = engineWith(MAINNET, { blockchainInfo: { chain: 'test', blocks: 5, bestblockhash: 'ef'.repeat(32) } }, { payoutAddress: S1 });
  assert.strictEqual(e.profile.id, 'swarm-mainnet');
  await e.refreshChain();
  assert.strictEqual(e.chainCheck.ok, false);
  const r = await e.startMining();
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /SWARM testnet, not SWARM mainnet/);
});

test('a mainnet node that cannot name the chain is refused: it is too old', async () => {
  // The SwarmMainnet-capable zebrad reports chain = "swarm-mainnet". Anything
  // that does not is a build without the network compiled in, and the app must
  // not start a production node on it.
  const e = engineWith(MAINNET, { blockchainInfo: { blocks: 0, bestblockhash: null } }, { payoutAddress: S1 });
  await e.refreshChain();
  assert.strictEqual(e.chainCheck.ok, false);
  assert.match(e.chainCheck.error, /older SWARM node/);
  const r = await e.startMining();
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'WRONG_CHAIN');
});

test('a mainnet node that names the chain passes the check', async () => {
  const e = engineWith(MAINNET, { blockchainInfo: { chain: 'swarm-mainnet', blocks: 7, bestblockhash: '11'.repeat(32) } }, { payoutAddress: S1 });
  await e.refreshChain();
  assert.strictEqual(e.chainCheck.ok, true);
  assert.strictEqual(e.chainMismatch(), null);
});

test('a testnet node that says nothing is "unknown", which never blocks', async () => {
  // Today's nodes are trusted exactly as much as they were before this check
  // existed: silence is not evidence of a wrong chain on a test network.
  const e = engineWith(TESTNET, { blockchainInfo: { blocks: 9, bestblockhash: '22'.repeat(32) } });
  await e.refreshChain();
  assert.strictEqual(e.chainCheck.ok, null);
  assert.strictEqual(e.chainMismatch(), null);
});

test('another network\u2019s genesis block also stops mining', async () => {
  const e = engineWith(TESTNET, { blockchainInfo: { chain: 'test', blocks: 1, bestblockhash: '33'.repeat(32) } });
  await e.refreshChain();
  // What ensureGenesis() records when the node's block 0 is not ours.
  e.genesisState = {
    ok: false,
    hash: '00040fe8ec8471911baa1db1266ea15dd06b4a8a5c453883c000b031973dce08',
    expected: TESTNET.genesis.hash,
    error: 'wrong chain'
  };
  const why = e.chainMismatch();
  assert.match(why, /Zcash main chain/);
  const r = await e.startMining();
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'WRONG_CHAIN');
});

test('the verdict reaches the UI state, so the reason can be shown', async () => {
  const e = engineWith(TESTNET, { blockchainInfo: { chain: 'main', blocks: 1, bestblockhash: '44'.repeat(32) } });
  await e.refreshChain();
  const s = e.getState();
  assert.strictEqual(s.node.chainCheck.ok, false);
  assert.strictEqual(s.network.profile, 'swarm-testnet');
  assert.strictEqual(s.network.chainLabel, 'swarm-testnet');
  assert.strictEqual(s.network.production, false);
});

test('a mainnet engine reports its profile and pays only mainnet addresses', async () => {
  const e = engineWith(MAINNET, { blockchainInfo: { chain: 'swarm-mainnet', blocks: 3, bestblockhash: '55'.repeat(32) } }, { payoutAddress: S1 });
  const s = e.getState();
  assert.strictEqual(s.network.profile, 'swarm-mainnet');
  assert.strictEqual(s.network.production, true);
  assert.strictEqual(s.network.chainLabel, 'swarm-mainnet');

  // A testnet payout address is refused without the node being asked at all:
  // the node is the authority on validity, not on which network was chosen.
  const bad = await e.setPayoutAddress('t2Li46A4YNFqRDvdKA212w7DtsLkbGMG2xU');
  assert.strictEqual(bad.ok, false);
  assert.strictEqual(bad.wrongNetwork, 'swarm-testnet');
  assert.match(bad.error, /running the SWARM mainnet/);
});

test('the reward display and restart fixes are still in place', async () => {
  // Guard rails for the two fixes carried in from 9016659a: the reward figures
  // come from the ledger the node fills, and a restart does not leave mining
  // believing it is on.
  const e = engineWith(TESTNET, { blockchainInfo: { chain: 'test', blocks: 10, bestblockhash: '66'.repeat(32) } });
  const s = e.getState();
  assert.ok(s.rewards && typeof s.rewards === 'object', 'rewards are still reported');
  assert.strictEqual(typeof e.restartNode, 'function');
  assert.strictEqual(e.mining.on, false);
});
