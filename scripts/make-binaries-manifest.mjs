// Record the SHA-256 of every bundled binary into electron/net/binaries.json.
//
// The app refuses to run a binary whose hash does not match this file, so the
// file is written from the binaries that are actually about to be packaged,
// by CI, right after CI has verified them against the hashes published by the
// build that produced them.
//
//   node scripts/make-binaries-manifest.mjs [--bin-dir resources/bin]
//
// The file is keyed BY PLATFORM. SWARM Node ships for Windows, Linux and
// macOS, and the same program has a different hash on each, so one flat set of
// hashes would mean two of the three builds refused to run their own binaries.
// A run writes its own platform's entry and leaves the others alone, so the
// committed file accumulates all three and an auditor can see the lot.
//
// Provenance lives HERE rather than in the JSON, because CI regenerates the
// JSON on every build and would otherwise overwrite it. An earlier note
// claimed both programs were "official Zebra 6.3.0 with no source changes",
// which is true of the node and not of the miner. Prose version, with the full
// file lists: electron/net/PROVENANCE.md

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const argIdx = process.argv.indexOf('--bin-dir');
const binDir = argIdx > 0 ? process.argv[argIdx + 1] : path.join(ROOT, 'resources', 'bin');

const exe = process.platform === 'win32' ? '.exe' : '';

/** Where each program comes from. Checked against the published build
 *  manifests and `gh api .../compare/...`, not from memory. */
const PROVENANCE = {
  zebrad: {
    role: 'the full node',
    repository: 'Swarm-Official/privacy-zebra',
    branch: 'swarm-ci',
    commit: '95ccc1564b200d26609b203800f51509fbeec467',
    upstream_base: 'tag v6.3.0, the official Zcash Foundation release',
    changes_vs_upstream:
      'one file added: .github/workflows/swarm-binaries.yml (CI only), plus one ' +
      'non-consensus change to zebrad/src/components/miner.rs: the mining component ' +
      'counts how often the solver asks for its next nonce and logs the rate it ' +
      'measured ("internal miner rate: N sol/s") every ten seconds, because the node ' +
      'reported no rate anywhere. No consensus, cryptographic, state or RPC code, no ' +
      'Cargo.toml, no Cargo.lock.',
    build: 'cargo build --locked --release --package zebrad --bin zebrad --features internal-miner',
    workflow_run: 'https://github.com/Swarm-Official/privacy-zebra/actions/runs/35800107349',
    built_at_utc: '2026-09-23T00:08:50Z'
  },
  miner: {
    role: 'the standard (multi-core) mining engine',
    repository: 'Swarm-Official/privacy-zebra',
    branch: 'swarm-tools (macOS: swarm-tools-macos, same sources)',
    commit: '7f82a03beceaf115ffcdf55ae30ae34c7abb4261',
    upstream_base:
      '7c64a8419388dd72664a19a70aed66e84f3e2d5b, a later upstream Zebra development ' +
      'commit 333 commits ahead of v6.3.0 - NOT the v6.3.0 release',
    changes_vs_upstream:
      'five commits, eight files, all additions except Cargo.toml and Cargo.lock: ' +
      'zebrad/src/bin/privacy-miner.rs, zebrad/src/bin/swarm-keytool.rs (not bundled), ' +
      'two docs, and .github/workflows/swarm-tools.yml. The latest commit makes ' +
      'privacy-miner print the rate its own solver measured ("Mining rate N sol/s") ' +
      'every ten seconds. No source file other than privacy-miner.rs is modified. ' +
      'The macOS branch adds only the two Apple targets to that workflow.',
    build:
      'cargo build --locked --release --package zebrad --bin privacy-miner --bin swarm-keytool ' +
      '--features internal-miner',
    workflow_run: 'https://github.com/Swarm-Official/privacy-zebra/actions/runs/35800186092',
    built_at_utc: '2026-09-23T00:09:20Z'
  }
};

// The shipped names. The upstream names are accepted as a fallback so a
// developer checkout with raw binaries still works; whichever file is found,
// the pin is recorded under the name that actually ships.
const WANT = {
  zebrad: { file: `swarm-node-daemon${exe}`, legacy: `zebrad${exe}`, required: true },
  miner: { file: `swarm-miner${exe}`, legacy: `privacy-miner${exe}`, required: false }
};

// Things that must never be shipped inside the app, whatever ends up in the
// staging folder. The key tool can create spending keys; a user-facing miner
// has no business carrying it.
const FORBIDDEN = [/keytool/i, /\.keys\.json$/i, /^cookie$/i, /\.env/i];

/** win32-x64, linux-x64, darwin-arm64 … */
export const platformKey = () => `${process.platform}-${process.arch}`;

const dest = path.join(ROOT, 'electron', 'net', 'binaries.json');

let existing = {};
try { existing = JSON.parse(fs.readFileSync(dest, 'utf8')); } catch { /* first run */ }
if (!existing || typeof existing !== 'object') existing = {};

const out = {
  _comment:
    'SHA-256 of the binaries each platform is allowed to run, and where each came from. ' +
    'Written by scripts/make-binaries-manifest.mjs. The node and the miner come from ' +
    'DIFFERENT upstream trees; see PROVENANCE.md beside this file.',
  _note:
    'The node is v6.3.0; the miner is built from a tree 333 commits later. The miner is an ' +
    'RPC client: the node validates every block it accepts, so the node decides. ' +
    'Recorded, not smoothed over.',
  generated_at: new Date().toISOString(),
  platforms: { ...(existing.platforms || {}) }
};

const key = platformKey();
const mine = {};
let missingRequired = false;

const present = fs.existsSync(binDir) ? fs.readdirSync(binDir) : [];
for (const f of present) {
  if (FORBIDDEN.some((re) => re.test(f))) {
    console.error(`REFUSING TO PACKAGE: ${f} must not be bundled with SWARM Node`);
    process.exit(1);
  }
}

for (const [name, spec] of Object.entries(WANT)) {
  let p = path.join(binDir, spec.file);
  if (!fs.existsSync(p) && spec.legacy) {
    const legacy = path.join(binDir, spec.legacy);
    if (fs.existsSync(legacy)) {
      fs.renameSync(legacy, p);
      console.log(`renamed ${spec.legacy} -> ${spec.file} (what the user sees in a process list)`);
    }
  }
  if (!fs.existsSync(p)) {
    if (spec.required) { console.error(`missing required binary ${spec.file} in ${binDir}`); missingRequired = true; }
    else console.log(`note: ${spec.file} is not bundled; that engine will be unavailable on ${key}`);
    continue;
  }
  const buf = fs.readFileSync(p);
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  mine[name] = { file: spec.file, sha256, bytes: buf.length, ...PROVENANCE[name] };
  console.log(`${name.padEnd(7)} ${spec.file.padEnd(20)} ${sha256}  ${buf.length} bytes`);
  console.log(`        ${PROVENANCE[name].branch} @ ${PROVENANCE[name].commit.slice(0, 12)}`);
}

if (missingRequired) process.exit(1);

out.platforms[key] = mine;
fs.writeFileSync(dest, JSON.stringify(out, null, 2) + '\n');
console.log(`wrote ${path.relative(ROOT, dest)} for ${key} (file now covers: ${Object.keys(out.platforms).join(', ')})`);
