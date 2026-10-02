'use strict';

// privacy-miner exits on the first template the node refuses (RPC -10 while
// the node settles at the tip). The relaunch test of 2026-10-02 found the pool
// empty a second after "mining on" and nothing ever restarted it. A worker
// that stops by itself while mining is wanted is now started again; stop()
// cancels that.

const test = require('node:test');
const assert = require('node:assert/strict');
const { MinerPool } = require('../electron/chain/miner');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function pool() {
  const p = new MinerPool({ binaryPath: 'x', respawnMs: 30 });
  p.spawned = [];
  p.spawnWorker = async (index) => { p.spawned.push(index); p.workers.push({ index, pid: null }); return {}; };
  return p;
}

test('a worker that exits while mining is wanted is started again', async () => {
  const p = pool();
  p.desired = 2;
  assert.equal(p.scheduleRespawn(1), true);
  assert.equal(p.scheduleRespawn(1), false, 'one timer per slot');
  await wait(80);
  assert.deepEqual(p.spawned, [1]);
});

test('nothing is restarted once mining was stopped, or beyond the wanted count', async () => {
  const p = pool();
  p.desired = 1;
  assert.equal(p.scheduleRespawn(3), false);
  p.scheduleRespawn(0);
  await p.stop();
  await wait(80);
  assert.deepEqual(p.spawned, []);
});
