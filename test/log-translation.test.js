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

test('everything else still reaches the log, tidied rather than dropped', () => {
  const e = engine();
  for (const [raw, want] of [
    ['INFO zebrad::commands::start: spawning Zcash miner', 'spawning Zcash miner'],
    // A bare "sync:" is a plain English word, not an upstream module name, so
    // it stays. The rule is that no upstream project or crate name reaches the
    // user, not that every colon is stripped.
    ['INFO sync: verified block height=500', 'sync: verified block height=500'],
    ['WARN something genuinely odd happened', 'something genuinely odd happened']
  ]) {
    const out = e.translateNodeLine(raw);
    const text = out === undefined ? raw : out.text;
    assert.notStrictEqual(out, null, `must not be dropped: ${raw}`);
    assert.strictEqual(text, want, raw);
  }
});

test('a real problem is never hidden', () => {
  const e = engine();
  const out = e.translateNodeLine('ERROR zebra_state: database corruption detected');
  assert.notStrictEqual(out, null, 'an error must never be dropped');
  const text = out === undefined ? 'unchanged' : out.text;
  assert.match(text, /database corruption detected/);
});

test('the log a person reads carries no upstream module paths', () => {
  const e = engine();
  const cases = [
    ['2026-09-22T03:33:31.782513Z  INFO zebrad::commands::start: spawning Zcash miner',
     'spawning Zcash miner'],
    ['2026-09-22T03:39:05.302094Z  INFO run_mining_solver{solver_id=0}: zebrad::components::miner: successfully mined a new block',
     'successfully mined a new block'],
    ['2026-09-22T03:33:32.252438Z  INFO zebra_state::service: waiting for the block write task to finish',
     'waiting for the block write task to finish']
  ];
  for (const [raw, want] of cases) {
    assert.strictEqual(e.tidyNodeLine(raw), want, raw);
    assert.ok(!/zebrad?[:_]/.test(e.tidyNodeLine(raw)), 'no upstream module path may survive');
  }
});

test('tidying never throws away the sentence itself', () => {
  const e = engine();
  assert.strictEqual(e.tidyNodeLine('plain words with no tags'), 'plain words with no tags');
  assert.strictEqual(e.tidyNodeLine(''), '');
});

test('a tidied line is what reaches the log, and it is marked as the node speaking', () => {
  const e = engine();
  const out = e.translateNodeLine('2026-09-22T03:33:31.7Z  INFO zebrad::commands::start: spawning Zcash miner');
  assert.ok(out && out.kind === 'node');
  assert.strictEqual(out.text, 'spawning Zcash miner');
});

test('no upstream project name survives into the user-facing log', () => {
  const e = engine();
  const samples = [
    '2026-09-22T03:33:31.7Z  INFO zebrad::commands::start: spawning Zcash miner',
    '2026-09-22T03:33:32.2Z  INFO zebra_state::service::write: StateService closed the channel',
    '2026-09-22T03:33:33.1Z  INFO zebra_network::peer_set::initialize: finished connecting',
    '2026-09-22T03:33:34.0Z  INFO run_mining_solver{solver_id=0}: zebrad::components::miner: mined'
  ];
  for (const raw of samples) {
    const out = e.translateNodeLine(raw);
    if (out === null) continue;                       // dropped entirely, also fine
    const text = out === undefined ? raw : out.text;
    assert.ok(!/\bzebra/i.test(text), `"zebra" leaked into: ${text}`);
  }
});

test('the upstream project name never reaches the Log, tag or sentence', () => {
  const e = engine();
  const cases = [
    // The one the owner would have read, straight off the packaged build.
    ['2026-09-22T13:39:17.0Z  INFO zebrad::components::mempool: activating mempool: Zebra is close to the tip tip_height=Height(0)',
      /your node is close to the tip/],
    ['2026-09-22T13:39:17.0Z  INFO zebra_state::service: Zebra is unable to verify',
      /your node is unable to verify/]
  ];
  for (const [raw, want] of cases) {
    const out = e.translateNodeLine(raw);
    assert.ok(out && out.text, `dropped instead of translated: ${raw}`);
    assert.match(out.text, want);
    assert.ok(!/zebra/i.test(out.text), `"zebra" leaked: ${out.text}`);
  }
});

test('a peer dial that dumps the whole network definition is not shown', () => {
  const e = engine();
  const raw = '2026-09-22T13:39:15.0Z  INFO dial{network=ConfiguredTestnet(Parameters { network_name: "SwarmTestnet", '
    + 'genesis_hash: block::Hash("045993f5c91ea160c7ebda573dd97b0016816bca68d395bfff202779b88e2a28") })}: '
    + 'zebra_network::peer_set::initialize: connecting';
  assert.equal(e.translateNodeLine(raw), null, 'hundreds of characters of internal struct');
});

test('any over-long node line is cut rather than filling the box', () => {
  const e = engine();
  const raw = `2026-09-22T13:39:15.0Z  INFO some_crate::module: ${'x'.repeat(900)}`;
  const out = e.translateNodeLine(raw);
  assert.ok(out.text.length < 400, `still ${out.text.length} characters`);
  assert.match(out.text, /full line in the node/);
});
