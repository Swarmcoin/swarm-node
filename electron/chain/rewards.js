// Reward accounting.
//
// Every number this module produces comes from the chain or from the miner's
// own output. Nothing is estimated, extrapolated or converted to a currency.
//
// Two honest modes, because the two miners pay differently:
//
//  * TRANSPARENT (standard mining). The payout address is a tm…/t2… address,
//    so the coinbase output that pays it is visible. We scan each new block's
//    coinbase transaction for outputs to that address and add up what is
//    actually there — which is the miner's share of the subsidy PLUS the
//    block's transaction fees. We never assume the amount.
//
//  * SHIELDED (Zebra's internal miner, utest… payout). The coinbase output is
//    encrypted, so no observer — including this app — can read the amount from
//    the chain. We count the blocks Zebra's own log reported as Accepted and
//    report the subsidy the node states for those heights, clearly labelled
//    "check your wallet". We never claim to know a shielded balance.
//
// Maturity: a coinbase output cannot be spent until it has the network's
// coinbase-maturity depth of confirmations (100 on this chain). Anything
// shallower is reported as maturing, never as spendable.
//
// The miner's share is 80% of the block subsidy on this network; the block
// subsidy in era 0 is 6.25 SWM, so a found block pays the miner 5.00 SWM plus
// fees. 6.25 is never shown as the miner's income.

'use strict';

const ZAT_PER_COIN = 100000000;

/** Confirmations of a block at `height` when the tip is at `tipHeight`. */
function confirmations(height, tipHeight) {
  if (!Number.isInteger(height) || !Number.isInteger(tipHeight) || tipHeight < height) return 0;
  return tipHeight - height + 1;
}

function isMature(height, tipHeight, maturity) {
  return confirmations(height, tipHeight) >= maturity;
}

/**
 * The miner's share of a block subsidy, in zatoshi, from the network's own
 * allocation table. Integer arithmetic only: the funding-stream recipients are
 * computed with floor division exactly as consensus does, and the miner keeps
 * the remainder, so the four parts always add back up to the subsidy.
 *
 * @param {number} subsidyZat  total block subsidy in zatoshi
 * @param {Array<{numerator:number}>} recipients
 * @returns {{minerZat:number, recipientZat:number[], totalZat:number}}
 */
function splitSubsidy(subsidyZat, recipients = []) {
  if (!Number.isInteger(subsidyZat) || subsidyZat < 0) throw new Error('subsidyZat must be a non-negative integer');
  let allocated = 0;
  const recipientZat = recipients.map((r) => {
    const n = Number(r.numerator);
    if (!Number.isInteger(n) || n < 0 || n > 100) throw new Error(`bad numerator ${r.numerator}`);
    const part = Math.floor((subsidyZat * n) / 100);
    allocated += part;
    return part;
  });
  if (allocated > subsidyZat) throw new Error('allocations exceed the subsidy');
  return { minerZat: subsidyZat - allocated, recipientZat, totalZat: subsidyZat };
}

/**
 * Ledger of blocks this machine found.
 *
 * Blocks are keyed by hash, so a height mined twice across a reorg cannot be
 * double-counted, and a block whose hash later disappears from the chain can
 * be dropped by the caller.
 */
class RewardLedger {
  /**
   * @param {object} cfg
   *   maturity       {number} coinbase maturity in blocks (100)
   *   recipients     {Array<{label:string,numerator:number}>} allocation table
   *   atomicPerCoin  {number} zatoshi per coin (1e8)
   */
  constructor(cfg = {}) {
    this.maturity = Number.isInteger(cfg.maturity) && cfg.maturity > 0 ? cfg.maturity : 100;
    this.recipients = Array.isArray(cfg.recipients) ? cfg.recipients : [];
    this.atomicPerCoin = Number.isInteger(cfg.atomicPerCoin) && cfg.atomicPerCoin > 0 ? cfg.atomicPerCoin : ZAT_PER_COIN;
    /** @type {Map<string, object>} hash -> block record */
    this.blocks = new Map();
  }

  /**
   * Record a block that paid this machine.
   *
   * @param {object} b
   *   hash       {string} block hash — the key
   *   height     {number}
   *   time       {number} block header time, unix seconds
   *   mode       {'transparent'|'shielded'}
   *   paidZat    {number|null} for transparent: the summed coinbase outputs to
   *              our address, read from the chain. Null for shielded.
   *   subsidyZat {number|null} total block subsidy the node reports for that
   *              height, used for cross-checking.
   *   minerSubsidyZat {number|null} the miner's share as the node itself states
   *              it (getblocksubsidy.miner). Preferred over recomputing.
   */
  record(b) {
    if (!b || typeof b.hash !== 'string' || !b.hash) throw new Error('block hash required');
    if (!Number.isInteger(b.height) || b.height < 0) throw new Error('block height required');
    const mode = b.mode === 'shielded' ? 'shielded' : 'transparent';
    if (mode === 'transparent' && !Number.isInteger(b.paidZat)) throw new Error('transparent block needs an integer paidZat');
    const prev = this.blocks.get(b.hash);
    this.blocks.set(b.hash, {
      hash: b.hash,
      height: b.height,
      time: Number.isFinite(b.time) ? b.time : null,
      mode,
      paidZat: mode === 'transparent' ? b.paidZat : null,
      subsidyZat: Number.isInteger(b.subsidyZat) ? b.subsidyZat : null,
      minerSubsidyZat: Number.isInteger(b.minerSubsidyZat) ? b.minerSubsidyZat : null,
      firstSeen: prev ? prev.firstSeen : Date.now()
    });
    return this.blocks.get(b.hash);
  }

