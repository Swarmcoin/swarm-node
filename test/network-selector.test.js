// The Network selector, and Sign out — two controls the owner could not use.
//
// WHY A SOURCE-LEVEL TEST. The mainnet defect was not a wrong value anywhere;
// every value was right. `shell:setNetworkProfile` worked, was exposed on the
// preload bridge, refused an unavailable profile with a sentence — and no
// screen in the renderer ever called it, so from inside the app the network
// could not be changed at all. A unit test of the handler passes happily while
// the feature does not exist. What has to be held still is the WIRING: the
// control exists, it is reachable from the Settings page, and the bridge
// function it needs is exposed.
//
// Sign out is the same shape of defect from the other end: the handler stopped
// the node and relaunched the app correctly, and with no code set the new
// process opened straight back on the dashboard, so it looked like nothing
// happened. What is held still here is the marker that puts the app back on
// the outside screen.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', 'src');
const read = (f) => fs.readFileSync(path.join(SRC, f), 'utf8');

const dashboard = read('dashboard.jsx');
const app = read('App.jsx');
const ui = read('ui.jsx');
const setup = read('setup.jsx');
const preload = fs.readFileSync(path.join(__dirname, '..', 'electron', 'preload.js'), 'utf8');

// ------------------------------------------------------------- the selector

test('Settings has a Network control, and it is a real control', () => {
  assert.match(dashboard, /function NetworkCard\(/, 'the Network card must exist');
  assert.match(dashboard, /<NetworkCard s=\{s\} cfg=\{cfg\} \/>/, 'Settings must render it');
  // A <select> labelled Network, not a table of words.
  const card = dashboard.slice(dashboard.indexOf('function NetworkCard('), dashboard.indexOf('export function SettingsView'));
  assert.match(card, /<span>Network<\/span>/, 'the field must be labelled "Network"');
  assert.match(card, /<select/, 'the networks must be selectable, not printed');
  assert.match(card, /menuLabel/, 'the options must read "SWARM Mainnet" / "SWARM Testnet"');
  assert.match(card, /disabled=\{!p\.selectable\}/, 'an unavailable network must be greyed, not hidden');
  assert.match(card, /cannot be chosen in this build: \{p\.reason\}/, 'and it must say why');
});

test('choosing a network switches the profile and restarts the app', () => {
  const card = dashboard.slice(dashboard.indexOf('function NetworkCard('), dashboard.indexOf('export function SettingsView'));
  assert.match(card, /window\.shell\.setNetworkProfile\(/, 'nothing called this before; that was the defect');
  assert.match(card, /window\.shell\.restartApp\(\)/, 'the node runs one profile per process, so it must restart');
  assert.match(preload, /setNetworkProfile:/);
  assert.match(preload, /restartApp:/);
});

test('the active network is on the header, the Mining screen and the Node screen', () => {
  // Header: the chain label, always.
  assert.match(app, /state\.network\.chainLabel/, 'the header must name the running chain');
  // Mining: "network: <chain label>", and the genesis beside it.
  assert.match(dashboard, /network: <b className="mono">\{s\.network\.chainLabel\}<\/b>/);
  assert.match(dashboard, /genesis: <b className="mono"[^>]*>\{s\.network\.genesisShort/);
  // Node screen.
  const node = dashboard.slice(dashboard.indexOf('export function NodeView'), dashboard.indexOf('export function RewardsView'));
  assert.match(node, /s\.network\.profileLabel/);
  assert.match(node, /s\.network\.genesisShort/);
});

test('no screen calls the production network an engineering testnet', () => {
  // The strip was hard-coded. On SWARM mainnet it told the owner that real
  // coins have no value, which is false and was also the consent wording.
  assert.ok(!/engineering testnet/.test(app), 'App.jsx must not hard-code the testnet banner');
  assert.match(ui, /export function NetworkStrip/);
  const strip = ui.slice(ui.indexOf('export function NetworkStrip'), ui.indexOf('export function Notice'));
  assert.match(strip, /network\.production === true/, 'the profile decides what the strip says');
  assert.match(strip, /engineering testnet/, 'and the testnet keeps its warning');
  // The wizard too: it is the first thing a new owner reads.
  assert.match(setup, /const production = \(chain\)/);
  assert.match(setup, /production:\s*\n?\s*'This is the SWARM production chain/);
});

test('"this testnet build has no update feed" no longer claims a network', () => {
  assert.ok(!/this testnet build has no update feed/.test(dashboard));
  assert.match(dashboard, /off — this build has no update feed/);
});

// -------------------------------------------------------------- signing out

test('signing out comes back on the outside screen, not the dashboard', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8');
  const handler = main.slice(main.indexOf("handle('session:signOut'"), main.indexOf("handle('session:signOut'") + 1600);
  assert.match(handler, /settings\.save\(\{ signedOut: true \}\)/, 'the marker is what makes it visible');
  assert.match(handler, /relaunchApp\(\)/, 'and everything this app started is stopped first');
  // relaunchApp is the shared stop-everything-then-start-again path.
  const relaunch = main.slice(main.indexOf('async function relaunchApp'), main.indexOf('async function shutdown'));
  assert.match(relaunch, /await shutdown\(\)/);
  assert.match(relaunch, /app\.relaunch/);
  assert.match(relaunch, /app\.exit\(0\)/);
  // The renderer shows that screen when no code is set; with a code set the
  // lock screen already was the outside screen.
  assert.match(app, /cfg\.signedOut && !\(lockStatus && lockStatus\.hasCode\)/);
  assert.match(app, /Signed out/);
  assert.match(app, /window\.shell\.clearSignedOut\(\)/);
  assert.match(preload, /clearSignedOut:/);
});

test('the signed-out marker is a known setting, so it survives a save', () => {
  const { defaults } = require('../electron/config-store');
  const d = defaults({});
  assert.strictEqual(d.signedOut, false);
  assert.strictEqual(d.networkProfileChosenForBuild, null);
  assert.strictEqual(d.payoutClearedReason, null);
});
