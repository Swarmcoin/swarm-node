'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { SyncGate, REASON, tipAgeSeconds } = require('../electron/chain/sync-gate');

// A node with a peer, at the same height as the independent view of the tip.
const HEALTHY = {
  nodeRunning: true,
  peers: 3,
  height: 466,
  networkHeight: 466,
  networkSource: 'the SWARM wallet server',
  secondsSinceNewBlock: 40,
  tipAgeSec: 40,
  addressKind: 'transparent',
  mode: 'standard'
};

test('a healthy node at the network tip may mine', () => {
  const g = new SyncGate();
  const d = g.evaluate(HEALTHY);
  assert.strictEqual(d.allow, true);
  assert.strictEqual(d.reason, REASON.OK);
  assert.strictEqual(d.overridden, false);
  assert.strictEqual(d.myHeight, 466);
  assert.strictEqual(d.networkHeight, 466);
  assert.strictEqual(d.behind, 0);
});

// ---- defect N-1 --------------------------------------------------------
// The owner's node was AT the tip and Start mining was greyed out, because the
// gate was guessing from tip age. On this chain block spacing is 60-90 s on
// average but Poisson, so multi-minute gaps are ordinary.

test('N-1: a node at the tip may mine however old its newest block is', () => {
  const g = new SyncGate();
  for (const tipAgeSec of [30, 200, 400, 900, 5000]) {
    const d = g.evaluate({ ...HEALTHY, tipAgeSec, secondsSinceNewBlock: tipAgeSec });
    assert.strictEqual(d.allow, true, `a ${tipAgeSec}s-old tip at the network height must still allow mining`);
  }
});

test('N-1: the exact reported situation — height 86, network 86, one peer', () => {
  const g = new SyncGate();
  const d = g.evaluate({
    ...HEALTHY, peers: 1, height: 86, networkHeight: 86, tipAgeSec: 260, secondsSinceNewBlock: 260
  });
  assert.strictEqual(d.allow, true);
  assert.strictEqual(d.reason, REASON.OK);
});

test('a node genuinely behind the network is held back, and told both numbers', () => {
  const g = new SyncGate({ maxBehind: 2 });
  const d = g.evaluate({ ...HEALTHY, height: 400, networkHeight: 466 });
  assert.strictEqual(d.allow, false);
  assert.strictEqual(d.reason, REASON.BEHIND);
  assert.strictEqual(d.behind, 66);
  assert.match(d.message, /block 400/);
  assert.match(d.message, /466/);
});

test('being one or two blocks behind is normal, not "behind"', () => {
  const g = new SyncGate({ maxBehind: 2 });
  assert.strictEqual(g.evaluate({ ...HEALTHY, height: 465, networkHeight: 466 }).allow, true);
  assert.strictEqual(g.evaluate({ ...HEALTHY, height: 464, networkHeight: 466 }).allow, true);
  assert.strictEqual(g.evaluate({ ...HEALTHY, height: 463, networkHeight: 466 }).allow, false);
});

test('a node AHEAD of the second opinion is not held back', () => {
  // We mined a block the wallet server has not indexed yet. That is normal.
  const g = new SyncGate();
  assert.strictEqual(g.evaluate({ ...HEALTHY, height: 470, networkHeight: 466 }).allow, true);
});

// ---- the fallback when the second opinion is unreachable ----------------

test('with no second opinion, a node still pulling blocks down is held back', () => {
  const g = new SyncGate({ quietSeconds: 45 });
  const d = g.evaluate({ ...HEALTHY, networkHeight: null, networkSource: null, secondsSinceNewBlock: 3 });
  assert.strictEqual(d.allow, false);
  assert.strictEqual(d.reason, REASON.NOT_SYNCED);
  assert.match(d.rule, /no second opinion/);
});

test('with no second opinion, a quiet chain is allowed rather than blocked for ever', () => {
  // This is the other half of N-1: if the wallet server is down we must not
  // fall back to a rule that never opens on a slow chain.
  const g = new SyncGate({ quietSeconds: 45 });
  const d = g.evaluate({ ...HEALTHY, networkHeight: null, networkSource: null, secondsSinceNewBlock: 600, tipAgeSec: 600 });
  assert.strictEqual(d.allow, true);
  assert.match(d.rule, /no second opinion/);
});

test('with no second opinion and nothing downloaded yet, only an absurd tip age blocks', () => {
  const g = new SyncGate({ maxTipAgeSec: 7200 });
  const fresh = g.evaluate({ ...HEALTHY, networkHeight: null, secondsSinceNewBlock: null, tipAgeSec: 3000 });
  assert.strictEqual(fresh.allow, true);
  const ancient = g.evaluate({ ...HEALTHY, networkHeight: null, secondsSinceNewBlock: null, tipAgeSec: 90000 });
  assert.strictEqual(ancient.allow, false);
  assert.strictEqual(ancient.reason, REASON.STALE_TIP);
});

