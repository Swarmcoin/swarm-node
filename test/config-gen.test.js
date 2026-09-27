'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { generateZebraConfig, writeConfigFile, ConfigError } = require('../electron/chain/config-gen');

const P2SH = {
  ecc: 't2JaQV6iQ9MA3HmWVYhfEn9mrMh3fRZpwTA',
  grants: 't28Z45qZRaD6zXBMFHTzEN7pZfGeZTtbkFp',
  reserve: 't2L51LcmpA43UMvKTw2Lwtt9LMjwyqU2V1P'
};

function baseManifest(over = {}) {
  return {
    identity: {
      chain: 'SWARM',
      ticker: 'SWM',
      network_name: 'SwarmTestnet',
      network_kind: 'Testnet',
      network_magic: [83, 87, 82, 77],
      is_testnet: true
    },
    consensus: {
      disable_pow: false,
      checkpoints: false,
      target_difficulty_limit: '07ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
      coinbase_maturity_blocks: 100,
      activation_heights: {
        BeforeOverwinter: 1, Overwinter: 1, Sapling: 1, Blossom: 1, Heartwood: 1,
        Canopy: 1, NU5: 1, NU6: 1, 'NU6.1': 1, 'NU6.2': 1, 'NU6.3': 1
      }
    },
    genesis: { hash: '01d6e85dd3c1c128941a849c5025cd2e437258811a2551b82aefd68686c982e1' },
    economics: {
      atomic_unit_per_coin: 100000000,
      miner_percent: 80,
      slow_start_interval: 0,
      pre_blossom_halving_interval: 840000,
      extend_funding_stream_addresses_as_required: true,
      lockbox_disbursements: [],
      funding_stream_height_range: { start: 1, end: 50399999 },
      recipients: [
        { label: 'Core Development', receiver: 'ECC', numerator: 8, address: P2SH.ecc },
        { label: 'Grants & Ecosystem', receiver: 'MajorGrants', numerator: 4, address: P2SH.grants },
        { label: 'Community & Development Reserve', receiver: 'ZcashFoundation', numerator: 8, address: P2SH.reserve }
      ]
    },
    ports: { p2p: 18233, rpc: 18232 },
    seed_peers: ['seed.swarm.green:18233'],
    sync_gate: { min_peers: 1, max_tip_age_seconds: 900 },
    ...over
  };
}

const OPTS = { dataDir: 'D:/SWARM/chain' };

