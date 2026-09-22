// Stray data must never stand in for a finished introduction.
//
// 0.2.0-testnet.2 decided "setup is done" by looking for a consent flag and a
// payout address. The owner's profile had both, from an earlier run, so the
// app opened on a dashboard he had never been walked through. These tests pin
// the replacement: only an explicit completion marker counts, and it is
// written by the main process, not by the page.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { SettingsStore, defaults } = require('../electron/config-store');

/** The one rule the renderer applies. Kept here so it is pinned by a test. */
const opensOnDashboard = (cfg) => !!cfg.setupCompletedVersion;

function tmpStore(seed) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-node-settings-'));
  const file = path.join(dir, 'settings.json');
  if (seed) fs.writeFileSync(file, JSON.stringify(seed, null, 2));
  return { store: new SettingsStore(file, {}), file, dir };
}

test('a fresh profile has no completion marker', () => {
  const d = defaults({});
  assert.equal(d.setupCompletedVersion, null);
  assert.equal(d.setupCompletedAt, null);
  assert.equal(opensOnDashboard(d), false);
});

test('stray consent and a stray address do NOT skip the wizard', () => {
  // Exactly the profile the owner had.
  const { store, dir } = tmpStore({
    consented: true,
    consentedAt: '2026-09-21T10:00:00.000Z',
    payoutAddress: 'tmEXAMPLEEXAMPLEEXAMPLEEXAMPLEEXAMP',
    payoutKind: 'transparent',
    setupStep: 'dashboard'
  });
  assert.equal(store.data.consented, true, 'the stray data is still loaded');
  assert.equal(store.data.payoutAddress, 'tmEXAMPLEEXAMPLEEXAMPLEEXAMPLEEXAMP');
  assert.equal(store.data.setupCompletedVersion, null, 'but it is not a completion marker');
  assert.equal(opensOnDashboard(store.data), false, 'so the wizard runs');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('finishing the wizard records the version, and is what skips it next time', () => {
  const { store, file, dir } = tmpStore(null);
  assert.equal(opensOnDashboard(store.data), false);

  store.save({ setupCompletedVersion: '0.2.0-testnet.3', setupCompletedAt: new Date().toISOString() });
  assert.equal(opensOnDashboard(store.data), true);

  // It survives a restart, which is the whole point of writing it down.
  const again = new SettingsStore(file, {});
  assert.equal(again.data.setupCompletedVersion, '0.2.0-testnet.3');
  assert.equal(opensOnDashboard(again.data), true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a hand-edited file cannot introduce keys the app does not know', () => {
  const { store, dir } = tmpStore({
    setupCompletedVersion: '9.9.9',
    __proto__hack: true,
    somethingInvented: 'x'
  });
  assert.equal(store.data.setupCompletedVersion, '9.9.9');
  assert.ok(!('somethingInvented' in store.data));
  assert.ok(!Object.prototype.hasOwnProperty.call(store.data, '__proto__hack'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the tour is tracked the same way and starts unseen', () => {
  assert.equal(defaults({}).tourSeenVersion, null);
});
