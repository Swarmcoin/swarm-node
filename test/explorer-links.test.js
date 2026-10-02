'use strict';

// Which explorer the app sends people to, per network.
//
// SWARM has two block explorers. Since 2026-09-28 the bare explore.swarm.green
// is the MAINNET explorer (mainnet.explore.swarm.green is its alias) and the
// testnet one is testnet.explore.swarm.green only; the relaunch brief of
// 2026-10-02 names explore.swarm.green and only it for mainnet links. Before
// that move the bare host served the testnet. Both embedded network
// definitions named that bare host, so the SWARM mainnet build (0.2.0-mainnet.6)
// showed "Explorer - explore.swarm.green" in Settings and opened the TESTNET
// explorer for people looking for mainnet blocks and rewards. These tests pin
// each network to its own explorer, keep the other network's hosts out of the
// mainnet definition, and keep the label naming the network.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const NP = require('../electron/chain/network-profile');
const V = require('../electron/ipc-validate');

const ROOT = path.join(__dirname, '..');
const MAINNET = require('../electron/net/network-mainnet.json');
const TESTNET = require('../electron/net/network.json');

const MAIN_EXPLORER = 'https://explore.swarm.green';
const TEST_EXPLORER = 'https://testnet.explore.swarm.green';

// The allow-list main.js builds from the running network's links: the only
// hosts shell:openLink will open (see registerIpc).
const hostsOf = (links) => Object.values(links || {})
  .filter((u) => typeof u === 'string' && u.startsWith('https://'))
  .map((u) => new URL(u).host);

// Every *.swarm.green host named anywhere in a definition.
const swarmHostsIn = (manifest) =>
  [...new Set(JSON.stringify(manifest).match(/[a-z0-9.-]*swarm\.green/gi) || [])].sort();

test('each network profile names its own explorer, by its explicit host', () => {
  assert.equal(NP.explorerUrl('swarm-mainnet'), MAIN_EXPLORER);
  assert.equal(NP.explorerUrl('swarm-testnet'), TEST_EXPLORER);
  assert.equal(NP.explorerUrl(NP.profileById('swarm-mainnet')), MAIN_EXPLORER);
  assert.notEqual(NP.explorerUrl('swarm-mainnet'), NP.explorerUrl('swarm-testnet'));
  assert.throws(() => NP.explorerUrl('mainnet'), /unknown network profile/);
});

test('the embedded definitions carry the explorer of their own network', () => {
  assert.equal(NP.profileForManifest(MAINNET).id, 'swarm-mainnet');
  assert.equal(NP.profileForManifest(TESTNET).id, 'swarm-testnet');
  assert.equal(MAINNET.links.explorer, MAIN_EXPLORER);
  assert.equal(TESTNET.links.explorer, TEST_EXPLORER);
  // Exactly what the embed script writes for each, so re-embedding a network
  // cannot bring the old value back.
  for (const m of [MAINNET, TESTNET]) {
    assert.equal(m.links.explorer, NP.explorerUrl(NP.profileForManifest(m)));
  }
});

test('the mainnet definition never names any testnet host', () => {
  const hosts = swarmHostsIn(MAINNET);
  assert.ok(!hosts.includes('testnet.explore.swarm.green'), 'testnet explorer in the mainnet definition');
  assert.ok(!hosts.includes('lwd.swarm.green'), 'testnet light-wallet host in the mainnet definition');
  assert.ok(!hosts.includes('seed.swarm.green'), 'testnet seed in the mainnet definition');
  // And positively: nothing but the website and the mainnet hosts.
  assert.deepEqual(hosts, ['explore.swarm.green', 'lwd-main.swarm.green', 'seed-main.swarm.green', 'swarm.green']);
});

