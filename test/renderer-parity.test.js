'use strict';

// The desktop app and the seed server must agree, character for character, on
// what the network IS. A node that disagrees about the magic, the genesis hash,
// the difficulty limit, the funding streams or an activation height is not on a
// slightly different chain — it is on a different chain, and it will be ignored
// by everyone else.
//
// So this test renders the network block with the app's own generator and
// compares it to the canonical file produced by scripts/swarm/render_config.py,
// byte for byte. If either side is changed without the other, this fails.
//
// The canonical file is copied into test/fixtures at the time the network
// manifest is embedded, so the test also runs in CI where D:/privacy does not
// exist.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { generateZebraConfig } = require('../electron/chain/config-gen');

const FIXTURE = path.join(__dirname, 'fixtures', 'canonical-zebra-local.toml');
const manifest = require('../electron/net/network.json');

/** Everything from [network.testnet_parameters] up to the next top-level table. */
function networkBlock(toml) {
  const start = toml.indexOf('[network.testnet_parameters]');
  assert.ok(start >= 0, 'no [network.testnet_parameters] section found');
  const rest = toml.slice(start);
  const end = rest.search(/\n\[(?!network\.testnet_parameters)/);
  return (end < 0 ? rest : rest.slice(0, end)).trimEnd();
}

test('the embedded manifest is the real SwarmTestnet definition', () => {
  assert.strictEqual(manifest.identity.network_name, 'SwarmTestnet');
  assert.deepStrictEqual(manifest.identity.network_magic, [83, 87, 82, 77]);
  assert.strictEqual(manifest.identity.ticker, 'SWM');
  assert.strictEqual(manifest.genesis.hash, '045993f5c91ea160c7ebda573dd97b0016816bca68d395bfff202779b88e2a28');
  assert.strictEqual(manifest.ports.public_p2p, 18233);
  assert.strictEqual(manifest.ports.rpc, 18232);
  assert.deepStrictEqual(manifest.seed_peers, ['seed.swarm.green:18233']);
});

test('the embedded genesis bytes hash to the genesis the manifest names', () => {
  const crypto = require('crypto');
  assert.match(manifest.genesis.hex, /^[0-9a-f]+$/);
  // The file hash, which is what the network manifest records.
  const fileHash = crypto.createHash('sha256').update(Buffer.from(manifest.genesis.hex + '\n', 'utf8')).digest('hex');
  assert.strictEqual(fileHash, manifest.genesis.hex_file_sha256);
  // And the block hash: double SHA-256 of the header, displayed reversed.
  // A Zcash header is NOT 80 bytes like Bitcoin's. It is 140 bytes of fields
  // (version, prev hash, merkle root, final sapling root, time, bits, nonce)
  // followed by the Equihash solution as a compact-size-prefixed byte string —
  // 1344 bytes for Equihash 200,9, so 1487 bytes in total. The length is read
  // from the block rather than hard-coded, so this checks the real encoding.
  const bytes = Buffer.from(manifest.genesis.hex, 'hex');
  const FIELDS = 140;
  let solLen;
  let solOffset;
  const tag = bytes[FIELDS];
  if (tag < 0xfd) { solLen = tag; solOffset = FIELDS + 1; }
  else if (tag === 0xfd) { solLen = bytes.readUInt16LE(FIELDS + 1); solOffset = FIELDS + 3; }
  else { throw new Error('unexpected compact size for the Equihash solution'); }
  assert.strictEqual(solLen, 1344, 'Equihash 200,9 solutions are 1344 bytes');
  const header = bytes.subarray(0, solOffset + solLen);
  assert.strictEqual(header.length, 1487);
  const h = crypto.createHash('sha256').update(crypto.createHash('sha256').update(header).digest()).digest();
  assert.strictEqual(Buffer.from(h).reverse().toString('hex'), manifest.genesis.hash);
});

test('the three destination addresses are P2SH, or the node would panic', () => {
  for (const r of manifest.economics.recipients) {
    assert.match(r.address, /^t2[1-9A-HJ-NP-Za-km-z]{20,}$/, `${r.label} must be a t2… P2SH address`);
  }
  const total = manifest.economics.recipients.reduce((a, r) => a + r.numerator, 0);
  assert.strictEqual(total, 20, 'the three allocations are 8 + 4 + 8 = 20%, leaving 80% to the miner');
});

test('the generated network block matches the canonical renderer byte for byte', (t) => {
  if (!fs.existsSync(FIXTURE)) {
    t.skip(`no canonical fixture at ${FIXTURE}`);
    return;
  }
  const canonical = networkBlock(fs.readFileSync(FIXTURE, 'utf8'));
  const mine = networkBlock(generateZebraConfig(manifest, { dataDir: 'C:/x' }));
  if (canonical !== mine) {
    // Show the first differing line rather than two walls of text.
    const a = canonical.split('\n');
    const b = mine.split('\n');
    for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
      if (a[i] !== b[i]) {
        assert.fail(`line ${i + 1} differs\n  canonical: ${JSON.stringify(a[i])}\n  app:       ${JSON.stringify(b[i])}`);
      }
    }
  }
  assert.strictEqual(mine, canonical);
});

test('the app defaults to the real ports and the real seed peer', () => {
  const toml = generateZebraConfig(manifest, { dataDir: 'C:/x' });
  assert.match(toml, /listen_addr = "0\.0\.0\.0:18233"/);
  assert.match(toml, /initial_testnet_peers = \["seed\.swarm\.green:18233"\]/);
  assert.match(toml, /\[rpc\][\s\S]*listen_addr = "127\.0\.0\.1:18232"/);
});
