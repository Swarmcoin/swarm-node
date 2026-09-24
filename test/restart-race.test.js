'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ChainEngine } = require('../electron/chain/engine');
const manifest = require('./fixtures/throwaway-network.json');

test('overlapping config changes do not stop each other’s newly started node', async () => {
  const engine = new ChainEngine({ manifest, dataDir: '/tmp/swarm-restart-race-test', settings: {} });
  const steps = [];
  let active = 0;
  let maxActive = 0;
  engine.stopNode = async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    steps.push('stop');
    await new Promise((resolve) => setTimeout(resolve, 10));
  };
  engine.startNode = async () => {
    steps.push('start');
    active -= 1;
    return { ok: true };
  };

  const results = await Promise.all([engine.restartNode('gate pause'), engine.restartNode('payout changed')]);
  assert.deepEqual(results, [{ ok: true }, { ok: true }]);
  assert.deepEqual(steps, ['stop', 'start', 'stop', 'start']);
  assert.equal(maxActive, 1);
});
