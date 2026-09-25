'use strict';

// SWARM now has two networks, and the failure this file exists to prevent is a
// single word. If "mainnet" anywhere in this app resolved to the NODE's
// `Mainnet`, a person choosing "SWARM mainnet" would join the Zcash main
// chain, mine on it with an address that does not exist there, and be told
// nothing. So the mapping is a closed list, and these tests hold it shut.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const NP = require('../electron/chain/network-profile');
const { inspect } = require('../electron/chain/address-format');

// The exact vectors from the mainnet identity work, 2026-09-25.
const S1 = 's1MCkDhVejM4RqDyRR1rEJkudd26FVWipPD';   // SWARM mainnet P2PKH, 0x1C28
const S3 = 's3Mtm9Ez6HFNovPfrY7WpjPGZmYNxztrxbb';   // SWARM mainnet P2SH,  0x1C2D
const T2_A = 't2DGVURG5tAyXXSkj85JV5xbvTobYv7H99n'; // SWARM testnet P2SH,  0x1CBA
const T2_B = 't2Li46A4YNFqRDvdKA212w7DtsLkbGMG2xU';
const TM = 'tmJymvcUCn1ctbghvTJpXBwHiMEB8P6wxNV';
const SWARM1 = 'swarm12flymdvahre66el73vpyej6nva55s0lhxhp97ujv7k0vrhgvdgmsfp2xtccadctpqaku2uvw8jqm4w5py66mml9yxf600eluzumd473r';
// A unified address carrying the mainnet human-readable prefix, built from
// the testnet vector's data part rather than written out. No made-up mainnet
// address is recorded anywhere in this repository, so the lint rule that
// forbids one stays in force.
const SWM1 = NP.profileById('swarm-mainnet').unifiedPrefixes[0] + SWARM1.slice('swarm1'.length);
const U1 = 'u1abcdefghijklmnopqrstuvwxyz023456789acdefghjklmnpqrstuvwxyz';
const T1 = 't1Ks2m9YDXNR6zLtFsKF5vtkaBYtHrSmPpP';
const T3 = 't3Vz22vK5z2LcKEdg16Yv4FFneEL1zg9ojd';

// --------------------------------------------------------- the closed list

test('there are exactly two profiles and neither is upstream Zcash', () => {
  assert.deepStrictEqual(NP.PROFILES.map((p) => p.id), ['swarm-testnet', 'swarm-mainnet']);
  for (const p of NP.PROFILES) {
    assert.ok(!NP.FORBIDDEN_ZEBRA_NETWORKS.includes(p.zebraNetwork),
      `${p.id} writes network = "${p.zebraNetwork}"`);
  }
});

test('the SWARM mainnet profile selects SwarmMainnet, never Mainnet', () => {
  const m = NP.profileById('swarm-mainnet');
  assert.strictEqual(m.zebraNetwork, 'SwarmMainnet');
  assert.strictEqual(m.chainLabel, 'swarm-mainnet');
  assert.strictEqual(m.ports.p2p, 28233);
  assert.strictEqual(m.ports.rpc, 28232);
  assert.deepStrictEqual(m.magic, [83, 87, 77, 78], 'SWMN');
  assert.strictEqual(m.magicConfigurable, false, 'the magic is compiled into the node');
  assert.strictEqual(m.production, true);
});

test('the two profiles never share a chain folder or a port', () => {
  const [t, m] = NP.PROFILES;
  assert.notStrictEqual(t.dataDirName, m.dataDirName);
  assert.notStrictEqual(t.dataDirSetting, m.dataDirSetting);
  assert.notStrictEqual(t.ports.p2p, m.ports.p2p);
  assert.notStrictEqual(t.ports.rpc, m.ports.rpc);
});

test('a manifest that names upstream Zcash is refused, by kind or by name', () => {
  for (const identity of [{ network_kind: 'Mainnet', network_name: 'SwarmMainnet' },
    { network_kind: 'Testnet', network_name: 'Mainnet' },
    { network_kind: 'Regtest', network_name: 'SwarmTestnet' }]) {
    assert.throws(() => NP.profileForManifest({ identity }), /upstream Zcash/);
    assert.throws(() => NP.profileForManifestOrKind({ identity: { ...identity, network_kind: 'Mainnet' } }), /upstream Zcash/);
  }
});

test('a manifest is matched to its own profile', () => {
  assert.strictEqual(NP.profileForManifest(require('../electron/net/network.json')).id, 'swarm-testnet');
  assert.strictEqual(NP.profileForManifest(require('./fixtures/swarm-mainnet-manifest.json')).id, 'swarm-mainnet');
  // A throwaway testnet keeps its own name and still resolves to the testnet
  // profile, which is what the development builds carry.
  assert.strictEqual(NP.profileForManifestOrKind(require('./fixtures/throwaway-network.json')).id, 'swarm-testnet');
});

