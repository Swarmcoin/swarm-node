// The Mining page must never be a dead end.
//
// The owner's report on 0.2.0-testnet.2 was "Start Mining can not be clicked.
// Why is that?" - a disabled button with the reason somewhere else on the
// screen. These tests pin the rule that replaced it: whatever the state, there
// is exactly one primary action, it is one the renderer knows how to perform,
// and it comes with a reason in words.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { nextAction, ACTIONS, syncProgress } = require('../electron/chain/next-action');

/** A healthy, ready-to-mine snapshot; each test bends one thing. */
const ready = (over = {}) => ({
  mining: { on: false, mode: 'standard', standardAvailable: true, workers: 0, armed: false },
  node: { running: true, height: 1010, networkHeight: 1010 },
  gate: { allow: true, message: '', networkHeight: 1010 },
  payout: { address: 'tmEXAMPLEEXAMPLEEXAMPLEEXAMPLEEXAMP' },
  ...over
});

/** Every state the app can be in, for the invariant sweep below. */
function everyState() {
  const out = [];
  for (const on of [false, true]) {
    for (const running of [false, true]) {
      for (const allow of [false, true]) {
        for (const address of ['', 'tmEXAMPLEEXAMPLEEXAMPLEEXAMPLEEXAMP']) {
          for (const armed of [false, true]) {
            for (const avail of [false, true]) {
              for (const offer of [false, true]) {
                for (const mode of ['standard', 'shielded']) {
                  out.push({
                    mining: { on, mode, standardAvailable: avail, workers: on ? 4 : 0, armed },
                    node: { running, height: running ? 500 : null, networkHeight: 1010 },
                    gate: { allow, message: allow ? '' : 'Your node is still catching up.', offerOverride: offer, networkHeight: 1010 },
                    payout: { address }
                  });
                }
              }
            }
          }
        }
      }
    }
  }
  return out;
}

test('there is always exactly one enabled primary action, with a reason', () => {
  for (const s of everyState()) {
    const a = nextAction(s);
    assert.ok(a && typeof a.id === 'string', 'an action is always returned');
    assert.ok(ACTIONS.includes(a.id), `the renderer must know how to do "${a.id}"`);
    assert.ok(a.label && a.label.trim().length > 3, `"${a.id}" needs a label`);
    assert.ok(a.why && a.why.trim().length > 10, `"${a.id}" needs a one-line reason`);
    assert.ok(a.tone === 'primary' || a.tone === 'danger');
    // A dead end would be an action that cannot be taken. There is no
    // "disabled" in the vocabulary at all, which is the point.
    assert.ok(!('disabled' in a));
    if (a.alternative) {
      assert.ok(ACTIONS.includes(a.alternative.id), `the renderer must know "${a.alternative.id}"`);
      assert.ok(a.alternative.label && a.alternative.why, 'an alternative needs a label and a reason');
    }
  }
});

test('mining running offers stopping it', () => {
  const a = nextAction(ready({ mining: { on: true, mode: 'standard', workers: 4, standardAvailable: true, armed: false } }));
  assert.equal(a.id, 'stop');
  assert.equal(a.tone, 'danger');
  assert.match(a.why, /4 cores/);
});

test('no payout address is asked for before anything else', () => {
  const a = nextAction(ready({ payout: { address: '' }, node: { running: false } }));
  assert.equal(a.id, 'set-address');
  assert.match(a.why, /pay/i);
});

test('a stopped node is started, not complained about', () => {
  const a = nextAction(ready({ node: { running: false, height: null } }));
  assert.equal(a.id, 'start-node');
});

test('a closed gate arms mining instead of blocking it', () => {
  const s = ready({ gate: { allow: false, message: 'Your node is still catching up.', networkHeight: 1010 }, node: { running: true, height: 120 } });
  const a = nextAction(s);
  assert.equal(a.id, 'arm');
  assert.match(a.why, /catching up/);
  // Real progress, from real heights.
  assert.deepEqual(a.progress, { done: 120, total: 1010, label: 'block 120 of 1,010' });
});

test('an armed start can be cancelled, and says what it is waiting for', () => {
  const s = ready({
    mining: { on: false, mode: 'standard', standardAvailable: true, workers: 0, armed: true },
    gate: { allow: false, message: 'Waiting for a peer.', networkHeight: 1010 },
    node: { running: true, height: 900 }
  });
  const a = nextAction(s);
  assert.equal(a.id, 'disarm');
  assert.match(a.why, /by itself/);
});

test('the override is offered as an alternative, never as the only way on', () => {
  const s = ready({
    gate: { allow: false, message: 'Still catching up.', offerOverride: true, networkHeight: 1010 },
    node: { running: true, height: 900 }
  });
  const a = nextAction(s);
  assert.equal(a.id, 'arm');
  assert.ok(a.alternative, 'a second, enabled way forward');
  assert.equal(a.alternative.id, 'override');
  assert.ok(a.alternative.why.length > 10);
});

test('a missing multi-core miner switches the offer to the engine that exists', () => {
  const a = nextAction(ready({ mining: { on: false, mode: 'standard', standardAvailable: false, workers: 0, armed: false } }));
  assert.equal(a.id, 'fix-binary');
});

test('progress is only claimed when both heights are real', () => {
  assert.equal(syncProgress({ height: null }, {}), null);
  assert.deepEqual(syncProgress({ height: 7 }, {}), { done: 7, total: null, label: 'block 7 so far' });
  // Ahead of the reported network height: never a percentage above 100.
  const p = syncProgress({ height: 1200 }, { networkHeight: 1000 });
  assert.equal(p.total, 1200);
});

test('a snapshot missing whole sections does not throw', () => {
  for (const s of [undefined, null, {}, { mining: {} }, { node: {}, gate: {} }]) {
    const a = nextAction(s);
    assert.ok(ACTIONS.includes(a.id));
  }
});

test('an address the node has refused is replaced, not mined with', () => {
  const s = ready({ payout: { address: 'tmEXAMPLEEXAMPLEEXAMPLEEXAMPLEEXAMP', rejected: true } });
  const a = nextAction(s);
  assert.equal(a.id, 'set-address');
  assert.match(a.label, /Replace/);
  assert.match(a.why, /does not recognise/);
});

test('an address merely unconfirmed is NOT treated as refused', () => {
  // The node could not be asked. That is not a verdict, and it must not stop
  // anybody mining: this is the case that produced a false accusation once.
  const s = ready({ payout: { address: 'tmEXAMPLEEXAMPLEEXAMPLEEXAMPLEEXAMP', confirmed: false, rejected: false } });
  assert.equal(nextAction(s).id, 'start');
});
