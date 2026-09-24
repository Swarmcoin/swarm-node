'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { MinerPool } = require('../electron/chain/miner');

test('native miner accepted lines report the actual block hash once', () => {
  const pool = new MinerPool({ simulate: true });
  const hash = '0694560dbf08e20ac4ac21a436c85fc50da65c95bf63f9b0ee6d05b7cce78bc0';
  const found = [];
  pool.on('block', (block) => found.push(block));
  const worker = { index: 0, accepted: 0, solps: null };

  // Captured from the Apple-silicon native miner during the throwaway-chain run.
  const line = `ACCEPTED height 40 hash ${hash} elapsed 12.72s accepted 23`;
  pool.handleLine(worker, line);
  pool.handleLine(worker, line);
  pool.handleLine(worker, 'Miner stopped; accepted 23 blocks.');

  assert.deepEqual(found.map((block) => block.hash), [hash]);
  assert.equal(worker.accepted, 2);
});
