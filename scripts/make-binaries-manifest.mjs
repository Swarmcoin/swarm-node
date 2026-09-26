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
// JSON on every build and would otherwise overwrite it. Both programs carry
// reviewed SWARM changes, documented in electron/net/PROVENANCE.md.

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
    branch: 'codex/swarm-prefix-node',
    commit: 'c4e0a4b3772ab81c2c73a183d837ac3ce2ea7c05',
    upstream_base: 'tag v6.3.0, the official Zcash Foundation release',
    changes_vs_upstream:
      'SWARM build workflows and measured internal-miner rate logging; vendored ' +
      'zcash_protocol 0.10.1 and zcash_address 0.13.0 encode SWARM testnet unified ' +
      'addresses/viewing keys and accept legacy testnet forms. Cargo manifests ' +
      'and lockfile pin the local crates. Receiver bytes and consensus rules ' +
      'are unchanged. Address compatibility tests run on every target.',
    build: 'cargo build --locked --release --package zebrad --bin zebrad --features internal-miner',
    workflow_run: 'https://github.com/Swarm-Official/privacy-zebra/actions/runs/35938556704'
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

// The provenance every mainnet node binary shares. Spread into each entry so
// that the testnet zebrad's `upstream_base`, `changes_vs_upstream` and
// `build` in PROVENANCE above - which describe a tree WITHOUT
// Network::SwarmMain - cannot survive into a mainnet build's binaries.json.
const MAINNET_NODE = {
  repository: 'Swarm-Official/privacy-zebra',
  branch: 'codex/mainnet-integration-20260925',
  commit: '01b9da3de144a6deb4dd631396cbbc3bfb7c6d81',
  release: 'vendored-binaries-mainnet-2',
  workflow_run: 'https://github.com/Swarm-Official/privacy-zebra/actions/runs/36217735742',
  built_at_utc: '2026-09-26T04:35:53Z',
  upstream_base: 'tag v6.3.0, the official Zcash Foundation release',
  changes_vs_upstream:
    'adds Network::SwarmMain, the SWARM production network, magic SWMN, ' +
    'transaction domain 0x53574d31, V5/V6 only from height 1, the 8/4/8 funding ' +
    'split to three s3 P2SH destinations, and the [network.swarm_main] config ' +
    'section with initial_swarm_main_peers. Equihash 200,9 and the rest of ' +
    'consensus and cryptography are inherited from v6.3.0 unchanged.',
  build: 'cargo build --locked --release --package zebrad --bin zebrad --features internal-miner',
  network: 'SwarmMainnet',
  binary: 'zebrad'
};

// The mainnet MINER comes out of the same archive and the same tree as the
// mainnet node, which the testnet miner does not: PROVENANCE.miner above
// names swarm-tools @ 7f82a03be, a tree 333 commits past v6.3.0 with no
// SwarmMain in it. Without an entry here, a mainnet build's binaries.json
// would attribute a 01b9da3de miner to that other branch. Hashes recomputed
// from the same archives on 2026-09-26; the miner is not gated the way the
// node is, so this is provenance, not a gate.
const MAINNET_MINER = {
  role: 'the standard (multi-core) mining engine',
  repository: 'Swarm-Official/privacy-zebra',
  branch: 'codex/mainnet-integration-20260925',
  commit: '01b9da3de144a6deb4dd631396cbbc3bfb7c6d81',
  release: 'vendored-binaries-mainnet-2',
  workflow_run: 'https://github.com/Swarm-Official/privacy-zebra/actions/runs/36217735742',
  built_at_utc: '2026-09-26T04:35:53Z',
  upstream_base: 'the same tree as the node beside it, which carries privacy-miner.rs',
  changes_vs_upstream:
    'privacy-miner is an RPC client: it asks the node for a template, solves ' +
    'Equihash 200,9 and submits. It decides nothing about the network - the ' +
    'node validates every block it is offered.',
  build:
    'cargo build --locked --release --package zebrad --bin privacy-miner --bin swarm-keytool ' +
    '--features internal-miner',
  network: 'SwarmMainnet',
  binary: 'privacy-miner'
};

