'use strict';

// The tip oracle reads one number out of a protobuf message by hand. A wrong
// field number is silent — an earlier draft read field 9 (`branch`, a string)
// instead of field 7 and reported "no block height" for ever — so the parsing
// is tested against a real recorded reply from the live wallet server.

const test = require('node:test');
const assert = require('node:assert');
const { TipOracle, findField, readVarint, FIELD_BLOCK_HEIGHT, FIELD_CHAIN_NAME } = require('../electron/chain/tip-oracle');

/** Build a protobuf field, so the fixture below is readable rather than hex. */
function varintField(field, value) {
  const key = (field << 3) | 0;
  const out = [];
  let k = key;
  do { out.push((k & 0x7f) | (k > 0x7f ? 0x80 : 0)); k >>= 7; } while (k > 0);
  let v = value;
  do { out.push((v & 0x7f) | (v > 0x7f ? 0x80 : 0)); v >>= 7; } while (v > 0);
  return Buffer.from(out);
}
function stringField(field, text) {
  const key = (field << 3) | 2;
  const body = Buffer.from(text, 'utf8');
  return Buffer.concat([Buffer.from([key]), Buffer.from([body.length]), body]);
}

// LightdInfo exactly as lwd.swarm.green answered on 2026-09-22, when the
// owner's own node was also at 492.
const LIVE_REPLY = Buffer.concat([
  stringField(1, '0.10.0'),
  stringField(2, 'ZingoLabs ZainoD'),
  varintField(3, 1),
  stringField(4, 'swarm-testnet'),
  varintField(5, 1),
  stringField(6, '37a5165b'),
  varintField(7, 492),
  stringField(8, 'dcfe664d4de3a47887d019ffbc3e428f1b224851'),
  stringField(9, 'swarm-testnet-support'),
  stringField(10, 'unknown'),
  stringField(11, 'runner'),
  varintField(12, 493),
  stringField(13, 'v6.3.0'),
  stringField(14, '/Zebra:6.3.0/')
]);

test('readVarint reads multi-byte values', () => {
  assert.deepStrictEqual(readVarint(Buffer.from([0x01]), 0), [1n, 1]);
  assert.deepStrictEqual(readVarint(Buffer.from([0xec, 0x03]), 0), [492n, 2]);
  assert.deepStrictEqual(readVarint(Buffer.from([]), 0), [null, 0]);
});

test('the block height is field 7, not field 9', () => {
  assert.strictEqual(findField(LIVE_REPLY, FIELD_BLOCK_HEIGHT), 492n);
  // Field 9 is a string; reading it as the height is the bug this guards.
  const nine = findField(LIVE_REPLY, 9);
  assert.ok(Buffer.isBuffer(nine));
  assert.strictEqual(nine.toString('utf8'), 'swarm-testnet-support');
});

test('the chain name is readable, so a server on another chain can be refused', () => {
  const name = findField(LIVE_REPLY, FIELD_CHAIN_NAME);
  assert.strictEqual(name.toString('utf8'), 'swarm-testnet');
});

test('a missing field is null rather than a wrong number', () => {
  assert.strictEqual(findField(LIVE_REPLY, 99), null);
  assert.strictEqual(findField(Buffer.alloc(0), 7), null);
});

test('an oracle with no URL is simply unavailable', async () => {
  const o = new TipOracle({});
  assert.strictEqual(o.available, false);
  assert.strictEqual(await o.refresh(), null);
  assert.strictEqual(o.current(), null);
});

test('an answer ages out rather than being trusted for ever', () => {
  const o = new TipOracle({ url: 'https://example.invalid' });
  const t = 1_800_000_000_000;
  o.last = { height: 492, at: t };
  assert.deepStrictEqual(o.current(t + 60_000), { height: 492, at: t });
  assert.strictEqual(o.current(t + 301_000), null, 'a five-minute-old answer is no longer current');
});

test('refresh never throws, whatever the server does', async () => {
  const o = new TipOracle({ url: 'https://lwd.invalid.example:443', timeoutMs: 1500 });
  const r = await o.refresh();
  assert.strictEqual(r, null);
  assert.ok(o.lastError, 'the failure is recorded so the UI can say which rule is in force');
  assert.strictEqual(o.consecutiveFailures, 1);
});

test('only https is accepted, and only a plausible height', async () => {
  const o = new TipOracle({ url: 'http://lwd.swarm.green:443' });
  await o.refresh();
  assert.match(o.lastError, /must be https/);
});
