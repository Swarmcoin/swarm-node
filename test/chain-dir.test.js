'use strict';

// One chain folder per GENESIS on a production network (network-profile.js,
// chainDirFor), the store that keeps the access code (electron/access-store.js),
// the found-blocks list that survives a restart, and the "is the network
// producing blocks" verdict.
//
// The relaunch of 2 October 2026 started SWARM mainnet again from a new
// genesis. Every 0.2.0-mainnet.x install keeps the FIRST chain in
// `chain-mainnet` (or wherever its owner moved it, as dataDirMainnet). That
// folder must never be opened by a node of the new chain, and never be moved
// or deleted either.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const NP = require('../electron/chain/network-profile');
const { createAccessStore } = require('../electron/access-store');
const { ChainEngine } = require('../electron/chain/engine');
const NS = require('../electron/chain/network-status');

const NEW = '01b76d8a0f18c502b23ab6605e26296d189aa5770fc4a34155e5c7b250a0eff2';
const OLD = '01c34428b9e67cdd8345e0b365aaa37dd8d2d65d3869e0e5d77d567f2c39afdd';
const U = path.join('C:', 'Users', 'x', 'AppData', 'Roaming', 'green.swarm.node');
const norm = (p) => p.replace(/\\/g, '/');

test('the restarted chain gets its own folder, named after its genesis', () => {
  assert.equal(norm(NP.chainDirFor('swarm-mainnet', NEW, {}, U)), norm(path.join(U, 'chain-mainnet-01b76d8a')));
  // The first chain's folder, default or moved, is NOT what the new chain uses.
  const owner = { dataDirMainnet: 'D:/SWARM/chain-mainnet' };
  assert.equal(norm(NP.chainDirFor('swarm-mainnet', NEW, owner, U)), norm(path.join(U, 'chain-mainnet-01b76d8a')));
  // Two genesis hashes, two folders.
  assert.notEqual(NP.chainDirFor('swarm-mainnet', NEW, {}, U), NP.chainDirFor('swarm-mainnet', OLD, {}, U));
  // A folder the owner moves for THIS chain is remembered for this chain only.
  const moved = NP.rememberChainDir('swarm-mainnet', NEW, owner, 'E:/chain-new');
  assert.deepEqual(moved, { dataDirByGenesis: { [NEW]: 'E:/chain-new' } });
  assert.equal(NP.chainDirFor('swarm-mainnet', NEW, { ...owner, ...moved }, U), 'E:/chain-new');
  assert.equal(norm(NP.chainDirFor('swarm-mainnet', OLD, { ...owner, ...moved }, U)), norm(path.join(U, 'chain-mainnet-01c34428')));
  // The testnet keeps its one folder, as before.
  assert.equal(norm(NP.chainDirFor('swarm-testnet', NEW, {}, U)), norm(path.join(U, 'chain')));
  assert.throws(() => NP.chainDirFor('swarm-mainnet', 'nope', {}, U), /genesis/);
});

test('the earlier chain folder is reported when it is still there, and never touched', () => {
  const exists = (p) => norm(p).endsWith('/chain-mainnet') || norm(p) === 'D:/SWARM/chain-mainnet';
  assert.equal(norm(NP.previousChainDir('swarm-mainnet', NEW, {}, U, exists)), norm(path.join(U, 'chain-mainnet')));
  assert.equal(NP.previousChainDir('swarm-mainnet', NEW, { dataDirMainnet: 'D:/SWARM/chain-mainnet' }, U, exists), 'D:/SWARM/chain-mainnet');
  assert.equal(NP.previousChainDir('swarm-mainnet', NEW, {}, U, () => false), null);
  assert.equal(NP.previousChainDir('swarm-testnet', NEW, {}, U, () => true), null);
  const r = NP.relaunchOf(require('../electron/net/network-mainnet.json'));
  assert.equal(r.dateText, '2 October 2026');
  assert.match(r.sentence, /^The SWARM network was restarted on 2 October 2026/);
});

test('settings keep the new keys (a hand-edited file cannot add others)', () => {
  const { defaults } = require('../electron/config-store');
  const d = defaults({});
  assert.ok('dataDirByGenesis' in d);
  assert.ok('accessCode' in d);
});

// ------------------------------------------------------------- access store

function fakeSettings() {
  return { data: { accessCode: null }, save(n) { Object.assign(this.data, n); return this.data; } };
}

test('with an OS store the code is kept encrypted, read back, and removed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-acc-'));
  const settings = fakeSettings();
  const safe = {
    isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.from(`ENC(${Buffer.from(s).toString('hex')})`),
    decryptString: (b) => Buffer.from(String(b).slice(4, -1), 'hex').toString()
  };
  const st = createAccessStore({ settings, safeStorage: safe, fs, dir });
  assert.deepEqual(st.read(), { ok: false, missing: true });
  assert.deepEqual(st.write('SWARMKEY1.secret.abcdef01'), { ok: true, encrypted: true });
  assert.equal(typeof settings.data.accessCode.enc, 'string');
  assert.ok(!JSON.stringify(settings.data).includes('SWARMKEY1'), 'the settings hold only the blob');
  assert.ok(!fs.existsSync(st.file));
  assert.deepEqual(st.read(), { ok: true, code: 'SWARMKEY1.secret.abcdef01', encrypted: true });
  st.remove();
  assert.equal(settings.data.accessCode, null);
  assert.deepEqual(st.read(), { ok: false, missing: true });
});

