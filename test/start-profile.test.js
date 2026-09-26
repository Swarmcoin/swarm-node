// Which network a build starts on, and the control that changes it.
//
// THE DEFECT. SWARM-Node-0.2.0-mainnet.1 was built with
// network_profile=swarm-mainnet, carried electron/net/network-mainnet.json,
// bundled the SwarmMain zebrad — and started on the SWARM testnet. It said
// "SwarmTestnet · engineering testnet" in the header and offered no control
// anywhere to change it. Two independent causes, both covered here:
//
//   1. nothing inside the packaged app recorded which network it was BUILT
//      for. The app read `networkProfile` out of settings.json, found
//      swarm-testnet — the shipped default, and the value every earlier
//      install had already written — and honoured it. A mainnet build could
//      not come up on mainnet on any machine, fresh or upgraded.
//
//   2. `shell:setNetworkProfile` existed and NOTHING IN THE RENDERER CALLED
//      IT. The Settings page listed the networks as read-only text.
//
// The checks below are the ones that would have failed before the fix.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const NP = require('../electron/chain/network-profile');

const NET_DIR = path.join(__dirname, '..', 'electron', 'net');

/** loadProfiles()-shaped entries, without touching the real files. */
const networks = (opts = {}) => [
  {
    id: 'swarm-testnet',
    label: 'SWARM testnet',
    available: opts.testnet !== false,
    manifest: { identity: { network_name: 'SwarmTestnet' } },
    reason: opts.testnet === false ? 'no testnet definition in this build' : null
  },
  {
    id: 'swarm-mainnet',
    label: 'SWARM mainnet',
    available: opts.mainnet === true,
    manifest: opts.mainnet === true ? { identity: { network_name: 'SwarmMainnet' } } : null,
    reason: opts.mainnet === true ? null : 'SWARM mainnet has not launched.'
  }
];

// ------------------------------------------------------- the build's own id

test('a build records which network it is for, and it can only be a SWARM network', () => {
  const marker = JSON.parse(fs.readFileSync(path.join(NET_DIR, 'build-profile.json'), 'utf8'));
  assert.ok(NP.profileById(marker.profile), `build-profile.json names ${marker.profile}, which is not a profile`);
  // Committed as the testnet, so a developer checkout and a default CI build
  // behave exactly as they always have. CI overwrites it per build.
  assert.strictEqual(marker.profile, 'swarm-testnet');
});

test('a missing or nonsense build marker means the default build, never a guess', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-bp-'));
  assert.deepStrictEqual(NP.loadBuildProfile(dir), { id: 'swarm-testnet', source: null, error: null });

  fs.writeFileSync(path.join(dir, 'build-profile.json'), JSON.stringify({ profile: 'Mainnet' }));
  const bad = NP.loadBuildProfile(dir);
  assert.strictEqual(bad.id, 'swarm-testnet', 'upstream Zcash must never become the build profile');
  assert.match(bad.error, /not a SWARM network profile/);

  fs.writeFileSync(path.join(dir, 'build-profile.json'), JSON.stringify({ profile: 'swarm-mainnet' }));
  assert.strictEqual(NP.loadBuildProfile(dir).id, 'swarm-mainnet');
});

// --------------------------------------------- the rule, network by network

test('a mainnet build starts on mainnet even though settings say swarm-testnet', () => {
  // Exactly the owner's machine: an install that ran the testnet app, then the
  // mainnet installer on top of it.
  const settings = { networkProfile: 'swarm-testnet', networkProfileChosenForBuild: null };
  const r = NP.chooseStartProfile(networks({ mainnet: true }), settings, 'swarm-mainnet');
  assert.strictEqual(r.chosen, 'swarm-mainnet');
  assert.strictEqual(r.entry.id, 'swarm-mainnet');
  // And it is never silent: the override says what was ignored and why.
  assert.ok(r.override, 'an overridden stored selection must be reported');
  assert.strictEqual(r.override.stored, 'swarm-testnet');
  assert.strictEqual(r.override.build, 'swarm-mainnet');
  assert.match(r.override.reason, /earlier install|shipped default/);
});

test('a fresh mainnet install starts on mainnet', () => {
  const r = NP.chooseStartProfile(networks({ mainnet: true }), {}, 'swarm-mainnet');
  assert.strictEqual(r.chosen, 'swarm-mainnet');
  assert.strictEqual(r.override, null);
});

test('a testnet build is unchanged: it starts on the testnet', () => {
  for (const settings of [{}, { networkProfile: 'swarm-testnet' }]) {
    const r = NP.chooseStartProfile(networks(), settings, 'swarm-testnet');
    assert.strictEqual(r.chosen, 'swarm-testnet');
    assert.strictEqual(r.override, null);
  }
});

test('a choice made with the selector IN THIS BUILD survives the next start', () => {
  // The other half of the rule. Without it the build would win on every
  // launch and the selector would appear to do nothing.
  const settings = { networkProfile: 'swarm-testnet', networkProfileChosenForBuild: 'swarm-mainnet' };
  const r = NP.chooseStartProfile(networks({ mainnet: true }), settings, 'swarm-mainnet');
  assert.strictEqual(r.chosen, 'swarm-testnet', 'a deliberate choice must not be overridden');
  assert.strictEqual(r.override, null);
});

