// Arming mining is a promise, so it has to be kept - and it has to be
// cancellable.
//
// The Mining page's primary button reads "Start mining when ready" while the
// node is catching up. That sets one flag. These tests pin what the flag does
// and, as importantly, what cancels it: a user who presses Stop must not find
// mining running again a minute later because a forgotten arm fired.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { ChainEngine } = require('../electron/chain/engine');

function engine() {
  return new ChainEngine({
    manifest: require('../electron/net/network.json'),
    dataDir: 'C:/nowhere',
    settings: { payoutAddress: 'tmEXAMPLEEXAMPLEEXAMPLEEXAMPLEEXAMP', miningMode: 'standard' },
    saveSettings: () => {}
  });
}

test('mining starts unarmed', () => {
  assert.equal(engine().mining.armed, false);
});

test('arming is reported in the state the UI renders', () => {
  const e = engine();
  e.armMining(true);
  assert.equal(e.mining.armed, true);
  assert.equal(e.getState().mining.armed, true);
  // And the button says so, rather than claiming mining has begun.
  const next = e.getState().next;
  assert.ok(['disarm', 'start-node', 'set-address'].includes(next.id), `got ${next.id}`);
});

test('arming twice is not an error and does not double-log', () => {
  const e = engine();
  const lines = [];
  e.on('log', (l) => lines.push(l.text));
  e.armMining(true);
  const after = lines.length;
  e.armMining(true);
  assert.equal(lines.length, after, 'a second arm says nothing new');
  assert.equal(e.mining.armed, true);
});

test('it can be cancelled', () => {
  const e = engine();
  e.armMining(true);
  e.armMining(false);
  assert.equal(e.mining.armed, false);
});

test('stopping by hand cancels an armed start', async () => {
  const e = engine();
  e.armMining(true);
  await e.stopMining();
  assert.equal(e.mining.armed, false,
    'otherwise mining would restart behind a user who just stopped it');
});

test('an explicit start supersedes an armed one', async () => {
  const e = engine();
  e.armMining(true);
  // No node is running, so this fails - which is exactly the case that must
  // still clear the flag rather than leaving it to fire later.
  const r = await e.startMining();
  assert.equal(r.ok, false);
  assert.equal(e.mining.armed, false);
});

test('the armed flag never allows mining by itself', () => {
  const e = engine();
  e.armMining(true);
  // The gate is the only thing that decides, and with no node there is none.
  assert.equal(e.evaluateGate().allow, false);
});
