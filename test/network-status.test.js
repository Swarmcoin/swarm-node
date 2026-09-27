// The "how many bees" figure must be real or absent. These tests pin the
// refusals: another network's numbers, an unknown schema, and anything that is
// not a plain non-negative integer are all rejected rather than rounded into
// something presentable.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { validate, statusUrlFor, ALLOWED_STATUS_URLS } = require('../electron/chain/network-status');

const EXPECT = {
  genesisHash: '045993f5c91ea160c7ebda573dd97b0016816bca68d395bfff202779b88e2a28',
  chainLabel: 'swarm-testnet'
};

// Captured from the live seed on 2026-09-22, trimmed to the fields we read.
const LIVE = {
  schema: 'swarm-network-status/1',
  network: 'SwarmTestnet',
  server_time_utc: '2026-09-22T12:53:19Z',
  chain_label: 'swarm-testnet',
  genesis_hash: '045993f5c91ea160c7ebda573dd97b0016816bca68d395bfff202779b88e2a28',
  note: 'Public, read-only, generated on the SWARM seed server.',
  node: { up: true, height: 1014, peers: 1 },
  healthy: true
};

test('the URLs are fixed, one seed status file per SWARM network', () => {
  // Still an allow-list - the page has connect-src 'none' and this is the one
  // outbound request the main process makes for it - but it holds one entry
  // per network now. It was a single constant naming the TESTNET host, so a
  // SWARM mainnet build asked the testnet server how tall the main chain was,
  // refused the answer it got (rightly: another network's genesis) and showed
  // no network figures at all.
  assert.deepEqual(ALLOWED_STATUS_URLS, [
    'https://lwd.swarm.green/status.json',
    'https://lwd-main.swarm.green/status.json'
  ]);
  const NP = require('../electron/chain/network-profile');
  assert.equal(NP.lightWalletUrls('swarm-mainnet').statusUrl, 'https://lwd-main.swarm.green/status.json');
  assert.equal(NP.lightWalletUrls('swarm-mainnet').tipOracleUrl, 'https://lwd-main.swarm.green:443');
  assert.equal(NP.lightWalletUrls('swarm-testnet').tipOracleUrl, 'https://lwd.swarm.green:443');
  // And the definition a mainnet build carries names the mainnet oracle.
  const mainnet = require('../electron/net/network-mainnet.json');
  assert.equal(mainnet.sync_gate.tip_oracle_url, 'https://lwd-main.swarm.green:443');
});

test('a NetworkStatus takes the URL of its own profile, and nothing else', () => {
  const { NetworkStatus } = require('../electron/chain/network-status');
  assert.equal(new NetworkStatus({ statusUrl: 'https://lwd-main.swarm.green/status.json' }).url,
    'https://lwd-main.swarm.green/status.json');
  // Anything outside the allow-list is never fetched. There is no fixed
  // fallback any more: it used to be the TESTNET feed whatever was running.
  assert.equal(new NetworkStatus({ statusUrl: 'https://example.invalid/status.json' }).url, null);
  assert.equal(new NetworkStatus({}).url, null);
});

test('the fallback follows the running network: a mainnet node never reads the testnet feed', () => {
  const { NetworkStatus } = require('../electron/chain/network-status');
  const MAIN = 'https://lwd-main.swarm.green/status.json';
  const TEST = 'https://lwd.swarm.green/status.json';
  // No URL, or one outside the allow-list: the chain label decides.
  assert.equal(statusUrlFor({ chainLabel: 'swarm-mainnet' }), MAIN);
  assert.equal(statusUrlFor({ chainLabel: 'swarm-testnet' }), TEST);
  assert.equal(statusUrlFor({ statusUrl: 'https://example.invalid/status.json', chainLabel: 'swarm-mainnet' }), MAIN);
  // The OTHER network's feed is refused even though it is allow-listed.
  assert.equal(statusUrlFor({ statusUrl: TEST, chainLabel: 'swarm-mainnet' }), MAIN);
  assert.equal(statusUrlFor({ statusUrl: MAIN, chainLabel: 'swarm-testnet' }), TEST);
  // Exactly what main.js passes, for each network the app knows.
  const NP = require('../electron/chain/network-profile');
  for (const [file, want] of [['network-mainnet.json', MAIN], ['network.json', TEST]]) {
    const m = require(`../electron/net/${file}`);
    const p = NP.profileForManifest(m);
    const ns = new NetworkStatus({
      genesisHash: m.genesis.hash,
      chainLabel: m.identity.light_wallet_chain_label,
      statusUrl: NP.lightWalletUrls(p).statusUrl
    });
    assert.equal(ns.url, want, file);
  }
  // A chain label that names no SWARM network, and no URL: nothing at all.
  assert.equal(statusUrlFor({ chainLabel: 'swarm-node-dev' }), null);
});

test('with no status URL nothing is fetched and the reason is given', async () => {
  const { NetworkStatus } = require('../electron/chain/network-status');
  const r = await new NetworkStatus({}).get({ force: true });
  assert.equal(r.ok, false);
  assert.equal(r.data, null);
  assert.equal(r.source, null);
  assert.match(r.error, /names no SWARM network status file/);
});

test('the live payload is accepted and its real numbers survive', () => {
  const v = validate(LIVE, EXPECT);
  assert.equal(v.ok, true);
  assert.equal(v.data.seedPeers, 1);
  assert.equal(v.data.seedHeight, 1014);
  assert.equal(v.data.seedUp, true);
  assert.equal(v.data.network, 'SwarmTestnet');
});

test('another network is refused outright', () => {
  for (const wrong of [
    { ...LIVE, genesis_hash: '00'.repeat(32) },
    { ...LIVE, chain_label: 'main' }
  ]) {
    const v = validate(wrong, EXPECT);
    assert.equal(v.ok, false, 'a foreign network must not be shown');
    assert.match(v.error, /different network/);
  }
});

test('an unknown schema is refused rather than guessed at', () => {
  assert.equal(validate({ ...LIVE, schema: 'swarm-network-status/2' }, EXPECT).ok, false);
  assert.equal(validate({ ...LIVE, schema: undefined }, EXPECT).ok, false);
  assert.equal(validate(null, EXPECT).ok, false);
  assert.equal(validate('1', EXPECT).ok, false);
});

test('a missing or nonsense peer count becomes null, never a made-up number', () => {
  const cases = [undefined, null, -1, 1.5, '7', 'lots', NaN, Infinity, 10 ** 9];
  for (const peers of cases) {
    const v = validate({ ...LIVE, node: { ...LIVE.node, peers } }, EXPECT);
    assert.equal(v.ok, true, 'the rest of the file is still usable');
    assert.equal(v.data.seedPeers, null, `peers=${String(peers)} must not become a figure`);
  }
  // Zero is a real answer and must be kept as zero.
  assert.equal(validate({ ...LIVE, node: { ...LIVE.node, peers: 0 } }, EXPECT).data.seedPeers, 0);
});

test('a payload with no node block still validates, with nothing to show', () => {
  const v = validate({ ...LIVE, node: undefined }, EXPECT);
  assert.equal(v.ok, true);
  assert.equal(v.data.seedPeers, null);
  assert.equal(v.data.seedHeight, null);
  assert.equal(v.data.seedUp, false);
});

test('free text from the server is length-capped before it reaches the page', () => {
  const v = validate({ ...LIVE, note: 'x'.repeat(5000), network: 'y'.repeat(5000) }, EXPECT);
  assert.ok(v.data.note.length <= 400);
  assert.ok(v.data.network.length <= 60);
});
