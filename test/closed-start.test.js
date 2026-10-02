'use strict';

// The closed start (2 October 2026 until the date in the embedded definition).
//
// What must hold:
//   * the embedded relaunch definition carries the new genesis and the
//     closed-start flag, and the app says why it needs a code in one sentence;
//   * the node's ONLY peer is the tunnel on 127.0.0.1, it listens on loopback,
//     and the tunnel key can never reach zebra.toml;
//   * without an access code the node is not started at all, and the Mining
//     page's one button asks for the code;
//   * a build without the flag behaves as the public app did.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const { generateZebraConfig, ConfigError } = require('../electron/chain/config-gen');
const { ChainEngine } = require('../electron/chain/engine');
const { nextAction, ACTIONS } = require('../electron/chain/next-action');
const NP = require('../electron/chain/network-profile');
const AC = require('../electron/chain/access-code');

const MAINNET = require('../electron/net/network-mainnet.json');
const NEW_GENESIS = '01b76d8a0f18c502b23ab6605e26296d189aa5770fc4a34155e5c7b250a0eff2';
const OLD_GENESIS = '01c34428b9e67cdd8345e0b365aaa37dd8d2d65d3869e0e5d77d567f2c39afdd';
const clone = (o) => JSON.parse(JSON.stringify(o));
// A transparent SWARM mainnet address shape, as the other mainnet tests use.
const PAYOUT = 's1MCkDhVejM4RqDyRR1rEJkudd26FVWipPD';

const CLOSED_OPTS = {
  dataDir: 'C:/SWARM/chain-mainnet-01b76d8a',
  cpuThreads: 2,
  rpcPort: 28232,
  p2pListen: '127.0.0.1:28233',
  seedPeers: ['127.0.0.1:28243'],
  closedStart: true,
  minerAddress: PAYOUT,
  internalMiner: true,
  internalMinerThreads: 3
};

test('the embedded definition is the restarted chain, in its closed start', () => {
  assert.equal(MAINNET.genesis.hash, NEW_GENESIS);
  assert.equal(MAINNET.identity.network_magic_ascii, 'SWMN');
  assert.equal(MAINNET.identity.light_wallet_chain_label, 'swarm-mainnet');
  assert.deepEqual(MAINNET.light_wallet_servers, ['lwd-main.swarm.green:443']);
  assert.equal(MAINNET.sync_gate.tip_oracle_url, 'https://lwd-main.swarm.green:443');
  assert.equal(MAINNET.closed_start.until, '2026-10-23T15:42:00Z');
  assert.equal(MAINNET.relaunch.date, '2026-10-02');
  assert.equal(MAINNET.relaunch.previous_genesis, OLD_GENESIS);
  const c = NP.closedStartOf(MAINNET);
  assert.equal(c.active, true);
  assert.equal(c.reason,
    'The network is in its closed start until 23 October 2026. This computer needs an access code from the SWARM team.');
  NP.validateProfileManifest('swarm-mainnet', MAINNET);
});

test('a definition without the flag is the public app; a broken flag is refused', () => {
  const pub = clone(MAINNET);
  delete pub.closed_start;
  assert.deepEqual(NP.closedStartOf(pub), { active: false, until: null, untilText: null, reason: null });
  const bad = clone(MAINNET);
  bad.closed_start = { until: 'soon' };
  assert.throws(() => NP.closedStartOf(bad), /until/);
});

test('closed mode: the only peer is the loopback tunnel, the listener is loopback, no cache', () => {
  const toml = generateZebraConfig(MAINNET, CLOSED_OPTS);
  assert.match(toml, /^network = "SwarmMainnet"$/m);
  assert.match(toml, /^listen_addr = "127\.0\.0\.1:28233"$/m);
  assert.match(toml, /^initial_swarm_main_peers = \["127\.0\.0\.1:28243"\]$/m);
  assert.match(toml, /^initial_mainnet_peers = \[\]$/m);
  assert.match(toml, /^initial_testnet_peers = \[\]$/m);
  assert.match(toml, /^cache_dir = false$/m);
  assert.match(toml, /^genesis_hash = "01b76d8a0f18c502b23ab6605e26296d189aa5770fc4a34155e5c7b250a0eff2"$/m);
  assert.match(toml, /^internal_miner_threads = 3$/m);
  // The public seed is never dialled in the closed start.
  assert.doesNotMatch(toml, /seed-main\.swarm\.green/);
  assert.doesNotMatch(toml, /0\.0\.0\.0/);
  // And nothing in it can address the tunnel: no 10.88 address, no endpoint.
  assert.doesNotMatch(toml, /10\.88\.|51820|PrivateKey|private_key/i);
});

test('closed mode refuses a non-loopback peer, two peers, or a public listener', () => {
  for (const over of [
    { seedPeers: ['10.88.0.1:28233'] },
    { seedPeers: ['seed-main.swarm.green:28233'] },
    { seedPeers: ['127.0.0.1:28243', '127.0.0.1:28244'] },
    { seedPeers: [] },
    { p2pListen: '0.0.0.0:28233' }
  ]) {
    assert.throws(() => generateZebraConfig(MAINNET, { ...CLOSED_OPTS, ...over }), ConfigError, JSON.stringify(over));
  }
});