test('a blob this computer cannot decrypt asks for the code again', () => {
  const settings = fakeSettings();
  settings.data.accessCode = { enc: 'AAAA' };
  const st = createAccessStore({ settings, safeStorage: { isEncryptionAvailable: () => true, decryptString: () => { throw new Error('x'); } }, fs, dir: os.tmpdir() });
  const r = st.read();
  assert.equal(r.ok, false);
  assert.match(r.error, /Paste it again/);
});

test('without an OS store it goes to an owner-only file, and says so', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-acc-'));
  const settings = fakeSettings();
  const st = createAccessStore({ settings, safeStorage: { isEncryptionAvailable: () => false }, fs, dir });
  assert.deepEqual(st.write('SWARMKEY1.secret.abcdef01'), { ok: true, encrypted: false });
  assert.deepEqual(settings.data.accessCode, { file: true });
  if (process.platform !== 'win32') assert.equal(fs.statSync(st.file).mode & 0o777, 0o600);
  assert.equal(st.read().code, 'SWARMKEY1.secret.abcdef01');
  assert.deepEqual(st.remove(), { ok: true, removed: true });
  assert.ok(!fs.existsSync(st.file));
});

// --------------------------------------------------------- found blocks

test('blocks this computer found are kept per genesis and survive a restart', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-found-'));
  const manifest = require('../electron/net/network-mainnet.json');
  const make = (m = manifest) => new ChainEngine({ manifest: m, dataDir: dir, settings: {}, saveSettings: () => {} });
  const e = make();
  e.ledger.record({ hash: 'a'.repeat(64), height: 10, mode: 'shielded', minerSubsidyZat: 500000000, time: 1790960000 });
  e.ledger.record({ hash: 'b'.repeat(64), height: 12, mode: 'shielded', minerSubsidyZat: 500000000, time: 1790960300 });
  e.saveLedger();
  const again = make();
  const t = again.ledger.totals(20);
  assert.equal(t.blocksFound, 2);
  assert.equal(t.shieldedSubsidyZat, 1000000000);
  assert.equal(t.lastFoundHeight, 12);
  assert.equal(t.lastFoundAt, 1790960300 * 1000);
  // Another chain's list is ignored, never merged.
  const other = JSON.parse(JSON.stringify(manifest));
  other.genesis.hash = OLD;
  assert.equal(make(other).ledger.blocks.size, 0);
});

test('a found block that was replaced on the chain stops being counted', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-orphan-'));
  const e = new ChainEngine({ manifest: require('../electron/net/network-mainnet.json'), dataDir: dir, settings: {}, saveSettings: () => {} });
  e.ledger.record({ hash: 'a'.repeat(64), height: 10, mode: 'shielded', minerSubsidyZat: 500000000 });
  e.ledger.record({ hash: 'b'.repeat(64), height: 11, mode: 'shielded', minerSubsidyZat: 500000000 });
  e.chain.height = 15;
  e.rpc = { getBlockHash: async (h) => (h === 10 ? 'a'.repeat(64) : 'c'.repeat(64)) };
  await e.checkOrphans();
  const t = e.ledger.totals(15);
  assert.equal(t.blocksFound, 1);
  assert.equal(t.orphanedBlocks, 1);
  assert.equal(t.shieldedSubsidyZat, 500000000);
});

// ------------------------------------------------------ network verdict

test('"the network is producing blocks" is measured on the server clock', () => {
  const raw = {
    schema: 'swarm-network-status/1',
    genesis_hash: NEW,
    chain_label: 'swarm-mainnet',
    server_time_utc: '2026-10-02T18:39:41Z',
    node: { up: true, height: 156, peers: 0, tip_time_utc: '2026-10-02T18:37:57Z', tip_hash: '0'.repeat(64) },
    healthy: true
  };
  const v = NS.validate(raw, { genesisHash: NEW, chainLabel: 'swarm-mainnet' });
  assert.equal(v.ok, true);
  assert.equal(v.data.seedHeight, 156);
  assert.equal(v.data.tipAgeAtServerSec, 104);
  assert.deepEqual(NS.producing(v.data, 0), { producing: true, tipAgeSec: 104 });
  assert.deepEqual(NS.producing(v.data, 30000), { producing: true, tipAgeSec: 134 });
  const stalled = NS.validate({ ...raw, node: { ...raw.node, tip_time_utc: '2026-10-02T17:00:00Z' } }, { genesisHash: NEW }).data;
  assert.equal(NS.producing(stalled).producing, false);
  // Unknown stays unknown.
  const blank = NS.validate({ ...raw, node: { up: true } }, {}).data;
  assert.deepEqual(NS.producing(blank), { producing: null, tipAgeSec: null });
  assert.deepEqual(NS.producing(null), { producing: null, tipAgeSec: null });
  // The old chain's numbers are refused outright.
  assert.equal(NS.validate({ ...raw, genesis_hash: OLD }, { genesisHash: NEW }).ok, false);
});
