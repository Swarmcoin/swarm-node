'use strict';

// Defect N-3: the payout step showed a spinner and a red error at once and
// left Continue greyed out, because nothing could be said until the node
// answered. These checks cover the offline first look that now answers
// instantly — and, just as important, what it must NOT claim.

const test = require('node:test');
const assert = require('node:assert');
const { inspect } = require('../electron/chain/address-format');

const TM = 'tmJymvcUCn1ctbghvTJpXBwHiMEB8P6wxNV';
const UTEST = 'utest10a8k6aw5w33kvyt7x6fryzu7vvsjru5vgcfnvr288qx2zm6p63ygcajtaze0px08t583dyrgr42vasazjhhnntus2tqrpkzu0dm2l4cgf3ld6wdqdrf3jv8mvfx9c80e73syer9l2wlgawjtf7yvj0eqwdf354trtelxnr0fhpw9792eaf49ghstkyftc9lwqqwy4ye0cleagp4nzyt';

test('a transparent address is recognised and selects standard mining', () => {
  const r = inspect(TM);
  assert.strictEqual(r.looksValid, true);
  assert.strictEqual(r.kind, 'transparent');
  assert.strictEqual(r.mode, 'standard');
  assert.match(r.detail, /visible on the explorer/);
});

test('a unified address is recognised and selects shielded mining', () => {
  const r = inspect(UTEST);
  assert.strictEqual(r.looksValid, true);
  assert.strictEqual(r.kind, 'unified');
  assert.strictEqual(r.mode, 'shielded');
  assert.match(r.detail, /as many processor cores as you choose/);
});

test('whitespace around a paste is tolerated', () => {
  assert.strictEqual(inspect(`  ${TM}  `).looksValid, true);
});

test('a space INSIDE the address is called out', () => {
  const r = inspect(TM.slice(0, 10) + ' ' + TM.slice(10));
  assert.strictEqual(r.looksValid, false);
  assert.match(r.hint, /space in it/);
});

test('the Base58 traps are named, not just refused', () => {
  const r = inspect('tm0ymvcUCn1ctbghvTJpXBwHiMEB8P6wxNV');
  assert.strictEqual(r.looksValid, false);
  assert.match(r.hint, /0, O, I or l/);
});

test('a truncated transparent address says how long it actually is', () => {
  const r = inspect(TM.slice(0, 30));
  assert.strictEqual(r.looksValid, false);
  assert.match(r.hint, /35 characters; this one is 30/);
});

test('a mainnet unified address is explained, not merely rejected', () => {
  const r = inspect('u1abcdefghijklmnopqrstuvwxyz023456789acdefghjklmnpqrstuvwxyz');
  assert.strictEqual(r.looksValid, false);
  assert.match(r.hint, /mainnet/);
  assert.match(r.hint, /utest1/);
});

test('a Sapling address is explained: neither engine can pay to it', () => {
  const r = inspect('ztestsapling1abcdefghijklmnopqrstuvwxyz0234567');
  assert.strictEqual(r.looksValid, false);
  assert.match(r.hint, /Neither mining mode/);
});

test('an address for another network is not silently accepted', () => {
  const r = inspect('t1Ks2m9YDXNR6zLtFsKF5vtkaBYtHrSmPpP');
  assert.strictEqual(r.looksValid, false);
  assert.match(r.hint, /different network/);
});

test('empty input produces no hint at all, so a blank box is not scolded', () => {
  const r = inspect('');
  assert.strictEqual(r.looksValid, false);
  assert.strictEqual(r.hint, null);
});

test('a plausible shape is never presented as a verdict on validity', () => {
  // Same characters, wrong checksum. The format check cannot tell, and must
  // not pretend to: only the node decides, and looksValid means "worth asking".
  const tampered = TM.slice(0, 34) + (TM[34] === 'V' ? 'W' : 'V');
  const r = inspect(tampered);
  assert.strictEqual(r.looksValid, true, 'the shape is still right; the node rejects it');
  assert.strictEqual(r.kind, 'transparent');
});

test('nothing here throws on rubbish input', () => {
  for (const bad of [null, undefined, 42, {}, [], '\u0000', 'x'.repeat(5000)]) {
    assert.doesNotThrow(() => inspect(bad));
    assert.strictEqual(inspect(bad).looksValid, false);
  }
});

test('SWARM unified addresses select shielded mining and reject mixed case', () => {
  const address = 'swarm12flymdvahre66el73vpyej6nva55s0lhxhp97ujv7k0vrhgvdgmsfp2xtccadctpqaku2uvw8jqm4w5py66mml9yxf600eluzumd473r';
  const inspected = inspect(address);
  assert.strictEqual(inspected.looksValid, true);
  assert.strictEqual(inspected.kind, 'unified');
  assert.strictEqual(inspected.mode, 'shielded');
  assert.strictEqual(inspect(address.replace('swarm', 'SwarM')).looksValid, false);
});