test('the testnet definition names only testnet hosts, and never the bare explorer', () => {
  const hosts = swarmHostsIn(TESTNET);
  assert.ok(!hosts.includes('explore.swarm.green'), `bare explorer host in ${hosts.join(', ')}`);
  for (const h of hosts) assert.ok(!/(^|\.)mainnet\.|-main\./.test(h), `mainnet host ${h} in the testnet definition`);
  assert.deepEqual(hosts, ['lwd.swarm.green', 'seed.swarm.green', 'swarm.green', 'testnet.explore.swarm.green']);
});

test('a mainnet build can open the mainnet explorer and cannot open the testnet one', () => {
  const hosts = hostsOf(MAINNET.links);
  assert.equal(V.externalUrl(`${MAIN_EXPLORER}/blocks/1434`, hosts), `${MAIN_EXPLORER}/blocks/1434`);
  for (const other of [TEST_EXPLORER, 'https://mainnet.explore.swarm.green']) {
    assert.throws(() => V.externalUrl(`${other}/`, hosts), /not one of/, other);
  }
  const testHosts = hostsOf(TESTNET.links);
  assert.equal(V.externalUrl(`${TEST_EXPLORER}/blocks/6855`, testHosts), `${TEST_EXPLORER}/blocks/6855`);
  assert.throws(() => V.externalUrl(`${MAIN_EXPLORER}/`, testHosts), /not one of/);
});

test('the embed script takes the explorer from the profile, not from a constant', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'embed-network.mjs'), 'utf8');
  assert.match(src, /explorer:\s*NP\.explorerUrl\(profile\)/);
  assert.doesNotMatch(src, /['"]https:\/\/explore\.swarm\.green/);
});

test('no shipped source links the testnet explorer from mainnet code, or the mainnet alias', () => {
  const walk = (d, out = []) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, out); else out.push(p);
    }
    return out;
  };
  const files = [...walk(path.join(ROOT, 'electron')), ...walk(path.join(ROOT, 'src'))]
    .filter((f) => /\.(js|mjs|jsx|json)$/.test(f));
  assert.ok(files.length > 10, 'the walk found the sources');
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    assert.doesNotMatch(text, /https:\/\/mainnet\.explore\.swarm\.green/, path.relative(ROOT, f));
    if (!/network\.json$/.test(f)) assert.doesNotMatch(text, /https:\/\/testnet\.explore\.swarm\.green/, path.relative(ROOT, f));
  }
});

test('the Settings row says which network the explorer belongs to, and shows its host', async () => {
  const { channelRows, networkWord } = await import('../src/channel-links.mjs');
  assert.equal(networkWord('swarm-mainnet'), 'mainnet');
  assert.equal(networkWord('swarm-testnet'), 'testnet');
  assert.equal(networkWord('mainnet'), null);
  assert.equal(networkWord(undefined), null);

  const main = channelRows(MAINNET.links, 'swarm-mainnet');
  const mx = main.find((r) => r.key === 'explorer');
  assert.equal(mx.label, 'Explorer · mainnet');
  assert.equal(mx.host, 'explore.swarm.green');
  assert.equal(mx.url, MAIN_EXPLORER);

  const tx = channelRows(TESTNET.links, 'swarm-testnet').find((r) => r.key === 'explorer');
  assert.equal(tx.label, 'Explorer · testnet');
  assert.equal(tx.host, 'testnet.explore.swarm.green');
  assert.equal(tx.url, TEST_EXPLORER);

  // The other rows keep their plain labels, in the same order as before.
  assert.deepEqual(main.map((r) => [r.key, r.label]), [
    ['website', 'Website'],
    ['explorer', 'Explorer · mainnet'],
    ['x', 'X'],
    ['source', 'Source code']
  ]);
  // No network word is invented for a profile the app does not know.
  assert.equal(channelRows(MAINNET.links, 'something-else').find((r) => r.key === 'explorer').label, 'Explorer');
  // Nothing that is not an https address becomes a row.
  assert.deepEqual(channelRows({ explorer: 'http://explore.swarm.green' }, 'swarm-mainnet'), []);
  assert.deepEqual(channelRows(undefined, 'swarm-mainnet'), []);
});
