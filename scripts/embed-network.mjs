// Rebuild the embedded network definition from the canonical manifest.
//
//   node scripts/embed-network.mjs <path to network/swarm-testnet>
//
// The result, electron/net/network.json, is the canonical manifest verbatim
// plus three things the desktop app needs and the chain definition does not:
//   * genesis.hex       — the genesis block bytes, so the very first node of a
//                         network can hand them to its own node;
//   * sync_gate         — when this app is allowed to mine;
//   * links             — the only https addresses the app may open.
// Nothing else is added and nothing is rewritten, so `diff` against the
// canonical file shows exactly what this build carries.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = process.argv[2] || 'D:/privacy/network/swarm-testnet';

const manifestPath = path.join(src, 'manifest.json');
const genesisPath = path.join(src, 'genesis.hex');

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const genesisHex = fs.readFileSync(genesisPath, 'utf8').trim();

if (!/^[0-9a-f]+$/.test(genesisHex)) throw new Error('genesis.hex is not lower-case hex');
const hexSha = crypto.createHash('sha256').update(fs.readFileSync(genesisPath)).digest('hex');
if (manifest.genesis.hex_file_sha256 && manifest.genesis.hex_file_sha256 !== hexSha) {
  throw new Error(`genesis.hex sha256 ${hexSha} does not match the manifest's ${manifest.genesis.hex_file_sha256}`);
}
if (!/^[0-9a-f]{64}$/.test(manifest.genesis.hash || '')) throw new Error('manifest has no genesis hash');
if (manifest.identity.network_kind !== 'Testnet') throw new Error('this app only runs testnets');
for (const r of manifest.economics.recipients) {
  if (!/^t2[1-9A-HJ-NP-Za-km-z]{20,}$/.test(r.address || '')) {
    throw new Error(`recipient ${r.label} has no P2SH address`);
  }
}

const out = {
  ...manifest,
  _embedded_by: 'scripts/embed-network.mjs — SWARM Node',
  _embedded_from: manifestPath.replace(/\\/g, '/'),
  _embedded_at: new Date().toISOString().slice(0, 10),
  genesis: {
    ...manifest.genesis,
    hex: genesisHex,
    hex_sha256: hexSha,
    hex_note:
      'The genesis block bytes. A fresh node normally receives block 0 from a peer; ' +
      'Zebra only inserts genesis by itself on Regtest. When no peer has served it, ' +
      'SWARM Node hands these bytes to its own node once and checks the resulting hash.'
  },
  sync_gate: {
    min_peers: 1,
    max_behind_blocks: 2,
    quiet_seconds: 45,
    patience_seconds: 600,
    max_tip_age_seconds: 7200,
    // The independent view of the tip. A different machine running different
    // code on the same chain, which is the only honest way to answer "am I
    // behind" — see electron/chain/tip-oracle.js and defect N-1.
    tip_oracle_url: 'https://lwd.swarm.green:443',
    note:
      'Tip age is a weak hint only. Block spacing averages 60-90 s but is a Poisson process, ' +
      'so multi-minute gaps are ordinary and a rule that needs a young tip holds back a synced node.'
  },
  // The project's OFFICIAL CHANNELS, set by the owner on 2026-09-21 and
  // recorded in D:/privacy/README.md. These are the only https addresses the
  // app will open, and the main process enforces that as an allow-list. No
  // other account speaks for the project: no Discord, no Telegram, nothing
  // else invented here.
  links: {
    website: 'https://swarm.green',
    explorer: 'https://explore.swarm.green',
    swarm_map: 'https://swarm.green/#map',
    x: 'https://x.com/swarm_coin',
    source: 'https://github.com/brs-holding'
  },
  contact_email: 'swarmofficial@atomicmail.io',
  channels_note:
    'Set by the owner on 2026-09-21. No other account or address speaks for the project. ' +
    'The project never asks for recovery phrases, private keys or payments through any channel.'
};

const dest = path.join(ROOT, 'electron', 'net', 'network.json');
fs.writeFileSync(dest, Buffer.from(JSON.stringify(out, null, 2) + '\n', 'utf8'));
console.log(`wrote ${path.relative(ROOT, dest)}`);
console.log(`  network      ${out.identity.network_name} (magic ${out.identity.network_magic.join(',')})`);
console.log(`  genesis      ${out.genesis.hash}`);
console.log(`  genesis.hex  ${genesisHex.length / 2} bytes, sha256 ${hexSha}`);
console.log(`  p2p/rpc      ${out.ports.public_p2p} / ${out.ports.rpc}`);
console.log(`  seeds        ${out.seed_peers.join(', ')}`);
