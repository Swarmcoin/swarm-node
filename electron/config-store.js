// Persisted settings.
//
// What is stored: the consent flag, the payout ADDRESS (a public identifier),
// and the machine's own preferences. What is never stored, because it never
// exists in this app: a key, a seed phrase, a password, an email address, or
// any account of any kind.

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
    dataDir: null,                 // set on first run to the default chain folder
    p2pPort: Number(ports.p2p) || 18233,
    rpcPort: Number(ports.rpc) || 18232,
    p2pListen: null,
    seedPeers: null,               // null = use the manifest's list
    nodeThreads: 2,
    zebraHealthGate: true,
    maxTipAgeSeconds: Number(gate.max_tip_age_seconds) || 900,
    stopTimeoutMs: 20000,
    reducedMotion: false,
    setupStep: 'welcome'
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
    if (next) this.data = { ...this.data, ...next };
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
