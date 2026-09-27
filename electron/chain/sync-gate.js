// Sync gate — decides whether this machine is allowed to mine right now, and
// always says which number it is waiting for.
//
// WHY THIS EXISTS. Zebra reports every *test* network node as "synced" the
// moment it starts, whatever its peer count or tip age. Without a gate both
// miners would happily extend a stale tip with no peers, build a private fork,
// and have every block of it orphaned the moment the node reconnects. That
// wastes the user's electricity and pollutes the network.
//
// WHY IT LOOKS LIKE THIS — defect N-1, 2026-09-21.
// The first version guessed from tip age. The owner opened the app with their
// node at block 86, which WAS the tip, and Start mining was greyed out saying
// "still downloading". Block spacing here averages 60-90 s but is a Poisson
// process, so three- to five-minute gaps are ordinary; any rule that needs a
// young tip holds back a synced node and flaps. Tip age is now a weak hint
// only, and never blocks on its own.
//
// What decides instead, in order of strength:
//   1. an INDEPENDENT view of the tip — the project's wallet server, a
//      different machine running different code on the same chain. If our
//      height is within a block or two of it, we are caught up. Full stop.
//   2. if that is unreachable: peers, plus "no new block has been downloaded
//      for a while", which distinguishes an initial download (blocks pouring
//      in) from a quiet chain (nothing arriving because nothing was made).
// The UI is told which rule is in force, and both numbers, so the answer to
// "why can I not click mining" is on the screen.
//
// AND IT MUST NEVER DEADLOCK. If the gate has been closed for longer than the
// patience window on a network-health reason alone, it offers "Start anyway"
// with the reason attached. A user who can see both numbers is allowed to
// disagree with us.
//
// The gate performs no I/O, so the whole truth table is unit-tested.

'use strict';

const REASON = {
  NO_NODE: 'node-not-running',
  NOT_SYNCED: 'node-still-syncing',
  NO_PEERS: 'no-peers',
  BEHIND: 'behind-the-network',
  STALE_TIP: 'tip-too-old',
  NO_ADDRESS: 'no-payout-address',
  MODE_MISMATCH: 'address-wrong-type-for-mode',
  OK: 'ok'
};

const MESSAGES = {
  [REASON.NO_NODE]: 'The full node is not running yet. Mining needs a running node.',
  [REASON.NOT_SYNCED]:
    'Your node is still downloading blocks from the network. Mining starts once it has caught up.',
  [REASON.NO_PEERS]:
    'This node has no peers, so it cannot tell whether it is on the real chain. ' +
    'Mining now would build a private fork that everyone else throws away. ' +
    'Waiting for a peer.',
  [REASON.BEHIND]: 'Your node is behind the network and is still catching up.',
  [REASON.STALE_TIP]:
    'Your node has not seen a new block for a long time and cannot reach anything to check against.',
  [REASON.NO_ADDRESS]: 'No payout address yet. Paste one from the SWARM Wallet first.',
  [REASON.MODE_MISMATCH]: 'This payout address does not fit the selected mining mode.',
  [REASON.OK]: 'Ready to mine.'
};

// What each mining mode needs from the payout address, as reported by the
// node itself (see chain/address.js — this app never parses an address).
const MODE_REQUIRES = {
  standard: 'transparent', // N copies of privacy-miner.exe, transparent tm…/t2… payout
  shielded: 'unified'      // the node's own miner, across the chosen cores, utest… payout
};

// Reasons that are about network health rather than about the user's setup.
// Only these can be overridden — by the first-node operator, or by a user who
// has waited out the patience window and can see both numbers.
const HEALTH_REASONS = new Set([REASON.NO_PEERS, REASON.NOT_SYNCED, REASON.BEHIND, REASON.STALE_TIP]);

class SyncGate {
  /**
   * @param {object} cfg
   *   minPeers        {number} peers required before mining is allowed (default 1)
   *   maxBehind       {number} blocks we may be behind the independent tip (default 2)
   *   quietSeconds    {number} no new block for this long means the download has
   *                            finished, when there is no independent tip (default 45)
   *   maxTipAgeSec    {number} weak hint only; used when nothing else can be known
   *   patienceSeconds {number} after this long held back on health alone, offer
   *                            "Start anyway" (default 600)
   *   firstNode       {boolean} explicit "I am the first node of this network"
   */
  constructor(cfg = {}) {
    this.minPeers = Number.isInteger(cfg.minPeers) && cfg.minPeers >= 0 ? cfg.minPeers : 1;
    this.maxBehind = Number.isInteger(cfg.maxBehind) && cfg.maxBehind >= 0 ? cfg.maxBehind : 2;
    this.quietSeconds = Number.isFinite(cfg.quietSeconds) && cfg.quietSeconds > 0 ? cfg.quietSeconds : 45;
    this.maxTipAgeSec = Number.isFinite(cfg.maxTipAgeSec) && cfg.maxTipAgeSec > 0 ? cfg.maxTipAgeSec : 7200;
    this.patienceSeconds = Number.isFinite(cfg.patienceSeconds) && cfg.patienceSeconds > 0 ? cfg.patienceSeconds : 600;
    this.firstNode = cfg.firstNode === true;
    this.userOverride = false;
    this.wasAllowed = false;
    this.blockedSince = null;
  }

