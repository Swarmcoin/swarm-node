// Persisted settings.
//
// What is stored: the consent flag, the payout ADDRESS (a public identifier),
// the machine's own preferences, and — since the owner asked for a lock — the
// record for the wallet code: a random salt and a scrypt-derived key, never the
// code itself, and encrypted with the operating system's own store where this
// machine has one. What is still never stored, because it never exists in this
// app: a key, a seed phrase, an account, an email address or a password.

'use strict';

const fs = require('fs');
const path = require('path');

function defaults(manifest) {
  const ports = (manifest && manifest.ports) || {};
  const gate = (manifest && manifest.sync_gate) || {};
  return {
    schema: 1,
    consented: false,
    consentedAt: null,
    payoutAddress: '',
    payoutKind: null,
    payoutDetail: '',
    miningMode: 'standard',
    intensity: 0,                  // 0 = "choose for me" -> half the usable cores
    idleOnly: false,
    autoResume: true,
    firstNodeOverride: false,
    // Which SWARM network this install runs. One of the ids in
    // electron/chain/network-profile.js; never a free-form string, and never
    // upstream Zcash. A profile whose definition is not bundled with the build
    // cannot be selected, so this falls back on load.
    networkProfile: 'swarm-testnet',
    dataDir: null,                 // set on first run to the default chain folder
    // The mainnet chain folder, kept apart from the testnet one: two chains
    // cannot share a state database.
    dataDirMainnet: null,
    p2pPort: Number(ports.p2p) || 18233,
    rpcPort: Number(ports.rpc) || 18232,
    p2pListen: null,
    seedPeers: null,               // null = use the manifest's list
    nodeThreads: 2,
    zebraHealthGate: true,
    maxTipAgeSeconds: Number(gate.max_tip_age_seconds) || 900,
    stopTimeoutMs: 20000,
    reducedMotion: false,
    setupStep: 'welcome',

    // The record for the wallet code: a salt and a derived key, or an encrypted
    // blob holding them. null means no code is set, which is the state every
    // install starts in.
    lockCode: null,

    // The operator's own city, if they chose one on the Swarm map. City level
    // only, kept on this machine, drawn on this machine's map and sent nowhere:
    // see electron/map-city.js for the two things that are deliberately kept
    // apart (this, and the published file the map actually shows).
    mapCity: null,

    // Did this person ever FINISH the first-run wizard on this machine?
    //
    // The owner installed 0.2.0-testnet.2 and never saw the wizard. The old
    // rule inferred "setup is done" from two settings being present at all:
    // a consent flag and a payout address. Anything that left those behind -
    // an earlier build, a copied profile, a half-finished run - silently sent
    // the user straight to a dashboard they had never been introduced to.
    //
    // Presence of data is not evidence of a finished introduction. Only
    // reaching the end of the wizard sets this, and only this suppresses it.
    setupCompletedVersion: null,   // the app version that finished it
    setupCompletedAt: null,        // ISO timestamp, for support questions
    tourSeenVersion: null          // the guided tour, tracked the same way
  };
}

class SettingsStore {
  constructor(file, manifest) {
    this.file = file;
    this.manifest = manifest;
    this.data = this.load();
  }

  load() {
    const base = defaults(this.manifest);
    let parsed = {};
    try { parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { /* first run */ }
    if (!parsed || typeof parsed !== 'object') parsed = {};
    // Only known keys survive, so a hand-edited file cannot inject anything.
    const out = { ...base };
    for (const k of Object.keys(base)) if (parsed[k] !== undefined) out[k] = parsed[k];
    return out;
  }

  save(next) {
    // IN PLACE, deliberately. The engine is handed this.data at construction
    // and keeps that reference for its whole life. Replacing the object here
    // used to leave the engine holding a stale copy, so the next thing the
    // engine saved wrote its old values back over everything saved by any
    // other path in between - the consent flag, and worse, the setup
    // completion marker, which would have sent the user back through the
    // wizard on every launch. One object, one source of truth.
    if (next && next !== this.data) Object.assign(this.data, next);
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, Buffer.from(JSON.stringify(this.data, null, 2), 'utf8'));
      fs.renameSync(tmp, this.file);
    } catch (e) {
      // Never fatal: the app must stay usable on a read-only profile.
      console.error('[settings] save failed:', e.message);
    }
    return this.data;
  }
}

module.exports = { SettingsStore, defaults };
