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
//    what is ABSENT as much as what is present. And because a production
//    configuration is read once, by a node nobody can reconfigure afterwards,
//    the mainnet file has a golden copy of its own, rendered from a manifest
//    with the shape the launch ceremony actually produces
//    (network/swarm-mainnet/manifest.template.json with its five placeholders
//    filled): the whole file, byte for byte, seed peer included.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { generateZebraConfig, ConfigError } = require('../electron/chain/config-gen');

const TESTNET = require('../electron/net/network.json');
const MAINNET = require('./fixtures/swarm-mainnet-manifest.json');
const REHEARSAL = require('./fixtures/swarm-mainnet-rehearsal-manifest.json');
const GOLDEN = path.join(__dirname, 'fixtures', 'golden-swarm-testnet-zebrad.toml');
const GOLDEN_MAIN = path.join(__dirname, 'fixtures', 'golden-swarm-mainnet-zebrad.toml');

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

/** The first line that differs, rather than two 2 kB blobs. */
function firstDrift(golden, mine) {
  const g = golden.toString('utf8').split('\n');
  const m = mine.toString('utf8').split('\n');
  const i = g.findIndex((l, n) => l !== m[n]);
  return `line ${i + 1} drifted:\n  was: ${JSON.stringify(g[i])}\n  now: ${JSON.stringify(m[i])}`;
}

// ------------------------------------------------- the testnet, unchanged

test('the whole testnet configuration is byte for byte what it was', () => {
  const golden = fs.readFileSync(GOLDEN);
  assert.ok(!golden.includes(0x0d), 'the golden file must have LF line endings; check .gitattributes');
  const mine = Buffer.from(generateZebraConfig(TESTNET, TESTNET_OPTS), 'utf8');
  if (!golden.equals(mine)) assert.fail(firstDrift(golden, mine));
});

test('the whole mainnet configuration is byte for byte what it was', () => {
  const golden = fs.readFileSync(GOLDEN_MAIN);
  assert.ok(!golden.includes(0x0d), 'the golden file must have LF line endings; check .gitattributes');
  const mine = Buffer.from(generateZebraConfig(REHEARSAL, MAIN_OPTS), 'utf8');
  if (!golden.equals(mine)) assert.fail(firstDrift(golden, mine));
});

test('the seed the manifest names is the seed the node is told to dial', () => {
  // The whole point of `initial_swarm_main_peers`: without it a second
  // SwarmMain node has no way to learn the first one exists, because neither
  // upstream peer list is read on this network and the on-disk peer cache is
  // empty until it has already connected to somebody
  // (privacy-zebra 16c6a210f, zebra-network/src/config.rs).
  assert.deepStrictEqual(REHEARSAL.seed_peers, ['seed-main.swarm.green:28233']);
  const toml = generateZebraConfig(REHEARSAL, MAIN_OPTS);
  assert.match(toml, /^initial_swarm_main_peers = \["seed-main\.swarm\.green:28233"\]$/m);
  // It is a key of [network], so it has to be written before the
  // [network.swarm_main] sub-table: after it, TOML reads it as part of the
  // sub-table and the node rejects the file.
  assert.ok(
    toml.indexOf('initial_swarm_main_peers') < toml.indexOf('[network.swarm_main]'),
    'initial_swarm_main_peers belongs to [network] and must precede [network.swarm_main]'
  );
  // The first node of the chain names nobody, and the key is then left out
  // entirely rather than written empty.
  const alone = generateZebraConfig({ ...REHEARSAL, seed_peers: [] }, MAIN_OPTS);
  assert.doesNotMatch(alone, /initial_swarm_main_peers/);
  // An operator's own list overrides the manifest's, and still has to be host:port.
  const own = generateZebraConfig(REHEARSAL, { ...MAIN_OPTS, seedPeers: ['10.0.0.4:28233', 'node2.example.invalid:28233'] });
  assert.match(own, /^initial_swarm_main_peers = \["10\.0\.0\.4:28233", "node2\.example\.invalid:28233"\]$/m);
  assert.throws(() => generateZebraConfig(REHEARSAL, { ...MAIN_OPTS, seedPeers: ['seed-main.swarm.green'] }), /is not host:port/);
});

test('the port the listener binds is the port the section advertises', () => {
  // The manifest calls the P2P port ports.public_p2p; reading it a second,
  // different way for [network.swarm_main] let that section disagree with
  // [network].listen_addr above it.
  const m = clone(REHEARSAL);
  m.ports.public_p2p = 29233;
  const toml = generateZebraConfig(m, MAIN_OPTS);
  assert.match(toml, /^listen_addr = "0\.0\.0\.0:29233"$/m);
  assert.match(toml, /^p2p_port = 29233$/m);
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

// The generator does not read the payout address to decide this: whichever
// address the node validated, the miner inside the node is the one that runs
// on this many threads. The address in MAIN_OPTS is therefore the fixture's
// own, and no address is invented here.
test('on mainnet the miner inside the node is given the cores the user chose', () => {
  const mining = { ...MAIN_OPTS, internalMiner: true, internalMinerThreads: 14 };
  const toml = generateZebraConfig(MAINNET, mining);
  assert.match(toml, /^internal_miner = true$/m);
  assert.match(toml, /^internal_miner_threads = 14$/m);

  // A seed or RPC node that is not mining carries neither.
  const idle = generateZebraConfig(MAINNET, MAIN_OPTS);
  assert.doesNotMatch(idle, /internal_miner_threads/);

  // Nonsense is refused here, where the message is readable.
  assert.throws(
    () => generateZebraConfig(MAINNET, { ...mining, internalMinerThreads: 999 }),
    /thread count 1\.\.256/
  );
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
