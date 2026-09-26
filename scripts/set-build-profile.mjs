// Record which SWARM network this build is for, INSIDE the build.
//
//   SWARM_NETWORK_PROFILE=swarm-mainnet node scripts/set-build-profile.mjs
//   node scripts/set-build-profile.mjs swarm-mainnet
//
// WHY THIS EXISTS. A build carries every network definition it has, and the
// user picks one in the app. Which network the build was MADE for was recorded
// only in release-manifest.json, a file that sits beside the installer and
// never travels inside it. So the packaged app had no idea, fell back to the
// hard-coded swarm-testnet default, and 0.2.0-mainnet.1 installed over an
// earlier testnet install came up on the testnet — header "SwarmTestnet ·
// engineering testnet" — with no control anywhere to change it.
//
// The value is validated against the closed list in
// electron/chain/network-profile.js, so this can never write a network the app
// does not know, and it can never write upstream Zcash.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const NP = createRequire(import.meta.url)('../electron/chain/network-profile.js');

const wanted = process.argv[2] || process.env.SWARM_NETWORK_PROFILE || NP.DEFAULT_PROFILE_ID;
// Throws, naming what is on offer, if this is not one of the two SWARM networks.
const profile = NP.requireProfile(wanted);

const dest = path.join(ROOT, 'electron', 'net', 'build-profile.json');
const existing = JSON.parse(fs.readFileSync(dest, 'utf8'));
const out = { ...existing, profile: profile.id };
fs.writeFileSync(dest, JSON.stringify(out, null, 2) + '\n');
console.log(`build profile: ${profile.id} (${profile.label}) -> ${path.relative(ROOT, dest)}`);