test('a choice made in a DIFFERENT build does not carry over', () => {
  const settings = { networkProfile: 'swarm-testnet', networkProfileChosenForBuild: 'swarm-testnet' };
  const r = NP.chooseStartProfile(networks({ mainnet: true }), settings, 'swarm-mainnet');
  assert.strictEqual(r.chosen, 'swarm-mainnet');
  assert.ok(r.override);
});

test('a build whose own network has no definition falls back and says so', () => {
  // The pre-launch state: a swarm-mainnet build before the ceremony.
  const r = NP.chooseStartProfile(networks({ mainnet: false }), {}, 'swarm-mainnet');
  assert.strictEqual(r.chosen, 'swarm-testnet');
  assert.match(r.fellBack, /has not launched/);
});

test('a build that carries nothing usable chooses nothing, rather than guessing', () => {
  const r = NP.chooseStartProfile(networks({ testnet: false, mainnet: false }), {}, 'swarm-mainnet');
  assert.strictEqual(r.entry, null);
  assert.ok(r.reason);
});

test('no stored value can select a network outside the closed list', () => {
  for (const bogus of ['Mainnet', 'main', 'regtest', 'swarm-whatever', '', null, 42, {}]) {
    const r = NP.chooseStartProfile(networks({ mainnet: true }), {
      networkProfile: bogus,
      networkProfileChosenForBuild: 'swarm-mainnet'
    }, 'swarm-mainnet');
    assert.strictEqual(r.chosen, 'swarm-mainnet', `${JSON.stringify(bogus)} must not be selectable`);
  }
});

// ------------------------------------------------------ the payout address

test('an address from the other network is refused when the profile changes', () => {
  // The owner's stored address, a SWARM testnet unified one. SWARM mainnet
  // cannot pay it, so carrying it across would point the miner at an address
  // that chain has never heard of.
  const t = NP.payoutBelongsTo('swarm-mainnet', 'swarm1uzymtw000000000000000000000000000');
  assert.strictEqual(t.ok, false);
  assert.match(t.reason, /SWARM testnet/);

  // And the reverse, and upstream Zcash.
  assert.strictEqual(NP.payoutBelongsTo('swarm-testnet', 's3RiGvK5JzS8eh6ywN3K22f2LzDAhicgFuq').ok, false);
  assert.match(NP.payoutBelongsTo('swarm-mainnet', 't1abcdefghijklmnopqrstuvwxyz12345678').reason, /upstream Zcash/);
});

test('an address that belongs here, and no address at all, are both fine', () => {
  assert.strictEqual(NP.payoutBelongsTo('swarm-mainnet', 's3RiGvK5JzS8eh6ywN3K22f2LzDAhicgFuq').ok, true);
  // A unified SWARM mainnet address is checked by PREFIX only, and no real
  // one is written down here: the string sweep refuses an invented swm1… and
  // it is right to. classifyPrefix is exercised on the prefix the profile
  // publishes, which is the only thing this function looks at.
  const unified = NP.profileById('swarm-mainnet').unifiedPrefixes[0];
  assert.strictEqual(NP.payoutBelongsTo('swarm-mainnet', `${unified}0000000000000000000000`).ok, true);
  assert.strictEqual(NP.payoutBelongsTo('swarm-testnet', 'tmEXAMPLEEXAMPLEEXAMPLEEXAMPLEEXAMP').ok, true);
  const empty = NP.payoutBelongsTo('swarm-mainnet', '');
  assert.strictEqual(empty.ok, true);
  assert.strictEqual(empty.empty, true);
});

// ------------------------------------------- the network is on screen at all

test('the main process publishes the build profile and the override to the renderer', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8');
  for (const key of ['buildNetworkProfile:', 'networkOverride:', 'chainLabel:', 'genesisHash:', 'menuLabel:']) {
    assert.ok(main.includes(key), `shell:getConfig must publish ${key}`);
  }
  assert.match(main, /handle\('shell:restartApp'/, 'switching network needs a restart the app performs itself');
  assert.match(main, /NP\.chooseStartProfile/, 'the start profile rule must be the tested one');
});

test('the engine states the chain label and the genesis on every screen refresh', () => {
  const { ChainEngine } = require('../electron/chain/engine');
  const mainnet = require('../electron/net/network-mainnet.json');
  const e = new ChainEngine({
    manifest: mainnet,
    profile: NP.profileById('swarm-mainnet'),
    dataDir: path.join(os.tmpdir(), 'swarm-nowhere'),
    settings: {},
    saveSettings: () => {}
  });
  const n = e.getState().network;
  assert.strictEqual(n.chainLabel, 'swarm-mainnet');
  assert.strictEqual(n.name, 'SwarmMainnet');
  assert.strictEqual(n.production, true);
  // This was `manifest.identity.is_testnet !== false`, and no manifest has an
  // is_testnet key, so a mainnet build called itself a testnet.
  assert.strictEqual(n.isTestnet, false);
  assert.strictEqual(n.genesisHash, mainnet.genesis.hash);
  assert.strictEqual(n.genesisShort, mainnet.genesis.hash.slice(0, 8));
  assert.strictEqual(n.p2pPort, 28233);
});