test('the decision always carries the numbers the UI must show', () => {
  const g = new SyncGate();
  const d = g.evaluate({ ...HEALTHY, height: 400, networkHeight: 466, peers: 2 });
  assert.strictEqual(d.myHeight, 400);
  assert.strictEqual(d.networkHeight, 466);
  assert.strictEqual(d.peers, 2);
  assert.strictEqual(d.networkSource, 'the SWARM wallet server');
  assert.ok(d.rule, 'the UI must be able to say which rule is in force');
});

// ---- the things the gate exists for -------------------------------------

test('no node means no mining', () => {
  const g = new SyncGate();
  assert.strictEqual(g.evaluate({ ...HEALTHY, nodeRunning: false }).reason, REASON.NO_NODE);
});

test('no peers blocks mining and the message explains the private fork', () => {
  const g = new SyncGate();
  const d = g.evaluate({ ...HEALTHY, peers: 0 });
  assert.strictEqual(d.allow, false);
  assert.strictEqual(d.reason, REASON.NO_PEERS);
  assert.match(d.message, /private fork/);
});

test('mining needs a payout address of the right kind for the mode', () => {
  const g = new SyncGate();
  assert.strictEqual(g.evaluate({ ...HEALTHY, addressKind: null }).reason, REASON.NO_ADDRESS);
  assert.strictEqual(g.evaluate({ ...HEALTHY, mode: 'shielded' }).reason, REASON.MODE_MISMATCH);
  assert.strictEqual(g.evaluate({ ...HEALTHY, addressKind: 'unified' }).reason, REASON.MODE_MISMATCH);
  assert.strictEqual(g.evaluate({ ...HEALTHY, addressKind: 'unified', mode: 'shielded' }).allow, true);
});

test('going from allowed to blocked is reported as a pause', () => {
  const g = new SyncGate();
  assert.strictEqual(g.evaluate(HEALTHY).state, 'allowed');
  assert.strictEqual(g.evaluate({ ...HEALTHY, peers: 0 }).state, 'paused');
  assert.strictEqual(g.evaluate({ ...HEALTHY, peers: 0 }).state, 'blocked');
  assert.strictEqual(g.evaluate(HEALTHY).state, 'allowed');
});

// ---- the two escape hatches ---------------------------------------------

test('the first-node override excuses network health — and nothing else', () => {
  const g = new SyncGate({ firstNode: true });
  const alone = g.evaluate({ ...HEALTHY, peers: 0, networkHeight: null, tipAgeSec: 99999, secondsSinceNewBlock: null });
  assert.strictEqual(alone.allow, true);
  assert.strictEqual(alone.overridden, true);
  assert.match(alone.message, /first node of this network/);

  assert.strictEqual(g.evaluate({ ...HEALTHY, nodeRunning: false }).allow, false);
  assert.strictEqual(g.evaluate({ ...HEALTHY, addressKind: null }).allow, false);
  assert.strictEqual(g.evaluate({ ...HEALTHY, mode: 'shielded' }).allow, false);
});

test('the gate never deadlocks: after the patience window it offers "start anyway"', () => {
  const g = new SyncGate({ patienceSeconds: 600 });
  const behind = { ...HEALTHY, height: 400, networkHeight: 466 };
  const t0 = 1_800_000_000_000;

  let d = g.evaluate({ ...behind, nowMs: t0 });
  assert.strictEqual(d.allow, false);
  assert.strictEqual(d.offerOverride, false, 'not offered immediately');

  d = g.evaluate({ ...behind, nowMs: t0 + 599_000 });
  assert.strictEqual(d.offerOverride, false);

  d = g.evaluate({ ...behind, nowMs: t0 + 600_000 });
  assert.strictEqual(d.offerOverride, true, 'offered once the user has waited it out');
  assert.strictEqual(d.blockedForSec, 600);
  assert.strictEqual(d.allow, false, 'offering is not the same as allowing');

  g.setUserOverride(true);
  d = g.evaluate({ ...behind, nowMs: t0 + 601_000 });
  assert.strictEqual(d.allow, true);
  assert.strictEqual(d.overridden, true);
  assert.match(d.message, /at your request/);
});

test('"start anyway" cannot excuse a missing address, however long you wait', () => {
  const g = new SyncGate({ patienceSeconds: 1 });
  g.setUserOverride(true);
  const t0 = 1_800_000_000_000;
  g.evaluate({ ...HEALTHY, addressKind: null, nowMs: t0 });
  const d = g.evaluate({ ...HEALTHY, addressKind: null, nowMs: t0 + 60_000 });
  assert.strictEqual(d.allow, false);
  assert.strictEqual(d.reason, REASON.NO_ADDRESS);
  assert.strictEqual(d.offerOverride, false);
});

test('the patience clock resets as soon as the problem clears', () => {
  const g = new SyncGate({ patienceSeconds: 600 });
  const t0 = 1_800_000_000_000;
  g.evaluate({ ...HEALTHY, height: 400, nowMs: t0 });
  assert.strictEqual(g.evaluate({ ...HEALTHY, height: 400, nowMs: t0 + 500_000 }).blockedForSec, 500);
  g.evaluate({ ...HEALTHY, nowMs: t0 + 501_000 });                       // healthy again
  assert.strictEqual(g.evaluate({ ...HEALTHY, height: 400, nowMs: t0 + 502_000 }).blockedForSec, 0);
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