  setFirstNode(v) { this.firstNode = v === true; }
  setMinPeers(v) { if (Number.isInteger(v) && v >= 0) this.minPeers = v; }
  setMaxTipAge(v) { if (Number.isFinite(v) && v > 0) this.maxTipAgeSec = v; }
  /** "Start anyway": only meaningful once offerOverride is true. */
  setUserOverride(v) { this.userOverride = v === true; }

  /**
   * @param {object} obs
   *   nodeRunning   {boolean}
   *   peers         {number}   total connected peers
   *   height        {number|null} this node's height
   *   networkHeight {number|null} an INDEPENDENT view of the tip, or null
   *   networkSource {string|null} where that came from, for the UI
   *   secondsSinceNewBlock {number|null} since this node last accepted a block
   *   tipAgeSec     {number|null} age of the newest block's timestamp
   *   addressKind   {'transparent'|'unified'|null} as reported by the node
   *   mode          {'standard'|'shielded'}
   *   nowMs         {number} injectable clock, for tests
   */
  evaluate(obs = {}) {
    const mode = obs.mode === 'shielded' ? 'shielded' : 'standard';
    const now = Number.isFinite(obs.nowMs) ? obs.nowMs : Date.now();
    let reason = REASON.OK;
    let rule = null;

    const netHeight = Number.isInteger(obs.networkHeight) ? obs.networkHeight : null;
    const myHeight = Number.isInteger(obs.height) ? obs.height : null;
    const behind = netHeight != null && myHeight != null ? Math.max(0, netHeight - myHeight) : null;

    if (!obs.nodeRunning) {
      reason = REASON.NO_NODE;
    } else if (!obs.addressKind) {
      reason = REASON.NO_ADDRESS;
    } else if (obs.addressKind !== MODE_REQUIRES[mode]) {
      reason = REASON.MODE_MISMATCH;
    } else if (!Number.isFinite(obs.peers) || obs.peers < this.minPeers) {
      reason = REASON.NO_PEERS;
    } else if (behind != null) {
      // Strongest rule: somebody else's view of the tip.
      rule = `compared with ${obs.networkSource || 'the network'}`;
      if (behind > this.maxBehind) reason = REASON.BEHIND;
    } else {
      // No second opinion. Has this node stopped pulling blocks down?
      rule = 'no second opinion available: using peers and how long since a new block';
      const quiet = obs.secondsSinceNewBlock;
      if (Number.isFinite(quiet) && quiet < this.quietSeconds) {
        reason = REASON.NOT_SYNCED;
      } else if (!Number.isFinite(quiet)) {
        // Nothing has arrived since the app started. Fall back to the weak
        // hint, generously: this must not hold back a quiet but healthy chain.
        if (!Number.isFinite(obs.tipAgeSec) || obs.tipAgeSec > this.maxTipAgeSec) reason = REASON.STALE_TIP;
      }
    }

    const isHealth = HEALTH_REASONS.has(reason);

    // Track how long we have been held back on health grounds alone.
    if (reason === REASON.OK || !isHealth) this.blockedSince = null;
    else if (this.blockedSince == null) this.blockedSince = now;
    const blockedForSec = this.blockedSince == null ? 0 : Math.round((now - this.blockedSince) / 1000);
    const offerOverride = isHealth && blockedForSec >= this.patienceSeconds;

    const overridden = isHealth && (this.firstNode || (this.userOverride && offerOverride));
    if (overridden) reason = REASON.OK;

    const allow = reason === REASON.OK;
    const state = allow ? 'allowed' : this.wasAllowed ? 'paused' : 'blocked';
    this.wasAllowed = allow;

    let message;
    if (overridden && this.firstNode) {
      message = 'Mining as the first node of this network. Nobody else is confirming these blocks yet.';
    } else if (overridden) {
      message = 'Mining anyway, at your request. Your node may not be on the network’s best chain.';
    } else if (reason === REASON.BEHIND) {
      message = `Your node is at block ${myHeight} and ${obs.networkSource || 'the network'} is at ${netHeight}. ` +
        'Mining starts when yours catches up.';
    } else {
      message = MESSAGES[reason];
    }

    return {
      allow,
      state,
      reason,
      overridden,
      message,
      mode,
      requires: MODE_REQUIRES[mode],
      // Everything the UI needs to answer "why can I not click mining".
      rule,
      myHeight,
      networkHeight: netHeight,
      networkSource: obs.networkSource || null,
      behind,
      peers: Number.isFinite(obs.peers) ? obs.peers : null,
      tipAgeSec: Number.isFinite(obs.tipAgeSec) ? obs.tipAgeSec : null,
      blockedForSec,
      offerOverride,
      userOverride: this.userOverride,
      firstNode: this.firstNode
    };
  }
}

/** Seconds between a block timestamp (unix seconds) and now. Null-safe. */
function tipAgeSeconds(blockTimeUnix, nowMs = Date.now()) {
  if (!Number.isFinite(blockTimeUnix) || blockTimeUnix <= 0) return null;
  return Math.max(0, Math.round(nowMs / 1000 - blockTimeUnix));
}

module.exports = { SyncGate, REASON, MESSAGES, MODE_REQUIRES, HEALTH_REASONS, tipAgeSeconds };
