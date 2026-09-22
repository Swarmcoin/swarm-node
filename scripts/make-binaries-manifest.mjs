// Record the SHA-256 of every bundled binary into electron/net/binaries.json.
//
// The app refuses to run a binary whose hash does not match this file, so the
// file is written from the binaries that are actually about to be packaged,
// by CI, right after CI has verified them against the hashes published by the
// build that produced them.
//
//   node scripts/make-binaries-manifest.mjs [--bin-dir resources/bin]

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const argIdx = process.argv.indexOf('--bin-dir');
const binDir = argIdx > 0 ? process.argv[argIdx + 1] : path.join(ROOT, 'resources', 'bin');

// Where each program comes from, checked against the published build manifests
// and `gh api .../compare/...` on 2026-09-22. CI regenerates binaries.json on
// every build, so this has to live HERE or it would be overwritten — an
// earlier note claimed both files were "official Zebra 6.3.0 with no source
// changes", which is true of the node and not of the miner.
//
// Prose version, with the full file lists: electron/net/PROVENANCE.md
const WANT = {
  zebrad: {
    file: 'zebrad.exe',
    required: true,
    role: 'the full node',
    repository: 'brs-holding/privacy-zebra',
    branch: 'swarm-ci',
    commit: 'cb99dd063feaac493f93fdfca3e7d7acad685573',
    upstream_base: 'tag v6.3.0, the official Zcash Foundation release',
    changes_vs_upstream:
      'one file added: .github/workflows/swarm-binaries.yml (CI only). ' +
      'No Rust source, no Cargo.toml, no Cargo.lock.',
    build: 'cargo build --locked --release --package zebrad --bin zebrad --features internal-miner',
    workflow_run: 'https://github.com/brs-holding/privacy-zebra/actions/runs/35603263833',
    built_at_utc: '2026-09-21T13:26:17Z'
  },
  miner: {
    file: 'privacy-miner.exe',
    required: false,
    role: 'the standard (multi-core) mining engine',
    repository: 'brs-holding/privacy-zebra',
    branch: 'swarm-tools',
    commit: '103184e96b7f5fc5ae3fdeaec6a97a10612d2f0b',
    upstream_base:
      '7c64a8419388dd72664a19a70aed66e84f3e2d5b, a later upstream Zebra development ' +
      'commit 333 commits ahead of v6.3.0 - NOT the v6.3.0 release',
    changes_vs_upstream:
      'four commits, seven files, all additions except Cargo.toml and Cargo.lock: ' +
      'zebrad/src/bin/privacy-miner.rs, zebrad/src/bin/swarm-keytool.rs (not bundled), ' +
      'two docs, and .github/workflows/swarm-tools.yml. No existing source file is modified.',
    build:
      'cargo build --locked --release --package zebrad --bin privacy-miner --bin swarm-keytool ' +
      '--features internal-miner',
    workflow_run: 'https://github.com/brs-holding/privacy-zebra/actions/runs/35626325459',
    built_at_utc: '2026-09-21T16:40:14Z'
  }
};

// Things that must never be shipped inside the app, whatever ends up in the
// staging folder. The key tool can create spending keys; a user-facing miner
// has no business carrying it.
const FORBIDDEN = [/keytool/i, /\.keys\.json$/i, /^cookie$/i, /\.env/i];

const out = {
  _comment:
    'SHA-256 of the binaries this build is allowed to run, and where each came from. ' +
    'Written by scripts/make-binaries-manifest.mjs. The two come from DIFFERENT upstream ' +
    'trees; see PROVENANCE.md beside this file.',
  generated_at: new Date().toISOString(),
  platform: process.platform
};

let missingRequired = false;
const present = fs.existsSync(binDir) ? fs.readdirSync(binDir) : [];

for (const f of present) {
  if (FORBIDDEN.some((re) => re.test(f))) {
    console.error(`REFUSING TO PACKAGE: ${f} must not be bundled with SWARM Node`);
    process.exit(1);
  }
}

for (const [key, spec] of Object.entries(WANT)) {
  const p = path.join(binDir, spec.file);
  if (!fs.existsSync(p)) {
    if (spec.required) { console.error(`missing required binary ${spec.file} in ${binDir}`); missingRequired = true; }
    else console.log(`note: ${spec.file} is not bundled; that engine will be unavailable in this build`);
    continue;
  }
  const buf = fs.readFileSync(p);
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  const { required, ...provenance } = spec;
  out[key] = { ...provenance, sha256, bytes: buf.length };
  console.log(`${key.padEnd(7)} ${spec.file.padEnd(20)} ${sha256}  ${buf.length} bytes`);
  console.log(`        ${provenance.branch} @ ${provenance.commit.slice(0, 12)} on ${provenance.upstream_base.split(',')[0]}`);
}

out._note =
  'The node is v6.3.0; the miner is built from a tree 333 commits later. The miner is an ' +
  'RPC client: the node validates every block it accepts, so the node decides. ' +
  'Recorded, not smoothed over. See PROVENANCE.md.';

if (missingRequired) process.exit(1);

const dest = path.join(ROOT, 'electron', 'net', 'binaries.json');
fs.writeFileSync(dest, Buffer.from(JSON.stringify(out, null, 2) + '\n', 'utf8'));
console.log(`wrote ${path.relative(ROOT, dest)}`);