  /**
   * The miner's share of one block, in zatoshi: the node's own figure when we
   * have it, otherwise the allocation table applied to the stated subsidy.
   * Returns null when neither is known.
   */
  minerShareOf(b) {
    if (Number.isInteger(b.minerSubsidyZat)) return b.minerSubsidyZat;
    if (Number.isInteger(b.subsidyZat)) return splitSubsidy(b.subsidyZat, this.recipients).minerZat;
    return null;
  }

  /** Drop a block that is no longer on the chain (reorg). */
  forget(hash) { return this.blocks.delete(hash); }

  /** Blocks newest first. */
  list() {
    return [...this.blocks.values()].sort((a, b) => b.height - a.height || (b.firstSeen - a.firstSeen));
  }

  /**
   * Totals at a given tip height.
   *
   * @returns {{
   *   blocksFound:number, transparentBlocks:number, shieldedBlocks:number,
   *   spendableZat:number, maturingZat:number, totalZat:number,
   *   shieldedSubsidyZat:number, shieldedIsEstimateOfSubsidyOnly:boolean,
   *   nextMaturesInBlocks:number|null
   * }}
   */
  totals(tipHeight) {
    let spendableZat = 0;
    let maturingZat = 0;
    let shieldedSubsidyZat = 0;
    let transparentBlocks = 0;
    let shieldedBlocks = 0;
    let nextMaturesInBlocks = null;

    for (const b of this.blocks.values()) {
      const mature = isMature(b.height, tipHeight, this.maturity);
      if (b.mode === 'transparent') {
        transparentBlocks += 1;
        if (mature) spendableZat += b.paidZat;
        else {
          maturingZat += b.paidZat;
          const left = this.maturity - confirmations(b.height, tipHeight);
          if (nextMaturesInBlocks == null || left < nextMaturesInBlocks) nextMaturesInBlocks = left;
        }
      } else {
        shieldedBlocks += 1;
        // The amount is encrypted. The miner's share the node states for that
        // height is the best honest label, and it is reported as exactly that.
        const share = this.minerShareOf(b);
        if (Number.isInteger(share)) shieldedSubsidyZat += share;
        if (!mature) {
          const left = this.maturity - confirmations(b.height, tipHeight);
          if (nextMaturesInBlocks == null || left < nextMaturesInBlocks) nextMaturesInBlocks = left;
        }
      }
    }

    return {
      blocksFound: this.blocks.size,
      transparentBlocks,
      shieldedBlocks,
      spendableZat,
      maturingZat,
      totalZat: spendableZat + maturingZat,
      shieldedSubsidyZat,
      shieldedIsEstimateOfSubsidyOnly: shieldedBlocks > 0,
      nextMaturesInBlocks
    };
  }

  toCoins(zat) { return zat / this.atomicPerCoin; }
}

/**
 * Sum the coinbase outputs that pay `address` in one decoded coinbase
 * transaction, in zatoshi. Works with the two shapes Zebra's verbose RPC
 * returns for scriptPubKey (`addresses: [..]` and `address: ".."`).
 *
 * Amounts arrive as decimal coins (a float in JSON), so they are converted to
 * integer zatoshi with rounding, never accumulated as floats.
 */
function coinbasePaidTo(tx, address, atomicPerCoin = ZAT_PER_COIN) {
  if (!tx || !Array.isArray(tx.vout) || typeof address !== 'string' || !address) return 0;
  let zat = 0;
  for (const out of tx.vout) {
    const spk = out && out.scriptPubKey;
    if (!spk) continue;
    const list = Array.isArray(spk.addresses) ? spk.addresses : spk.address ? [spk.address] : [];
    if (!list.includes(address)) continue;
    const v = out.valueZat != null ? Number(out.valueZat) : Math.round(Number(out.value) * atomicPerCoin);
    if (Number.isFinite(v) && v > 0) zat += Math.round(v);
  }
  return zat;
}

/**
 * Parse Zebra's internal-miner success line.
 * Real example from the 2026-09-21 spike log:
 *   ... zebrad::components::miner: successfully mined a new block
 *   height=Height(17) hash=block::Hash("026d…") solver_id=0 success=Accepted
 */
const MINED_LINE = /successfully mined a new block height=Height\((\d+)\) hash=block::Hash\("([0-9a-fA-F]{64})"\).*?success=(\w+)/;

function parseMinedLine(line) {
  const m = MINED_LINE.exec(String(line || ''));
  if (!m) return null;
  if (m[3] !== 'Accepted') return null;
  return { height: Number(m[1]), hash: m[2].toLowerCase() };
}

/**
 * Format zatoshi as a coin string: full precision, trailing zeros trimmed but
 * never below `minDecimals` places. 500000000 -> "5.00", 512345670 -> "5.1234567".
 */
function formatCoins(zat, atomicPerCoin = ZAT_PER_COIN, minDecimals = 2) {
  if (!Number.isFinite(zat)) return '—';
  const neg = zat < 0;
  const abs = Math.abs(Math.round(zat));
  const whole = Math.floor(abs / atomicPerCoin);
  const frac = String(abs % atomicPerCoin).padStart(String(atomicPerCoin - 1).length, '0');
  const trimmed = frac.replace(/0+$/, '').padEnd(minDecimals, '0');
  return `${neg ? '-' : ''}${whole}${trimmed ? '.' + trimmed : ''}`;
}

module.exports = {
  RewardLedger,
  splitSubsidy,
  confirmations,
  isMature,
  coinbasePaidTo,
  parseMinedLine,
  formatCoins,
  ZAT_PER_COIN
};