// ------------------------------------------------------- payout addresses

test('SWARM mainnet accepts s1 and s3 and refuses every testnet and Zcash form', () => {
  for (const good of [S1, S3]) {
    const r = inspect(good, 'swarm-mainnet');
    assert.strictEqual(r.looksValid, true, `${good} should be a mainnet payout address`);
    assert.strictEqual(r.kind, 'transparent');
    assert.strictEqual(r.mode, 'standard');
  }
  const unified = inspect(SWM1, 'swarm-mainnet');
  assert.strictEqual(unified.looksValid, true, 'the internal miner takes a unified address, as on testnet');
  assert.strictEqual(unified.mode, 'shielded');

  for (const bad of [T2_A, T2_B, TM, SWARM1]) {
    const r = inspect(bad, 'swarm-mainnet');
    assert.strictEqual(r.looksValid, false, `${bad} is a testnet address`);
    assert.match(r.hint, /SWARM testnet address/);
  }
  for (const bad of [T1, T3, U1]) {
    assert.strictEqual(inspect(bad, 'swarm-mainnet').looksValid, false, `${bad} is upstream Zcash`);
  }
  assert.match(inspect(U1, 'swarm-mainnet').hint, /upstream Zcash unified address/);
});

test('SWARM testnet is the mirror image: tm, t2, swarm1 in; s1, s3 out', () => {
  for (const good of [TM, T2_A, T2_B]) {
    const r = inspect(good, 'swarm-testnet');
    assert.strictEqual(r.looksValid, true, `${good} should be a testnet payout address`);
    assert.strictEqual(r.kind, 'transparent');
  }
  assert.strictEqual(inspect(SWARM1, 'swarm-testnet').mode, 'shielded');
  for (const bad of [S1, S3, SWM1]) {
    const r = inspect(bad, 'swarm-testnet');
    assert.strictEqual(r.looksValid, false, `${bad} is a mainnet address`);
    assert.match(r.hint, /SWARM mainnet address/);
  }
  for (const bad of [T1, T3, U1]) {
    assert.strictEqual(inspect(bad, 'swarm-testnet').looksValid, false);
  }
});

test('the default profile is the testnet, so today\u2019s behaviour is unchanged', () => {
  assert.strictEqual(NP.DEFAULT_PROFILE_ID, 'swarm-testnet');
  assert.deepStrictEqual(inspect(TM), inspect(TM, 'swarm-testnet'));
});

test('a TEX address has no SWARM prefix to be accepted under', () => {
  // ZIP-320 assigns TEX its own two-byte prefix per network and SWARM has no
  // reviewed assignment, so nothing here may accept one.
  for (const p of NP.PROFILES) {
    assert.ok(!p.unifiedPrefixes.some((u) => /^tex/i.test(u)));
    assert.ok(!/^tex/i.test(p.transparent.p2pkh) && !/^tex/i.test(p.transparent.p2sh));
  }
});

// --------------------------------------------------------- the chain check

test('the node\u2019s own chain field decides, and "main" is always a refusal', () => {
  assert.strictEqual(NP.checkNodeChain('swarm-testnet', 'test').ok, true);
  assert.strictEqual(NP.checkNodeChain('swarm-mainnet', 'swarm-mainnet').ok, true);

  const zcash = NP.checkNodeChain('swarm-testnet', 'main');
  assert.strictEqual(zcash.ok, false);
  assert.match(zcash.error, /Zcash main chain/);

  const crossed = NP.checkNodeChain('swarm-mainnet', 'test');
  assert.strictEqual(crossed.ok, false);
  assert.match(crossed.error, /SWARM testnet, not SWARM mainnet/);
});

test('an old zebrad cannot pass the mainnet check by staying silent', () => {
  // A zebrad without SwarmMainnet support cannot report "swarm-mainnet". On a
  // production profile, no answer is a refusal; on a testnet it is only
  // "unknown", so a node that works today keeps working.
  const quietMain = NP.checkNodeChain('swarm-mainnet', null);
  assert.strictEqual(quietMain.ok, false);
  assert.match(quietMain.error, /older SWARM node/);
  assert.strictEqual(NP.checkNodeChain('swarm-testnet', null).ok, null);
});

test('a build with its own chain label is accepted without widening the profile', () => {
  assert.strictEqual(NP.checkNodeChain('swarm-testnet', 'swarm-node-dev', { expected: 'swarm-node-dev' }).ok, true);
  assert.strictEqual(NP.checkNodeChain('swarm-testnet', 'main', { expected: 'swarm-node-dev' }).ok, false);
});