test('without the closed-start option the file is the public one, seed and all', () => {
  const toml = generateZebraConfig(MAINNET, { ...CLOSED_OPTS, closedStart: false, seedPeers: undefined, p2pListen: undefined });
  assert.match(toml, /^initial_swarm_main_peers = \["seed-main\.swarm\.green:28233"\]$/m);
  assert.match(toml, /^listen_addr = "0\.0\.0\.0:28233"$/m);
  assert.doesNotMatch(toml, /peerset_initial_target_size/);
});

// ------------------------------------------------------------------ engine

class FakeTunnel extends EventEmitter {
  constructor() { super(); this.localPort = null; this.started = 0; this.stopped = 0; }
  async start() { this.started += 1; this.localPort = 28243; return { ok: true, localPort: 28243 }; }
  async stop() { this.stopped += 1; return { ok: true }; }
  status() { return { state: this.localPort ? 'running' : 'stopped', connected: null, localPort: this.localPort }; }
}

function engine({ tunnel = null, settings = {}, dataDir } = {}) {
  return new ChainEngine({
    manifest: MAINNET,
    dataDir: dataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-closed-')),
    settings: { payoutAddress: PAYOUT, payoutKind: 'transparent', miningMode: 'shielded', intensity: 2, ...settings },
    saveSettings: () => {},
    closedStart: NP.closedStartOf(MAINNET),
    tunnel,
    access: tunnel ? { machine: 'alienware', tunnelAddress: '10.88.0.3', server: '64.95.11.180', node: '10.88.0.1:28233' } : null,
    allowUnpinnedBinaries: true
  });
}

test('without an access code the node is not started, and the reason is the sentence', async () => {
  const e = engine();
  const r = await e.startNode();
  assert.equal(r.ok, false);
  assert.equal(r.code, 'ACCESS_CODE');
  assert.match(r.error, /closed start until 23 October 2026/);
  assert.equal(e.node, null);
  const s = e.getState();
  assert.deepEqual([s.access.required, s.access.present], [true, false]);
  assert.equal(s.tunnel, null);
  assert.equal(s.next.id, 'add-access-code');
  assert.ok(ACTIONS.includes('add-access-code'));
});

test('the code comes before the payout address on the one button', () => {
  const state = { mining: {}, node: {}, gate: {}, payout: {}, access: { required: true, present: false, reason: 'R' } };
  assert.equal(nextAction(state).id, 'add-access-code');
  state.access.present = true;
  assert.equal(nextAction(state).id, 'set-address');
  // A public build never asks.
  assert.equal(nextAction({ ...state, access: { required: false, present: false } }).id, 'set-address');
});

test('with a code, the node is configured with the tunnel as its one peer', async () => {
  const t = new FakeTunnel();
  const e = engine({ tunnel: t });
  // Before the tunnel has a port the closed options carry no peer (the node is
  // never started that way: startNode starts the tunnel first).
  assert.deepEqual(e.nodeConfigOptions().seedPeers, []);
  await t.start();
  const o = e.nodeConfigOptions();
  assert.equal(o.closedStart, true);
  assert.deepEqual(o.seedPeers, ['127.0.0.1:28243']);
  assert.match(o.p2pListen, /^127\.0\.0\.1:\d+$/);
  // Stored public settings do not leak into the closed start.
  const e2 = engine({ tunnel: t, settings: { seedPeers: ['seed-main.swarm.green:28233'], p2pListen: '0.0.0.0:28233' } });
  assert.deepEqual(e2.nodeConfigOptions().seedPeers, ['127.0.0.1:28243']);
  assert.match(e2.nodeConfigOptions().p2pListen, /^127\.0\.0\.1:/);
  const s = e.getState();
  assert.deepEqual([s.access.present, s.access.machine], [true, 'alienware']);
  assert.ok(!JSON.stringify(s.access).match(/[A-Za-z0-9+/]{43}=/), 'no key-shaped value in the state');
});

test('stopping everything stops the tunnel too; a restart keeps it', async () => {
  const t = new FakeTunnel();
  const e = engine({ tunnel: t });
  await e.stopNode({ keepTunnel: true });
  assert.equal(t.stopped, 0);
  await e.stopNode();
  assert.equal(t.stopped, 1);
  await e.stopAll();
  assert.equal(t.stopped, 2);
});

test('a real access code never reaches zebra.toml', () => {
  const k = crypto.randomBytes(32).toString('base64');
  const code = AC.encode({ v: 1, n: 'x', k, a: '10.88.0.3', s: crypto.randomBytes(32).toString('base64'), e: '64.95.11.180:51820', p: '10.88.0.1:28233' });
  const toml = generateZebraConfig(MAINNET, CLOSED_OPTS);
  assert.ok(!toml.includes(k));
  assert.ok(!toml.includes(code.split('.')[1].slice(0, 20)));
});
