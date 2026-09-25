'use strict';

// The SWARM mainnet configuration, and the golden copy of the testnet one.
//
// Two things are being held still here.
//
// 1. TODAY'S BEHAVIOUR. The testnet configuration this app writes is the one
//    thing every running node already agrees on. The golden file in
//    test/fixtures is a byte-for-byte copy of it, so adding a second network
//    cannot change the first by accident.
//
// 2. WHAT MAINNET MAY SAY. SwarmMainnet's definition is compiled into the
//    node: the magic, the difficulty limit, the halving schedule, the
//    activation heights, the 8/4/8 split. The configuration supplies only the
//    genesis hash, the three destinations and two ports — so the test asserts
//    what is ABSENT as much as what is present.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { generateZebraConfig, ConfigError } = require('../electron/chain/config-gen');

const TESTNET = require('../electron/net/network.json');
const MAINNET = require('./fixtures/swarm-mainnet-manifest.json');
const GOLDEN = path.join(__dirname, 'fixtures', 'golden-swarm-testnet-zebrad.toml');

const TESTNET_OPTS = {
  dataDir: 'C:/SWARM/chain',
  rpcPort: 18232,
  cpuThreads: 2,
  minerAddress: 'tmJymvcUCn1ctbghvTJpXBwHiMEB8P6wxNV',
  internalMiner: false,
  enforceHealthGate: true
};

const MAIN_OPTS = {
  dataDir: 'C:/SWARM/chain-mainnet',
  cpuThreads: 2,
  minerAddress: 's1MCkDhVejM4RqDyRR1rEJkudd26FVWipPD',
  internalMiner: false
};

const clone = (o) => JSON.parse(JSON.stringify(o));

// ------------------------------------------------- the testnet, unchanged

test('the whole testnet configuration is byte for byte what it was', () => {
  const golden = fs.readFileSync(GOLDEN);
  assert.ok(!golden.includes(0x0d), 'the golden file must have LF line endings; check .gitattributes');
  const mine = Buffer.from(generateZebraConfig(TESTNET, TESTNET_OPTS), 'utf8');
  if (!golden.equals(mine)) {
    // Show the first differing line rather than two 2 kB blobs.
    const a = golden.toString('utf8').split('\n');
    const b = mine.toString('utf8').split('\n');
    const i = a.findIndex((l, n) => l !== b[n]);
    assert.fail(`line ${i + 1} drifted:\n  was: ${JSON.stringify(a[i])}\n  now: ${JSON.stringify(b[i])}`);
  }
});

// ------------------------------------------------------ the mainnet shape

test('SWARM mainnet renders the SwarmMainnet selection, never Mainnet', () => {
  const toml = generateZebraConfig(MAINNET, MAIN_OPTS);
  assert.match(toml, /^network = "SwarmMainnet"$/m);
  assert.doesNotMatch(toml, /^network = "(Mainnet|main|Testnet|Regtest)"$/m);
  assert.match(toml, /^\[network\.swarm_main\]$/m);
  assert.doesNotMatch(toml, /\[network\.testnet_parameters\]/);
});

test('the three values the launch ceremony produces are the only ones supplied', () => {
  const toml = generateZebraConfig(MAINNET, MAIN_OPTS);
  assert.match(toml, /^genesis_hash = "11112222333344445555666677778888999900001111222233334444fedcba98"$/m);
  assert.match(toml, /^\[network\.swarm_main\.funding_stream_addresses\]$/m);
  assert.match(toml, /^core_development = "s3XQAEbW98DwCkm2BVbeXnkjYCHTfbVSdQH"/m);
  assert.match(toml, /^grants_ecosystem = "s3Ya32FvTepiaNQVZbE7outyXuvFe1rqmbF"/m);
  assert.match(toml, /^community_reserve = "s3keLR3h9JgxCarwHpaRDptdR4nZNXD6qBv"/m);
  assert.match(toml, /^p2p_port = 28233$/m);
  assert.match(toml, /^rpc_port = 28232$/m);
});

