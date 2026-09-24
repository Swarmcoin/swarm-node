'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

test('shielded mining history never claims a balance or a maturity countdown', async () => {
  const { rewardStatus } = await import('../src/reward-status.mjs');
  for (const tip of [null, 101, 500]) {
    assert.deepEqual(rewardStatus({ mode: 'shielded', height: 100 }, tip, 100),
      { label: 'Check wallet', mature: false });
  }
});

test('transparent reward history reports maturity and handles an unknown tip', async () => {
  const { rewardStatus } = await import('../src/reward-status.mjs');
  const block = { mode: 'transparent', height: 100 };
  assert.equal(rewardStatus(block, 198, 100).label, '1 to go');
  assert.deepEqual(rewardStatus(block, 199, 100), { label: 'Mature', mature: true });
  assert.equal(rewardStatus(block, null, 100).label, 'Waiting for chain tip');
  assert.equal(rewardStatus(block, 99, 100).label, 'Waiting for chain tip');
});
