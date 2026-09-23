'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  RewardLedger, splitSubsidy, confirmations, isMature,
  coinbasePaidTo, parseMinedLine, parseSolverRate, formatCoins, ZAT_PER_COIN
} = require('../electron/chain/rewards');

const RECIPIENTS = [
  { label: 'Core Development', numerator: 8 },
  { label: 'Grants & Ecosystem', numerator: 4 },
  { label: 'Community & Development Reserve', numerator: 8 }
];

const ERA0 = Math.round(6.25 * ZAT_PER_COIN); // 625_000_000 zatoshi

test('the miner gets 80% of the era-0 subsidy: 5.00 SWM, not 6.25', () => {
  const s = splitSubsidy(ERA0, RECIPIENTS);
  assert.strictEqual(s.minerZat, 500000000);
  assert.strictEqual(formatCoins(s.minerZat), '5.00');
  assert.deepStrictEqual(s.recipientZat, [50000000, 25000000, 50000000]);
  assert.strictEqual(s.minerZat + s.recipientZat.reduce((a, b) => a + b, 0), ERA0);
});

test('the 80 / 8 / 4 / 8 split survives every halving', () => {
  let subsidy = ERA0;
  for (let era = 0; era < 6; era += 1) {
    const s = splitSubsidy(subsidy, RECIPIENTS);
    assert.strictEqual(s.minerZat + s.recipientZat.reduce((a, b) => a + b, 0), subsidy, `era ${era} must add up`);
    if (subsidy % 100 === 0) {
      assert.strictEqual(s.minerZat, subsidy * 0.8, `era ${era} miner share is exactly 80%`);
    }
    subsidy = Math.floor(subsidy / 2);
  }
});

test('rounding never creates coins: allocations use floor and the miner keeps the remainder', () => {
  const odd = 1000000003; // not divisible by 100
  const s = splitSubsidy(odd, RECIPIENTS);
  assert.strictEqual(s.minerZat + s.recipientZat.reduce((a, b) => a + b, 0), odd);
  assert.ok(s.minerZat >= Math.floor(odd * 0.8));
});

test('confirmations and maturity', () => {
  assert.strictEqual(confirmations(100, 100), 1);
  assert.strictEqual(confirmations(100, 199), 100);
  assert.strictEqual(confirmations(100, 99), 0);
  assert.strictEqual(isMature(100, 198, 100), false);
  assert.strictEqual(isMature(100, 199, 100), true);
});

test('a freshly mined block is maturing, and becomes spendable at 100 confirmations', () => {
  const l = new RewardLedger({ maturity: 100, recipients: RECIPIENTS });
  l.record({ hash: 'a'.repeat(64), height: 10, mode: 'transparent', paidZat: 500000000, subsidyZat: ERA0, minerSubsidyZat: 500000000 });

  let t = l.totals(10);
  assert.strictEqual(t.blocksFound, 1);
  assert.strictEqual(t.maturingZat, 500000000);
  assert.strictEqual(t.spendableZat, 0);
  assert.strictEqual(t.nextMaturesInBlocks, 99);

  t = l.totals(108);  // 99 confirmations
  assert.strictEqual(t.spendableZat, 0);
  assert.strictEqual(t.nextMaturesInBlocks, 1);

  t = l.totals(109);  // 100 confirmations
  assert.strictEqual(t.spendableZat, 500000000);
  assert.strictEqual(t.maturingZat, 0);
  assert.strictEqual(t.nextMaturesInBlocks, null);
  assert.strictEqual(t.totalZat, 500000000);
});

test('transparent income is what the chain actually paid, fees included', () => {
  const l = new RewardLedger({ maturity: 100, recipients: RECIPIENTS });
  // 5.00 subsidy share + 0.0012 in fees, as found in the coinbase outputs.
  l.record({ hash: 'b'.repeat(64), height: 5, mode: 'transparent', paidZat: 500120000, subsidyZat: ERA0, minerSubsidyZat: 500000000 });
  const t = l.totals(200);
  assert.strictEqual(t.spendableZat, 500120000, 'the recorded amount, not the subsidy, is reported');
});

test('blocks are keyed by hash, so a reorged height cannot be double-counted', () => {
  const l = new RewardLedger({ maturity: 100, recipients: RECIPIENTS });
  l.record({ hash: 'c'.repeat(64), height: 7, mode: 'transparent', paidZat: 500000000 });
  l.record({ hash: 'c'.repeat(64), height: 7, mode: 'transparent', paidZat: 500000000 });
  assert.strictEqual(l.totals(200).blocksFound, 1);

  // Same height, different hash: two distinct blocks until the caller drops one.
  l.record({ hash: 'd'.repeat(64), height: 7, mode: 'transparent', paidZat: 500000000 });
  assert.strictEqual(l.totals(200).blocksFound, 2);
  l.forget('d'.repeat(64));
  assert.strictEqual(l.totals(200).blocksFound, 1);
});