test('nothing that defines the network itself is configurable', () => {
  const toml = generateZebraConfig(MAINNET, MAIN_OPTS);
  for (const forbidden of [
    /network_magic/,            // SWMN is compiled in
    /target_difficulty_limit/,  // as is the bound
    /activation_heights/,       // every upgrade at height 1, in the node
    /pre_blossom_halving_interval/,
    /funding_streams = \[/,     // the 8/4/8 split is not data here
    /slow_start_interval/,
    /disable_pow/
  ]) {
    assert.doesNotMatch(toml, forbidden, `${forbidden} must not be configurable on a production network`);
  }
});

test('a SWARM node never dials a Zcash seeder', () => {
  const toml = generateZebraConfig(MAINNET, MAIN_OPTS);
  assert.match(toml, /^initial_mainnet_peers = \[\]$/m);
  assert.match(toml, /^initial_testnet_peers = \[\]$/m);
  assert.match(toml, /^initial_swarm_main_peers = \["seed\.example\.invalid:28233"\]$/m);
});

test('the mainnet node keeps its own data folder and loopback RPC', () => {
  const toml = generateZebraConfig(MAINNET, MAIN_OPTS);
  assert.match(toml, /^cache_dir = "C:\/SWARM\/chain-mainnet\/state"$/m);
  assert.match(toml, /^listen_addr = "127\.0\.0\.1:28232"$/m);
  assert.match(toml, /^enable_cookie_auth = true$/m);
  // The testnet's "do not wait for the public chain tip" debug switch has no
  // business on a production network.
  assert.doesNotMatch(toml, /debug_enable_at_height/);
  assert.doesNotMatch(toml, /enforce_on_test_networks/);
});

test('the payout address written for the miner is the one that was validated', () => {
  assert.match(generateZebraConfig(MAINNET, MAIN_OPTS), /^miner_address = "s1MCkDhVejM4RqDyRR1rEJkudd26FVWipPD"$/m);
  const none = generateZebraConfig(MAINNET, { ...MAIN_OPTS, minerAddress: null });
  assert.doesNotMatch(none, /^miner_address/m);
  assert.match(none, /^internal_miner = false$/m);
});

// --------------------------------------------------------- what it refuses

test('a mainnet definition with no genesis hash produces no configuration', () => {
  const m = clone(MAINNET);
  m.genesis.hash = '';
  assert.throws(() => generateZebraConfig(m, MAIN_OPTS), (e) => e instanceof ConfigError && /genesis\.hash/.test(e.message));
});

test('a testnet destination cannot be paid on mainnet', () => {
  const m = clone(MAINNET);
  m.economics.recipients[1].address = 't2Li46A4YNFqRDvdKA212w7DtsLkbGMG2xU';
  assert.throws(() => generateZebraConfig(m, MAIN_OPTS), /starting "s3"/);
});

test('a missing destination stops the node rather than paying two slots', () => {
  const m = clone(MAINNET);
  m.economics.recipients.splice(2, 1);
  assert.throws(() => generateZebraConfig(m, MAIN_OPTS), /no community_reserve destination/);
  const dup = clone(MAINNET);
  dup.economics.recipients[2].swarm_slot = 'core_development';
  dup.economics.recipients[2].upstream_slot = 'ECC';
  assert.throws(() => generateZebraConfig(dup, MAIN_OPTS), /claim the core_development slot/);
});

test('a manifest naming upstream Zcash is refused whatever else it says', () => {
  for (const kind of ['Mainnet', 'mainnet', 'main', 'Regtest']) {
    const m = clone(MAINNET);
    m.identity.network_kind = kind;
    assert.throws(() => generateZebraConfig(m, MAIN_OPTS), /does not run a mainnet/);
  }
  const named = clone(MAINNET);
  named.identity.network_name = 'Mainnet';
  assert.throws(() => generateZebraConfig(named, MAIN_OPTS), /does not run a mainnet/);
});

test('a network that is neither of the two is refused rather than guessed at', () => {
  const m = clone(MAINNET);
  m.identity.network_kind = 'SomethingElse';
  assert.throws(() => generateZebraConfig(m, MAIN_OPTS), /no SWARM network profile matches/);
});

test('the generated text is checked one last time before it is returned', () => {
  const { assertNotUpstream } = require('../electron/chain/config-gen');
  assert.throws(() => assertNotUpstream('[network]\nnetwork = "Mainnet"\n'), /never runs upstream Zcash/);
  assert.doesNotThrow(() => assertNotUpstream('[network]\nnetwork = "SwarmMainnet"\n'));
});
