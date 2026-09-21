'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { SyncGate, REASON, tipAgeSeconds } = require('../electron/chain/sync-gate');

const HEALTHY = {
  nodeRunning: true,
  synced: true,
  peers: 3,
  tipAgeSec: 40,
  addressKind: 'transparent',
  mode: 'standard'
};

test('a healthy node with a matching address may mine', () => {
  const g = new SyncGate();
  const d = g.evaluate(HEALTHY);
  assert.strictEqual(d.allow, true);
  assert.strictEqual(d.reason, REASON.OK);
  assert.strictEqual(d.state, 'allowed');
  assert.strictEqual(d.overridden, false);
});

test('no node means no mining', () => {
  const g = new SyncGate();
  const d = g.evaluate({ ...HEALTHY, nodeRunning: false });
  assert.strictEqual(d.allow, false);
  assert.strictEqual(d.reason, REASON.NO_NODE);
});

test('no peers blocks mining and the message explains the private fork', () => {
  const g = new SyncGate();
  const d = g.evaluate({ ...HEALTHY, peers: 0 });
  assert.strictEqual(d.allow, false);
  assert.strictEqual(d.reason, REASON.NO_PEERS);
  assert.match(d.message, /private fork/);
});

test('a tip older than the limit blocks mining', () => {
  const g = new SyncGate({ maxTipAgeSec: 600 });
  assert.strictEqual(g.evaluate({ ...HEALTHY, tipAgeSec: 599 }).allow, true);
  const d = g.evaluate({ ...HEALTHY, tipAgeSec: 601 });
  assert.strictEqual(d.allow, false);
  assert.strictEqual(d.reason, REASON.STALE_TIP);
});

test('an unknown tip age counts as stale, not as fresh', () => {
  const g = new SyncGate();
  assert.strictEqual(g.evaluate({ ...HEALTHY, tipAgeSec: null }).reason, REASON.STALE_TIP);
  assert.strictEqual(g.evaluate({ ...HEALTHY, tipAgeSec: NaN }).reason, REASON.STALE_TIP);
});

test('a node still doing its initial block download may not mine', () => {
  const g = new SyncGate();
  assert.strictEqual(g.evaluate({ ...HEALTHY, synced: false }).reason, REASON.NOT_SYNCED);
});

test('a node that has peers but an old tip is told it is catching up', () => {
  // This is the realistic "just installed, still downloading" case, and the
  // message must say that rather than accuse the network of being dead.
  const g = new SyncGate({ maxTipAgeSec: 900 });
  const d = g.evaluate({ ...HEALTHY, peers: 4, tipAgeSec: 90000 });
  assert.strictEqual(d.allow, false);
  assert.strictEqual(d.reason, REASON.STALE_TIP);
  assert.match(d.message, /catching up/);
});

test('mining needs a payout address of the right kind for the mode', () => {
  const g = new SyncGate();
  assert.strictEqual(g.evaluate({ ...HEALTHY, addressKind: null }).reason, REASON.NO_ADDRESS);
  // A transparent address cannot drive Zebra's internal (shielded) miner.
  assert.strictEqual(g.evaluate({ ...HEALTHY, mode: 'shielded' }).reason, REASON.MODE_MISMATCH);
  // And a unified address cannot drive the standard transparent miner.
  assert.strictEqual(g.evaluate({ ...HEALTHY, addressKind: 'unified' }).reason, REASON.MODE_MISMATCH);
  assert.strictEqual(g.evaluate({ ...HEALTHY, addressKind: 'unified', mode: 'shielded' }).allow, true);
});

test('going from allowed to blocked is reported as a pause, so the UI can say "paused"', () => {
  const g = new SyncGate();
  assert.strictEqual(g.evaluate(HEALTHY).state, 'allowed');
  const d = g.evaluate({ ...HEALTHY, peers: 0 });
  assert.strictEqual(d.state, 'paused');
  // Still blocked on the next tick: it is no longer a fresh pause.
  assert.strictEqual(g.evaluate({ ...HEALTHY, peers: 0 }).state, 'blocked');
  assert.strictEqual(g.evaluate(HEALTHY).state, 'allowed');
});

test('the first-node override excuses no peers and a stale tip — and nothing else', () => {
  const g = new SyncGate({ firstNode: true });

  const noPeers = g.evaluate({ ...HEALTHY, peers: 0, tipAgeSec: 99999 });
  assert.strictEqual(noPeers.allow, true);
  assert.strictEqual(noPeers.overridden, true);
  assert.match(noPeers.message, /first node of this network/);

  // It must not conjure a node, an address, or the right kind of address,
  // and it must not skip the initial block download.
  assert.strictEqual(g.evaluate({ ...HEALTHY, nodeRunning: false }).allow, false);
  assert.strictEqual(g.evaluate({ ...HEALTHY, addressKind: null }).allow, false);
  assert.strictEqual(g.evaluate({ ...HEALTHY, mode: 'shielded' }).allow, false);
  assert.strictEqual(g.evaluate({ ...HEALTHY, synced: false }).allow, false);
});

test('the override is off by default and can be turned back off', () => {
  const g = new SyncGate();
  assert.strictEqual(g.firstNode, false);
  assert.strictEqual(g.evaluate({ ...HEALTHY, peers: 0 }).allow, false);
  g.setFirstNode(true);
  assert.strictEqual(g.evaluate({ ...HEALTHY, peers: 0 }).allow, true);
  g.setFirstNode(false);
  assert.strictEqual(g.evaluate({ ...HEALTHY, peers: 0 }).allow, false);
});

test('minPeers is configurable and enforced exactly', () => {
  const g = new SyncGate({ minPeers: 3 });
  assert.strictEqual(g.evaluate({ ...HEALTHY, peers: 2 }).allow, false);
  assert.strictEqual(g.evaluate({ ...HEALTHY, peers: 3 }).allow, true);
});

test('tipAgeSeconds is null-safe and never negative', () => {
  const now = 1790035200000;
  assert.strictEqual(tipAgeSeconds(1790035140, now), 60);
  assert.strictEqual(tipAgeSeconds(1790035260, now), 0, 'a tip from the future is age zero, not negative');
  assert.strictEqual(tipAgeSeconds(null, now), null);
  assert.strictEqual(tipAgeSeconds(0, now), null);
});