test('shielded blocks are counted, and their amount is only ever the stated subsidy share', () => {
  const l = new RewardLedger({ maturity: 100, recipients: RECIPIENTS });
  l.record({ hash: 'e'.repeat(64), height: 20, mode: 'shielded', subsidyZat: ERA0, minerSubsidyZat: 500000000 });
  const t = l.totals(200);
  assert.strictEqual(t.shieldedBlocks, 1);
  assert.strictEqual(t.shieldedSubsidyZat, 500000000);
  assert.strictEqual(t.spendableZat, 0, 'a shielded amount is never reported as a spendable balance');
  assert.strictEqual(t.maturingZat, 0);
  assert.strictEqual(t.shieldedIsLabelOnly ?? t.shieldedIsEstimateOfSubsidyOnly, true);
});

test('a shielded block falls back to the allocation table when the node states no miner figure', () => {
  const l = new RewardLedger({ maturity: 100, recipients: RECIPIENTS });
  l.record({ hash: 'f'.repeat(64), height: 3, mode: 'shielded', subsidyZat: ERA0 });
  assert.strictEqual(l.totals(200).shieldedSubsidyZat, 500000000);
});

test('a transparent record without an amount is refused rather than guessed', () => {
  const l = new RewardLedger();
  assert.throws(() => l.record({ hash: 'x'.repeat(64), height: 1, mode: 'transparent' }), /integer paidZat/);
  assert.throws(() => l.record({ height: 1, mode: 'shielded' }), /hash required/);
});

test('coinbasePaidTo reads both scriptPubKey shapes and ignores other outputs', () => {
  const addr = 'tmJymvcUCn1ctbghvTJpXBwHiMEB8P6wxNV';
  const other = 't2JaQV6iQ9MA3HmWVYhfEn9mrMh3fRZpwTA';
  const tx = {
    vout: [
      { value: 5.0, scriptPubKey: { addresses: [addr] } },
      { value: 0.5, scriptPubKey: { addresses: [other] } },
      { value: 0.0012, scriptPubKey: { address: addr } },
      { value: 0.25, scriptPubKey: {} }
    ]
  };
  assert.strictEqual(coinbasePaidTo(tx, addr), 500120000);
  assert.strictEqual(coinbasePaidTo(tx, other), 50000000);
  assert.strictEqual(coinbasePaidTo(tx, 'tmNotMine'), 0);
  assert.strictEqual(coinbasePaidTo(null, addr), 0);
});

test('coinbasePaidTo prefers an exact zatoshi field over the float', () => {
  const addr = 'tmJymvcUCn1ctbghvTJpXBwHiMEB8P6wxNV';
  const tx = { vout: [{ value: 5.00000001, valueZat: 500000001, scriptPubKey: { addresses: [addr] } }] };
  assert.strictEqual(coinbasePaidTo(tx, addr), 500000001);
});

test('parseMinedLine reads a real Zebra internal-miner success line', () => {
  const line = '2026-09-21T13:39:05.302094Z  INFO run_mining_solver{solver_id=0}: zebrad::components::miner: ' +
    'successfully mined a new block height=Height(17) ' +
    'hash=block::Hash("026d712f073e117f40b1df4f66c8049fb894dc7ee9a47cbbeee6a4eee39d0ab7") solver_id=0 success=Accepted';
  assert.deepStrictEqual(parseMinedLine(line), {
    height: 17,
    hash: '026d712f073e117f40b1df4f66c8049fb894dc7ee9a47cbbeee6a4eee39d0ab7'
  });
});

test('parseMinedLine ignores everything that is not an accepted block', () => {
  assert.strictEqual(parseMinedLine('mining with an updated block template height=18 transactions=0'), null);
  assert.strictEqual(parseMinedLine('successfully mined a new block height=Height(9) hash=block::Hash("' + 'a'.repeat(64) + '") success=Rejected'), null);
  assert.strictEqual(parseMinedLine(''), null);
  assert.strictEqual(parseMinedLine(null), null);
});

test('the solver rate is read from the line a miner printed, and never invented', () => {
  const nodeLine = '2026-09-22T23:40:00.123456Z  INFO zebrad::components::miner: ' +
    'internal miner rate: 1234 sol/s (attempts 12345 in 10.0s)';
  assert.strictEqual(parseSolverRate(nodeLine), 1234);
  assert.strictEqual(parseSolverRate('Mining rate 2.5k sol/s (attempts 25000 in 10.0s)'), 2500);
  assert.strictEqual(parseSolverRate('Mining rate 1.5M sol/s'), 1500000);
  assert.strictEqual(parseSolverRate('internal miner rate: 987.5 sol/s'), 987.5);

  // No rate printed, no rate shown: a block, a template or a difficulty is not
  // a measurement, and zero is not one either.
  assert.strictEqual(parseSolverRate('successfully mined a new block height=Height(1480)'), null);
  assert.strictEqual(parseSolverRate('internal miner rate: 0 sol/s (attempts 0 in 10.0s)'), null);
  assert.strictEqual(parseSolverRate('mining with an updated block template height=1490 transactions=0'), null);
  assert.strictEqual(parseSolverRate(''), null);
  assert.strictEqual(parseSolverRate(null), null);
});

test('formatCoins never shows a float artefact', () => {
  assert.strictEqual(formatCoins(500000000), '5.00');
  assert.strictEqual(formatCoins(625000000), '6.25');
  assert.strictEqual(formatCoins(0), '0.00');
  assert.strictEqual(formatCoins(1), '0.00000001');
  assert.strictEqual(formatCoins(500120000), '5.0012');
  assert.strictEqual(formatCoins(NaN), '—');
});