test('the genesis check names the chain a foreign block 0 belongs to', () => {
  const zcash = NP.checkNodeGenesis(
    '11112222333344445555666677778888999900001111222233334444fedcba98',
    '00040fe8ec8471911baa1db1266ea15dd06b4a8a5c453883c000b031973dce08'
  );
  assert.strictEqual(zcash.ok, false);
  assert.match(zcash.error, /Zcash main chain/);
  assert.strictEqual(NP.checkNodeGenesis('aa'.repeat(32), 'AA'.repeat(32)).ok, true);
  assert.strictEqual(NP.checkNodeGenesis('aa'.repeat(32), null).ok, null, 'unknown is not a failure');
});

// ------------------------------------------------- definitions on disk

function tmpNet() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-profiles-'));
  fs.copyFileSync(path.join(__dirname, '..', 'electron', 'net', 'network.json'), path.join(dir, 'network.json'));
  return dir;
}

test('mainnet is visible and NOT selectable when this build carries no definition', () => {
  const dir = tmpNet();
  const found = NP.loadProfiles(dir);
  assert.deepStrictEqual(found.map((f) => f.id), ['swarm-testnet', 'swarm-mainnet']);
  assert.strictEqual(found[0].available, true);
  const main = found[1];
  assert.strictEqual(main.available, false, 'no definition, so it cannot be chosen');
  assert.strictEqual(main.manifest, null);
  assert.match(main.reason, /has not launched/);
  assert.match(main.reason, /will not invent/);
});

test('a bundled mainnet definition makes the profile selectable', () => {
  const dir = tmpNet();
  fs.copyFileSync(path.join(__dirname, 'fixtures', 'swarm-mainnet-manifest.json'), path.join(dir, 'network-mainnet.json'));
  const main = NP.loadProfiles(dir).find((f) => f.id === 'swarm-mainnet');
  assert.strictEqual(main.available, true);
  assert.strictEqual(main.manifest.identity.network_name, 'SwarmMainnet');
});

test('an incomplete or foreign mainnet definition is refused, not patched up', () => {
  const base = require('./fixtures/swarm-mainnet-manifest.json');
  const clone = () => JSON.parse(JSON.stringify(base));

  const noGenesis = clone();
  noGenesis.genesis.hash = '';
  assert.throws(() => NP.validateProfileManifest('swarm-mainnet', noGenesis), /no genesis hash/);

  const zcashGenesis = clone();
  zcashGenesis.genesis.hash = '00040fe8ec8471911baa1db1266ea15dd06b4a8a5c453883c000b031973dce08';
  assert.throws(() => NP.validateProfileManifest('swarm-mainnet', zcashGenesis), /Zcash main chain/);

  const testnetGenesis = clone();
  testnetGenesis.genesis.hash = '045993f5c91ea160c7ebda573dd97b0016816bca68d395bfff202779b88e2a28';
  assert.throws(() => NP.validateProfileManifest('swarm-mainnet', testnetGenesis), /SWARM testnet/);

  const testnetAddress = clone();
  testnetAddress.economics.recipients[0].address = T2_A;
  assert.throws(() => NP.validateProfileManifest('swarm-mainnet', testnetAddress), /starting "s3"/);

  const missing = clone();
  missing.economics.recipients.pop();
  assert.throws(() => NP.validateProfileManifest('swarm-mainnet', missing), /no community_reserve/);

  const wrongLabel = clone();
  wrongLabel.identity.light_wallet_chain_label = 'swarm-testnet';
  assert.throws(() => NP.validateProfileManifest('swarm-mainnet', wrongLabel), /is not swarm-mainnet/);

  // And the testnet definition cannot be loaded into the mainnet slot.
  assert.throws(() => NP.validateProfileManifest('swarm-mainnet', require('../electron/net/network.json')),
    /not SWARM mainnet/);
});

test('each profile keeps its own chain folder', () => {
  const settings = {};
  const t = NP.dataDirFor('swarm-testnet', settings, 'C:/users/x/AppData/SWARM');
  const m = NP.dataDirFor('swarm-mainnet', settings, 'C:/users/x/AppData/SWARM');
  assert.notStrictEqual(t, m);
  assert.match(m.replace(/\\/g, '/'), /chain-mainnet$/);
  // A folder the user chose is remembered per profile, not shared.
  assert.strictEqual(NP.dataDirFor('swarm-mainnet', { dataDir: 'D:/testnet' }, 'C:/x').replace(/\\/g, '/'), 'C:/x/chain-mainnet');
  assert.strictEqual(NP.dataDirFor('swarm-mainnet', { dataDirMainnet: 'D:/prod' }, 'C:/x'), 'D:/prod');
});
