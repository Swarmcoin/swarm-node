// build/binary-pins.json decides which zebrad a user's machine executes.
// These tests are the cheapest place to catch a pin that is empty, duplicated
// from the other network, or pointing at a release nobody can read.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const pins = JSON.parse(fs.readFileSync(path.join(ROOT, 'build', 'binary-pins.json'), 'utf8'));
const NP = require('../electron/chain/network-profile.js');

const PLATFORMS = ['win-x64', 'linux-x64', 'darwin-arm64', 'darwin-x64'];
const HEX64 = /^[0-9a-f]{64}$/;

test('every network profile the app knows has a block of pins', () => {
  for (const profile of NP.PROFILES) {
    assert.ok(pins.profiles[profile.id], `no binary pins for ${profile.id}`);
  }
  for (const id of Object.keys(pins.profiles)) {
    assert.ok(NP.profileById(id), `binary-pins.json pins an unknown profile ${id}`);
  }
  assert.ok(pins.profiles[pins.default_profile], 'default_profile is not a pinned profile');
  assert.equal(pins.default_profile, NP.DEFAULT_PROFILE_ID);
});

test('each profile pins both binaries on all four platforms, by SHA-256', () => {
  for (const [id, profile] of Object.entries(pins.profiles)) {
    assert.deepEqual(Object.keys(profile.platforms).sort(), [...PLATFORMS].sort(), `${id} platforms`);
    assert.ok(profile.tag, `${id} has no release tag`);
    for (const key of PLATFORMS) {
      const pin = profile.platforms[key];
      assert.match(pin.node_sha, HEX64, `${id}/${key} node_sha`);
      assert.match(pin.miner_sha, HEX64, `${id}/${key} miner_sha`);
      assert.notEqual(pin.node_sha, pin.miner_sha, `${id}/${key}: node and miner cannot be the same file`);
      if (profile.layout === 'archive') {
        assert.ok(pin.archive, `${id}/${key} has no archive name`);
        assert.match(pin.archive_sha, HEX64, `${id}/${key} archive_sha`);
      } else {
        assert.ok(pin.node_asset && pin.miner_asset, `${id}/${key} has no asset names`);
      }
    }
  }
});

test('no placeholder survives in a pinned profile', () => {
  const text = JSON.stringify(pins);
  const left = text.match(/__[A-Z0-9_]+__/g);
  assert.equal(left, null, `placeholders left in build/binary-pins.json: ${left}`);
});

// The mistake this catches is a copy-paste: a mainnet build that quietly ships
// the testnet zebrad would run a node that cannot even parse a
// [network.swarm_main] section, and the failure would look like a bad release
// rather than a wrong pin.
test('mainnet and testnet never share a binary', () => {
  const testnet = pins.profiles['swarm-testnet'];
  const mainnet = pins.profiles['swarm-mainnet'];
  assert.notEqual(testnet.tag, mainnet.tag);
  for (const key of PLATFORMS) {
    assert.notEqual(mainnet.platforms[key].node_sha, testnet.platforms[key].node_sha, `${key} zebrad`);
    assert.notEqual(mainnet.platforms[key].miner_sha, testnet.platforms[key].miner_sha, `${key} privacy-miner`);
  }
});

// The mainnet tools come from the public privacy-zebra repository on purpose:
// a build of this PRIVATE repository can read a public release asset with no
// cross-repository token, which is the whole reason the testnet tools had to
// be re-hosted here in the first place.
test('the mainnet pins name their source, and it is the public tool repository', () => {
  const mainnet = pins.profiles['swarm-mainnet'];
  assert.equal(mainnet.repo, 'Swarm-Official/privacy-zebra');
  assert.equal(mainnet.layout, 'archive');
  assert.match(mainnet.source_commit, /^[0-9a-f]{7,40}$/);
  assert.match(mainnet.source_workflow_run, /^https:\/\/github\.com\/Swarm-Official\/privacy-zebra\/actions\/runs\/\d+$/);
});

test('no key tool is ever named as something to place', () => {
  for (const profile of Object.values(pins.profiles)) {
    for (const pin of Object.values(profile.platforms)) {
      for (const value of Object.values(pin)) {
        assert.ok(!/keytool/i.test(String(value)), `a key tool must never be packaged: ${value}`);
      }
    }
  }
});