// Platform builds are identified by the bytes CI verified.
const VERIFIED_BUILDS = {
  "e3c012c54406ba9bf9a661b111440bade33a9fafec0611341673508d70629b68": {
    "branch": "codex/intel-miner-ci",
    "commit": "75da596ea680011c24230e558d78f9c70221bcf2",
    "workflow_run": "https://github.com/Swarm-Official/privacy-zebra/actions/runs/35909770301",
    "built_at_utc": "2026-09-23T19:56:07Z",
    "target": "x86_64-apple-darwin"
  },
  "61a2333ff660aa55f4351f88654bc4ad9f6041b65b0bf5349cd57d95e25160cb": {
    "workflow_run": "https://github.com/Swarm-Official/privacy-zebra/actions/runs/35938556704",
    "built_at_utc": "2026-09-24T00:49:42Z",
    "target": "aarch64-apple-darwin",
    "binary": "zebrad"
  },
  "a26d4ba503b986f1671ef4fd695476ab181e747c67983d0215cddc4eed0d6bc3": {
    "workflow_run": "https://github.com/Swarm-Official/privacy-zebra/actions/runs/35938556704",
    "built_at_utc": "2026-09-24T00:57:07Z",
    "target": "x86_64-pc-windows-msvc",
    "binary": "zebrad"
  },
  "f0a809f6aa8671e7b47c1557d4c524293d9c0e7871648812f6383dc37dfd0896": {
    "workflow_run": "https://github.com/Swarm-Official/privacy-zebra/actions/runs/35938556704",
    "built_at_utc": "2026-09-24T00:49:03Z",
    "target": "x86_64-unknown-linux-gnu",
    "binary": "zebrad"
  },
  "486cfa2fb459427386705ae7bde05b172e58ae3fa794dd73d36dbd2d31f88748": {
    "workflow_run": "https://github.com/Swarm-Official/privacy-zebra/actions/runs/35938556704",
    "built_at_utc": "2026-09-24T01:36:55Z",
    "target": "x86_64-apple-darwin",
    "binary": "zebrad"
  },

  // ---- the SWARM MAINNET node, vendored-binaries-mainnet-2 ----
  //
  // A different tree from the five above. Those are the testnet node, built
  // from codex/swarm-prefix-node c4e0a4b3, which has no Network::SwarmMain at
  // all: it rejects [network.swarm_main] while deserialising its config and
  // can never report chain swarm-mainnet. A mainnet build must run these.
  //
  // Source privacy-zebra 01b9da3de (built at f5b27500, which differs from it
  // only by .github/workflows/swarm-binaries.yml), run 36217735742. The two
  // commits since mainnet-1 that matter: 16c6a210f added
  // `initial_swarm_main_peers`, without which a SwarmMain node cannot be
  // pointed at seed-main.swarm.green at all, and 01b9da3de fixed the fee
  // swarm-treasury charges (a tool, not bundled here).
  //
  // REVIEWED, not copied across. Each hash below was recomputed on 2026-09-26
  // from the release archive in D:/privacy/outputs/mainnet-ci-20260926/
  // privacy-zebra/01b9da3de/, and agrees with that run's own SHA256SUMS and
  // with build/binary-pins.json - which fetch-pinned-binaries.mjs enforces
  // before this script ever sees the file. The Windows binary was also given
  // the exact zebrad.toml this app renders for swarm-mainnet and reported
  // "Zcash network: SwarmMainnet".
  //
  // These are NOT byte-reproducible against the build host's own compile of
  // the same source: Zebra's release build compiles in absolute source and
  // cargo-registry paths. No reproducibility claim is made, here or anywhere.
  "2bf0f0255ef4dd2cd26e27271034daf012fb004c893f3e9ade01c7d3404f9432": { ...MAINNET_NODE, "target": "x86_64-pc-windows-msvc" },
  "2d3511de0ca581fa33f180502d4d652cbb9ea19bfcb3d750d4718aaaca4ac418": { ...MAINNET_NODE, "target": "x86_64-unknown-linux-gnu" },
  "6c2e781ee0386a9cde9a772cd5cb3041c0182cf21e36fefe86c205dbe2340845": { ...MAINNET_NODE, "target": "aarch64-apple-darwin" },
  "5812b34177d2688a552375567db9f1a4a7fe567f709cf4b97d54ea0b1284a8c3": { ...MAINNET_NODE, "target": "x86_64-apple-darwin" },

  // the mainnet miner out of the same four archives
  "c432d9a003facfd33b40c5d0909cd6211b9a711b6e42202f091bfe90468b8ea8": { ...MAINNET_MINER, "target": "x86_64-pc-windows-msvc" },
  "550b63085ca2efa476a8490f1d64dca44fcf1c0e94947a7e1982a34535d3d9b0": { ...MAINNET_MINER, "target": "x86_64-unknown-linux-gnu" },
  "86549181bb7bf8574bdb016ba7c39c1a1bd5aa0a979746a21a050c6e40a86fd9": { ...MAINNET_MINER, "target": "aarch64-apple-darwin" },
  "cfad03ddb59456ca9513062b93942ecfff1a9c3f17d7f33db1cc143587083882": { ...MAINNET_MINER, "target": "x86_64-apple-darwin" }
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
  if (name === 'zebrad' && VERIFIED_BUILDS[sha256]?.binary !== 'zebrad') {
    throw new Error(`Unreviewed node binary: ${sha256}`);
  }
  const provenance = { ...PROVENANCE[name], ...VERIFIED_BUILDS[sha256] };
  mine[name] = { file: spec.file, sha256, bytes: buf.length, ...provenance };
  console.log(`${name.padEnd(7)} ${spec.file.padEnd(20)} ${sha256}  ${buf.length} bytes`);
  console.log(`        ${provenance.branch} @ ${provenance.commit.slice(0, 12)}`);
}

if (missingRequired) process.exit(1);

out.platforms[key] = mine;
fs.writeFileSync(dest, JSON.stringify(out, null, 2) + '\n');
console.log(`wrote ${path.relative(ROOT, dest)} for ${key} (file now covers: ${Object.keys(out.platforms).join(', ')})`);
