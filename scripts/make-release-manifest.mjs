// What went into this build, written beside the files it describes.
//
//   node scripts/make-release-manifest.mjs <out dir> <platform key>
//
// The Windows workflow builds this inline in PowerShell. Linux and macOS use
// this instead of three more copies of the same thing in YAML, where a quoting
// mistake is invisible until the run has already spent ten minutes packaging.
//
// Everything here is read from a file: the version from package.json, the
// network from the embedded manifest, the binary pins from binaries.json, the
// sizes and hashes from the files themselves. Nothing is passed in that could
// disagree with what shipped.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const requireGitCommit = () => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
const outDir = process.argv[2] || 'out';
const platformKey = process.argv[3] || `${process.platform}-${process.arch}`;
const signed = process.argv.includes('--signed');
const notaryIdIndex = process.argv.indexOf('--notary-submission');
const notarySubmission = notaryIdIndex >= 0 ? process.argv[notaryIdIndex + 1] : null;
if (signed && (!platformKey.startsWith('darwin') || !/^[a-f0-9-]{36}$/i.test(notarySubmission || ''))) {
  throw new Error('Signed macOS manifests require --notary-submission <UUID>');
}

const read = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));
const pkg = read('package.json');
const bins = read('electron/net/binaries.json');

// WHICH network does this build describe?
//
// This read electron/net/network.json unconditionally, so a build made with
// network_profile=swarm-mainnet still recorded the TESTNET identity - name
// SwarmTestnet, genesis 045993f5..., seed.swarm.green:18233 - in the one file
// the owner reads to know what they are about to install. The profile decides,
// and because a build ships every definition it carries and the user chooses
// inside the app, all of them are listed beside it.
const profileId = process.env.SWARM_NETWORK_PROFILE || 'swarm-testnet';
const fileForProfile = (id) =>
  `electron/net/${id === 'swarm-testnet' ? 'network.json' : `network-${id.replace(/^swarm-/, '')}.json`}`;
const describe = (m) => ({
  name: m.identity.network_name,
  magic: m.identity.network_magic,
  genesis: m.genesis.hash,
  p2p: m.ports.public_p2p,
  seeds: m.seed_peers,
  ticker: m.identity.ticker
});
const net = read(fileForProfile(profileId));
const embedded = {};
for (const id of ['swarm-testnet', 'swarm-mainnet']) {
  if (fs.existsSync(path.join(ROOT, fileForProfile(id)))) embedded[id] = describe(read(fileForProfile(id)));
}

const files = fs.readdirSync(outDir)
  .filter((f) => f !== 'release-manifest.json' && fs.statSync(path.join(outDir, f)).isFile())
  .sort()
  .map((name) => {
    const buf = fs.readFileSync(path.join(outDir, name));
    return { name, bytes: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex') };
  });

if (!files.length) {
  console.error(`nothing to describe: ${outDir} is empty`);
  process.exit(1);
}

const isMac = platformKey.startsWith('darwin');
const manifest = {
  product: 'SWARM Node',
  version: pkg.version,
  platform: platformKey,
  built_at_utc: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
  git_commit: signed ? requireGitCommit() : (process.env.GITHUB_SHA || requireGitCommit()),
  git_ref: process.env.GITHUB_REF || null,
  workflow_run: process.env.GITHUB_RUN_ID
    ? `https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
    : null,
  runner_image: process.env.ImageOS || process.env.RUNNER_OS || null,
  signed,
  notarized: signed,
  notary_submission_id: notarySubmission,
  signing_note: signed
    ? 'Developer ID Application signed; app and DMG notarized and stapled. Verify Gatekeeper after a fresh browser download.'
    : 'Unsigned development build; not for browser-download distribution.',
  auto_update: false,
  app_id: 'green.swarm.node',
  network_profile: profileId,
  network: describe(net),
  embedded_networks: embedded,
  bundled_binaries: bins,
  files
};

const dest = path.join(outDir, 'release-manifest.json');
fs.writeFileSync(dest, JSON.stringify(manifest, null, 2) + '\n');
console.log(`wrote ${dest} for ${platformKey}`);
for (const f of files) console.log(`  ${f.name}  ${f.bytes} bytes  ${f.sha256}`);
