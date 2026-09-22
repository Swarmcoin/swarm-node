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
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = process.argv[2] || 'out';
const platformKey = process.argv[3] || `${process.platform}-${process.arch}`;

const read = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));
const pkg = read('package.json');
const net = read('electron/net/network.json');
const bins = read('electron/net/binaries.json');

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
  git_commit: process.env.GITHUB_SHA || null,
  git_ref: process.env.GITHUB_REF || null,
  workflow_run: process.env.GITHUB_RUN_ID
    ? `https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
    : null,
  runner_image: process.env.ImageOS || process.env.RUNNER_OS || null,
  signed: false,
  signing_note: isMac
    ? 'Unsigned and un-notarised. macOS refuses the first launch: right-click (or Control-click) the app and choose Open, '
      + 'or run  xattr -dr com.apple.quarantine "/Applications/SWARM Node.app"  once. See RELEASE-NOTES.md.'
    : 'Unsigned. Make the AppImage executable before running it:  chmod +x SWARM-Node-*.AppImage  . See RELEASE-NOTES.md.',
  auto_update: false,
  app_id: 'green.swarm.node',
  network: {
    name: net.identity.network_name,
    magic: net.identity.network_magic,
    genesis: net.genesis.hash,
    p2p: net.ports.public_p2p,
    seeds: net.seed_peers,
    ticker: net.identity.ticker
  },
  bundled_binaries: bins,
  files
};

const dest = path.join(outDir, 'release-manifest.json');
fs.writeFileSync(dest, JSON.stringify(manifest, null, 2) + '\n');
console.log(`wrote ${dest} for ${platformKey}`);
for (const f of files) console.log(`  ${f.name}  ${f.bytes} bytes  ${f.sha256}`);