test('generates a config Zebra can read, from the manifest alone', () => {
  const toml = generateZebraConfig(baseManifest(), OPTS);
  assert.match(toml, /^# SwarmTestnet -- SWARM Node local profile\./m);
  assert.match(toml, /network = "Testnet"/);
  assert.match(toml, /network_name = "SwarmTestnet"/);
  assert.match(toml, /network_magic = \[83, 87, 82, 77\]/);
  assert.match(toml, /genesis_hash = "01d6e85dd3c1c128941a849c5025cd2e437258811a2551b82aefd68686c982e1"/);
  assert.match(toml, /listen_addr = "0\.0\.0\.0:18233"/);
  assert.match(toml, /initial_testnet_peers = \["seed\.swarm\.green:18233"\]/);
  assert.match(toml, /disable_pow = false/);
});

test('writes every path with forward slashes so Windows paths cannot break the TOML', () => {
  const toml = generateZebraConfig(baseManifest(), { dataDir: 'D:\\SWARM\\chain' });
  assert.match(toml, /cache_dir = "D:\/SWARM\/chain\/state"/);
  assert.match(toml, /cookie_dir = "D:\/SWARM\/chain"/);
  assert.ok(!/\\\\/.test(toml), 'no escaped backslashes should appear in the generated TOML');
});

test('RPC stays on loopback with cookie authentication', () => {
  const toml = generateZebraConfig(baseManifest(), OPTS);
  assert.match(toml, /\[rpc\][\s\S]*listen_addr = "127\.0\.0\.1:18232"/);
  assert.match(toml, /enable_cookie_auth = true/);
});

test('emits the 80 / 8 / 4 / 8 allocation as one funding-stream range', () => {
  const toml = generateZebraConfig(baseManifest(), OPTS);
  assert.match(toml, /height_range = \{ start = 1, end = 50399999 \}/);
  assert.match(toml, /receiver = "ECC", numerator = 8, addresses = \["t2JaQV6iQ9MA3HmWVYhfEn9mrMh3fRZpwTA"\]/);
  assert.match(toml, /receiver = "MajorGrants", numerator = 4/);
  assert.match(toml, /receiver = "ZcashFoundation", numerator = 8/);
});

test('quotes the activation heights whose name contains a dot', () => {
  const toml = generateZebraConfig(baseManifest(), OPTS);
  assert.match(toml, /^NU6 = 1$/m);
  assert.match(toml, /^"NU6\.1" = 1$/m);
  assert.match(toml, /^"NU6\.3" = 1$/m);
});

test('refuses to generate a config without a genesis hash', () => {
  const m = baseManifest({ genesis: { hash: null } });
  assert.throws(() => generateZebraConfig(m, OPTS), (e) => e instanceof ConfigError && /genesis\.hash is empty/.test(e.message));
});

test('refuses a funding-stream recipient that is not P2SH, which would panic the node', () => {
  const m = baseManifest();
  m.economics.recipients[0].address = 'tmJymvcUCn1ctbghvTJpXBwHiMEB8P6wxNV';
  assert.throws(() => generateZebraConfig(m, OPTS), /P2SH address starting "t2"/);
});

test('refuses an unknown funding-stream receiver slot', () => {
  const m = baseManifest();
  m.economics.recipients[0].receiver = 'SwarmCore';
  assert.throws(() => generateZebraConfig(m, OPTS), /unknown receiver slot/);
});

test('refuses recipients that sum above 100', () => {
  const m = baseManifest();
  m.economics.recipients[0].numerator = 95;
  assert.throws(() => generateZebraConfig(m, OPTS), /sum to 107/);
});

test('refuses to run a mainnet or a chain with proof of work disabled', () => {
  assert.throws(() => generateZebraConfig(baseManifest({ identity: { ...baseManifest().identity, network_kind: 'Mainnet' } }), OPTS), /does not run a mainnet/);
  const noPow = baseManifest();
  noPow.consensus.disable_pow = true;
  assert.throws(() => generateZebraConfig(noPow, OPTS), /disable_pow must be false/);
});

test('internal miner requires a payout address', () => {
  assert.throws(() => generateZebraConfig(baseManifest(), { ...OPTS, internalMiner: true }), /internalMiner needs a minerAddress/);
});

test('writes the miner address and internal_miner exactly as asked', () => {
  const unified = 'utest10a8k6aw5w33kvyt7x6fryzu7vvsjru5vgcfnvr288qx2zm6p63ygcajtaze0px08t583dyrgr42vasazjhhnntus2tqrpkzu0dm2l4cgf3ld6wdqdrf3jv8mvfx9c80e73syer9l2wlgawjtf7yvj0eqwdf354trtelxnr0fhpw9792eaf49ghstkyftc9lwqqwy4ye0cleagp4nzyt';
  const on = generateZebraConfig(baseManifest(), { ...OPTS, internalMiner: true, minerAddress: unified });
  assert.match(on, new RegExp(`miner_address = "${unified}"`));
  assert.match(on, /internal_miner = true/);

  const off = generateZebraConfig(baseManifest(), { ...OPTS, minerAddress: 'tmJymvcUCn1ctbghvTJpXBwHiMEB8P6wxNV' });
  assert.match(off, /miner_address = "tmJymvcUCn1ctbghvTJpXBwHiMEB8P6wxNV"/);
  assert.match(off, /internal_miner = false/);
});

test('the shielded miner is given the cores the user chose', () => {
  const unified = 'utest10a8k6aw5w33kvyt7x6fryzu7vvsjru5vgcfnvr288qx2zm6p63ygcajtaze0px08t583dyrgr42vasazjhhnntus2tqrpkzu0dm2l4cgf3ld6wdqdrf3jv8mvfx9c80e73syer9l2wlgawjtf7yvj0eqwdf354trtelxnr0fhpw9792eaf49ghstkyftc9lwqqwy4ye0cleagp4nzyt';
  const many = generateZebraConfig(baseManifest(), {
    ...OPTS, internalMiner: true, minerAddress: unified, internalMinerThreads: 14
  });
  assert.match(many, /^internal_miner_threads = 14$/m);

  // A node that is not mining carries no thread count at all, so the node's
  // own one-thread default is what a relay or seed keeps.
  const idle = generateZebraConfig(baseManifest(), OPTS);
  assert.doesNotMatch(idle, /internal_miner_threads/);

  // Nonsense is refused where the message is readable, not in the node's log.
  assert.throws(
    () => generateZebraConfig(baseManifest(), { ...OPTS, internalMiner: true, minerAddress: unified, internalMinerThreads: 0 }),
    /thread count 1\.\.256/
  );
});

test('the first-node case can drop the seed list and switch Zebra\u2019s own health gate off', () => {
  const first = generateZebraConfig(baseManifest(), { ...OPTS, seedPeers: [], enforceHealthGate: false });
  assert.match(first, /initial_testnet_peers = \[\]/);
  assert.match(first, /enforce_on_test_networks = false/);

  const normal = generateZebraConfig(baseManifest(), { ...OPTS, enforceHealthGate: true });
  assert.match(normal, /enforce_on_test_networks = true/);
  assert.match(normal, /min_connected_peers = 1/);
  assert.match(normal, /ready_max_tip_age = "900s"/);
});

test('rejects bad ports and malformed seed peers', () => {
  assert.throws(() => generateZebraConfig(baseManifest(), { ...OPTS, rpcPort: 0 }), /port 1\.\.65535/);
  assert.throws(() => generateZebraConfig(baseManifest(), { ...OPTS, seedPeers: ['seed.swarm.green'] }), /is not host:port/);
  assert.throws(() => generateZebraConfig(baseManifest(), { ...OPTS, p2pListen: 'not-an-address' }), /is not address:port/);
});

test('writeConfigFile writes UTF-8 with no BOM', () => {
  const written = [];
  const fakeFs = { writeFileSync: (f, buf) => written.push([f, buf]) };
  const toml = generateZebraConfig(baseManifest(), OPTS);
  writeConfigFile(fakeFs, path.join('X:', 'zebra.toml'), toml);
  const [, buf] = written[0];
  assert.ok(Buffer.isBuffer(buf));
  assert.notDeepStrictEqual([buf[0], buf[1], buf[2]], [0xef, 0xbb, 0xbf], 'a BOM must never be written');
  assert.strictEqual(buf.toString('utf8'), toml);
  assert.throws(() => writeConfigFile(fakeFs, 'x', '\uFEFF# hi'), /BOM/);
});

test('the manifest this build ships produces a usable config', () => {
  const shipped = require('../electron/net/network.json');
  assert.doesNotThrow(() => generateZebraConfig(shipped, OPTS));
  // And a build whose genesis hash went missing must refuse to start a node
  // rather than silently join whatever chain answers first.
  const blanked = JSON.parse(JSON.stringify(shipped));
  blanked.genesis.hash = null;
  assert.throws(() => generateZebraConfig(blanked, OPTS), /genesis\.hash is empty/);
});
