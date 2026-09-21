// Sync gate — decides whether this machine is allowed to mine right now.
//
// WHY THIS EXISTS. Zebra reports every *test* network node as "synced" the
// moment it starts, whatever its peer count or tip age. Without a gate both
// miners would happily extend a stale tip with no peers, build a private fork,
// and have every block of it orphaned the moment the node reconnects. That
// wastes the user's electricity and pollutes the network.
//
// The gate is a pure state machine: feed it observations, read a decision.
// It performs no I/O, so the whole truth table is unit-tested.
//
// States:
//   'blocked'   mining refused, with a reason the UI shows verbatim
//   'allowed'   mining may run
//   'paused'    mining was running and the gate closed under it
//
// The one escape hatch is firstNode: the operator of the very first node of a
// brand-new network has nobody to peer with and must be able to mine the first
// blocks. It is an explicit, confirmed choice, never a default, and the UI
// keeps saying so while it is on.

'use strict';

const REASON = {
  NO_NODE: 'node-not-running',
  NOT_SYNCED: 'node-still-syncing',
  NO_PEERS: 'no-peers',
  STALE_TIP: 'tip-too-old',
  NO_ADDRESS: 'no-payout-address',
  MODE_MISMATCH: 'address-wrong-type-for-mode',
  OK: 'ok'
};

const MESSAGES = {
  [REASON.NO_NODE]: 'The full node is not running yet. Mining needs a running node.',
  [REASON.NOT_SYNCED]: 'The node is still downloading the chain. Mining starts once it has caught up.',
  [REASON.NO_PEERS]:
    'This node has no peers, so it cannot tell whether it is on the real chain. ' +
    'Mining now would build a private fork that everyone else throws away. ' +
    'Waiting for a peer.',
  // Only reachable once the node HAS peers, so "behind the peers it has" is
  // the accurate description, not "no idea where the chain is".
  [REASON.STALE_TIP]:
    'Your node has peers but its newest block is old, so it is still catching up with them. ' +
    'Mining now would build on a stale tip. Mining starts when your node has the network’s newest block.',
  [REASON.NO_ADDRESS]: 'No payout address yet. Paste one from the SWARM Wallet first.',
  [REASON.MODE_MISMATCH]: 'This payout address does not fit the selected mining mode.',
  [REASON.OK]: 'Ready to mine.'
};

// WHY THERE IS NO "estimatedheight" CHECK HERE.
// Zebra's getblockchaininfo.estimatedheight is a WALL-CLOCK extrapolation:
// roughly (now - genesis time) / target spacing. On a chain that has just been
// created, with a genesis timestamped in the past, it claims the chain "should"
// already be thousands of blocks high, so a perfectly healthy node looks
// permanently unsynced. Measured on 2026-09-21: a fresh node at height 0 with a
// genesis 1.7 days old reported estimatedheight ~1994 and would never have been
// allowed to mine.
// The honest signals are the two below: does this node have peers, and is the
// block it has fresh. A node that is behind the network has an old tip by
// definition, so tip age covers the catching-up case without inventing one.

// What each mining mode needs from the payout address, as reported by the
// node itself (see chain/address.js — this app never parses an address).
const MODE_REQUIRES = {
  standard: 'transparent', // N copies of privacy-miner.exe, transparent tm…/t2… payout
  shielded: 'unified'      // Zebra's internal one-thread miner, utest… payout
};

class SyncGate {
  /**
   * @param {object} cfg
   *   minPeers       {number} peers required before mining is allowed (default 1)
   *   maxTipAgeSec   {number} how old the tip may be, in seconds (default 900)
   *   firstNode      {boolean} explicit "I am the first node of this network" override
   */
  constructor(cfg = {}) {
    this.minPeers = Number.isInteger(cfg.minPeers) && cfg.minPeers >= 0 ? cfg.minPeers : 1;
    this.maxTipAgeSec = Number.isFinite(cfg.maxTipAgeSec) && cfg.maxTipAgeSec > 0 ? cfg.maxTipAgeSec : 900;
    this.firstNode = cfg.firstNode === true;
    this.wasAllowed = false;
  }

  setFirstNode(v) { this.firstNode = v === true; }
  setMinPeers(v) { if (Number.isInteger(v) && v >= 0) this.minPeers = v; }
  setMaxTipAge(v) { if (Number.isFinite(v) && v > 0) this.maxTipAgeSec = v; }

  /**
   * @param {object} obs
   *   nodeRunning  {boolean}
   *   synced       {boolean}  node finished its initial block download
   *   peers        {number}   total connected peers
   *   tipAgeSec    {number|null} seconds since the best block's timestamp
   *   addressKind  {'transparent'|'unified'|null} as reported by the node
   *   mode         {'standard'|'shielded'}
   * @returns {{allow:boolean, state:string, reason:string, message:string, overridden:boolean}}
   */
  evaluate(obs = {}) {
    const mode = obs.mode === 'shielded' ? 'shielded' : 'standard';
    let reason = REASON.OK;

    if (!obs.nodeRunning) {
      reason = REASON.NO_NODE;
    } else if (!obs.addressKind) {
      reason = REASON.NO_ADDRESS;
    } else if (obs.addressKind !== MODE_REQUIRES[mode]) {
      reason = REASON.MODE_MISMATCH;
    } else if (obs.synced === false) {
      reason = REASON.NOT_SYNCED;
    } else if (!Number.isFinite(obs.peers) || obs.peers < this.minPeers) {
      reason = REASON.NO_PEERS;
    } else if (!Number.isFinite(obs.tipAgeSec) || obs.tipAgeSec > this.maxTipAgeSec) {
      reason = REASON.STALE_TIP;
    }

    // The override only excuses the two *network health* reasons. It can never
    // conjure a node, a payout address, or an address of the right kind, and it
    // never skips the node's own initial block download.
    const overridable = reason === REASON.NO_PEERS || reason === REASON.STALE_TIP;
    const overridden = this.firstNode && overridable;
    if (overridden) reason = REASON.OK;

    const allow = reason === REASON.OK;
    const state = allow ? 'allowed' : this.wasAllowed ? 'paused' : 'blocked';
    this.wasAllowed = allow;

    return {
      allow,
      state,
      reason,
      overridden,
      message: overridden
        ? 'Mining as the first node of this network. Nobody else is confirming these blocks yet.'
        : MESSAGES[reason],
      mode,
      requires: MODE_REQUIRES[mode]
    };
  }
}

/** Seconds between a block timestamp (unix seconds) and now. Null-safe. */
function tipAgeSeconds(blockTimeUnix, nowMs = Date.now()) {
  if (!Number.isFinite(blockTimeUnix) || blockTimeUnix <= 0) return null;
  return Math.max(0, Math.round(nowMs / 1000 - blockTimeUnix));
}

module.exports = { SyncGate, REASON, MESSAGES, MODE_REQUIRES, tipAgeSeconds };
