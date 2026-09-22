'use strict';

// The owner read Zebra's raw "initial sync is very slow, or estimated tip is
// wrong" in a console and asked what was broken. Nothing was: that warning
// comes from Zebra's wall-clock tip estimate, which a young chain always
// contradicts. Lines like it are rewritten or dropped before they reach the
// log a person reads; the node's own log files keep every original.

const test = require('node:test');
const assert = require('node:assert');
const { ChainEngine } = require('../electron/chain/engine');

function engine() {
  return new ChainEngine({
    manifest: require('../electron/net/network.json'),
    dataDir: 'C:/nowhere',
    settings: { payoutAddress: '', miningMode: 'standard' },
    saveSettings: () => {}
  });
}

test('the wall-clock sync warning is replaced with something true', () => {
  const e = engine();
  const raw = '2026-09-22T02:58:34.063202Z  INFO zebrad::components::sync::progress: initial sync is very slow, or estimated tip is wrong. Hint: check your network connection sync_percent=0.107%';
  const out = e.translateNodeLine(raw);
  assert.ok(out && out.text, 'the line must be replaced, not passed through');
  assert.match(out.text, /wallet server/);
  assert.match(out.text, /Nothing is wrong here/);
  assert.ok(!/estimated tip is wrong/.test(out.text));
});

test('noise with no meaning on this network is dropped entirely', () => {
  const e = engine();
  for (const raw of [
    'state is below the highest checkpoint',
    'INFO disk_db: assuming the open file limit is high enough for Zebra min_limit=512',
    'Thank you for running a swarmtestnet zebrad 6.3.0 node!'
  ]) {
    assert.strictEqual(e.translateNodeLine(raw), null, `should be dropped: ${raw}`);
  }
});

test('everything else passes through untouched', () => {
  const e = engine();
  for (const raw of [
    'INFO zebrad::commands::start: spawning Zcash miner',
    'INFO sync: verified block height=500',
    'WARN something genuinely odd happened'
  ]) {
    assert.strictEqual(e.translateNodeLine(raw), undefined, `should pass through: ${raw}`);
  }
});

test('a real problem is never hidden', () => {
  const e = engine();
  const bad = 'ERROR zebra_state: database corruption detected';
  assert.strictEqual(e.translateNodeLine(bad), undefined);
});
