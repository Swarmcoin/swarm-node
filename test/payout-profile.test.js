// A payout address is judged against the network that is RUNNING.
//
// THE DEFECT, reported by the owner on 0.2.0-mainnet.2. A SWARM mainnet
// pay-to-script-hash address, `s3R1bWZPrRCtKL122ZN6uySu1ewk2ku849C`, was saved
// and confirmed by the node — and the Mining screen then said "Your node does
// not recognise the address saved here, so nothing could be paid to it.
// Replace your payout address", with Settings showing "not confirmed by your
// node yet". Nothing was wrong with the address: the node accepts it, and the
// chain's own funding streams pay three addresses of exactly that shape.
//
// `ChainEngine.confirmAddressIfPending` — the catch-up check that runs when
// the node comes up after an address was saved while it was down — called
// `validateWithNode(this.rpc, this.address.value)` with no profile. The
// parameter defaults to `DEFAULT_PROFILE_ID`, which is `swarm-testnet`. So on
// a mainnet build every re-check classified the owner's `s3…` address as
// belonging to the other SWARM network, refused it before the node was even
// asked, and set `rejected`.
//
// Reproduced against the live chain before it was fixed: the first save
// answered `confirmed: true` from a real SwarmMain node, and the very next log
// line read "your node does not recognise the payout address: That is a SWARM
// mainnet address and this app is running the SWARM testnet."

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const NP = require('../electron/chain/network-profile');
const { validateWithNode } = require('../electron/chain/address');
const { inspect } = require('../electron/chain/address-format');

// The three funding destinations of the live chain and its baseline miner
// payout: real SWARM mainnet P2SH addresses, from the launch ceremony.
const S3 = [
  's3R1bWZPrRCtKL122ZN6uySu1ewk2ku849C',
  's3fLmEHc1xqs8KAe7QS7oupkhuGDjidV4eq',
  's3RiGvK5JzS8eh6ywN3K22f2LzDAhicgFuq',
  's3g3pzQVhvVX17bzrrEN3vmcXZWSpj7KFVp'
];

/** A node that accepts a transparent address, the way the real one does. */
const acceptingRpc = {
  calls: [],
  async validateAddress(a) { this.calls.push(a); return { isvalid: true, address: a, ismine: false }; },
  async zValidateAddress() { return { isvalid: false }; },
  async zListUnifiedReceivers() { return {}; }
};

test('s3 pay-to-script-hash is a SWARM mainnet payout address, like t2 on the testnet', () => {
  // The testnet profile has always accepted its own P2SH prefix; the mainnet
  // one must behave identically, and does - the profile table is symmetric.
  const t = NP.profileById('swarm-testnet');
  const m = NP.profileById('swarm-mainnet');
  assert.strictEqual(t.transparent.p2sh, 't2');
  assert.strictEqual(m.transparent.p2sh, 's3');
  assert.strictEqual(t.fundingAddressPrefix, 't2');
  assert.strictEqual(m.fundingAddressPrefix, 's3');

  for (const a of S3) {
    const seen = NP.classifyPrefix(m, a);
    assert.strictEqual(seen.kind, 'transparent', `${a} must read as transparent on mainnet`);
    assert.strictEqual(seen.wrongNetwork, null);
    assert.strictEqual(inspect(a, 'swarm-mainnet').looksValid, true);
    // And it belongs here, so a network switch never clears it.
    assert.strictEqual(NP.payoutBelongsTo('swarm-mainnet', a).ok, true);
  }
  // The p2pkh form too, which the owner will use for a personal payout.
  assert.strictEqual(NP.classifyPrefix(m, 's1MCkDhVejM4RqDyRR1rEJkudd26FVWipPD').kind, 'transparent');
});

test('the node is asked about an s3 address, and its yes is taken', async () => {
  acceptingRpc.calls = [];
  const r = await validateWithNode(acceptingRpc, S3[0], 'swarm-mainnet');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.kind, 'transparent');
  assert.strictEqual(r.confirmed, true);
  assert.deepStrictEqual(acceptingRpc.calls, [S3[0]], 'the node must actually be asked');
});

test('the same address WITHOUT a profile is refused - which is the whole bug', async () => {
  // Left here deliberately: the default is the testnet, and this is exactly
  // what confirmAddressIfPending did. The fix is not to change the default -
  // a wrong-network payout must stay refused - it is to pass the profile.
  const r = await validateWithNode(acceptingRpc, S3[0]);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.wrongNetwork, 'swarm-mainnet');
});

test('every validateWithNode call in the engine names the running profile', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'electron', 'chain', 'engine.js'), 'utf8');
  const calls = src.match(/validateWithNode\([^)]*\)/g) || [];
  assert.ok(calls.length >= 2, 'the engine validates addresses in more than one place');
  for (const c of calls) {
    assert.match(c, /this\.profile\.id/, `${c} must judge the address against the running network`);
  }
});

test('an address from the other network is still refused, on either side', async () => {
  const wrong = await validateWithNode(acceptingRpc, S3[0], 'swarm-testnet');
  assert.strictEqual(wrong.ok, false);
  assert.match(wrong.error, /SWARM mainnet address and this app is running the SWARM testnet/);

  const other = await validateWithNode(acceptingRpc, 'tmEXAMPLEEXAMPLEEXAMPLEEXAMPLEEXAMP', 'swarm-mainnet');
  assert.strictEqual(other.ok, false);
  assert.strictEqual(other.wrongNetwork, 'swarm-testnet');
});
