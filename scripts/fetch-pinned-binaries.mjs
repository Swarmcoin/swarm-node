// Fetch, verify and place the two binaries this app runs, for one platform.
//
//   node scripts/fetch-pinned-binaries.mjs --platform linux-x64
//   node scripts/fetch-pinned-binaries.mjs --platform win-x64 --profile swarm-mainnet
//
// WHY THIS FILE EXISTS.
// The pins used to live inline in two workflow files: a PowerShell hashtable
// in build-windows.yml and a JSON matrix row in build-unix.yml. That was two
// copies of the same fact, and adding a second network would have made it
// four. Worse, "which zebrad does a mainnet build run" is a consensus-relevant
// decision that was invisible in the repository's own files.
//
// So the pins are data now — build/binary-pins.json, one block per network
// profile — and this script is the only thing that reads them. A SWARM testnet
// build fetches exactly what it fetched before, from the same pre-release of
// this repository, with the same hashes. A SWARM mainnet build fetches the
// tools built from the mainnet integration branch, from the public
// privacy-zebra repository, where they are published as per-platform archives.
//
// The SHA-256 gate is what actually decides. The release is a transport; the
// hashes in build/binary-pins.json are the trust anchor, and they are the
// hashes the privacy-zebra workflow run printed.
//
// swarm-keytool is deliberately never placed: it creates spending keys and
// must not leave a build machine inside a miner. The archives contain it, so
// the extraction step copies the two named members out and nothing else, and
// then checks that no key tool reached the destination anyway.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PINS = path.join(ROOT, 'build', 'binary-pins.json');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new Error(`unexpected argument ${JSON.stringify(a)}`);
    const eq = a.indexOf('=');
    if (eq > 0) out[a.slice(2, eq)] = a.slice(eq + 1);
    else out[a.slice(2)] = argv[++i];
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const pins = JSON.parse(fs.readFileSync(PINS, 'utf8'));

const profileId = args.profile || process.env.SWARM_NETWORK_PROFILE || pins.default_profile;
const profile = pins.profiles[profileId];
if (!profile) {
  throw new Error(
    `no binary pins for network profile ${JSON.stringify(profileId)}; ` +
    `this repository pins ${Object.keys(pins.profiles).join(' and ')}`
  );
}

const platformKey = args.platform;
const platform = profile.platforms[platformKey];
if (!platform) {
  throw new Error(
    `profile ${profileId} has no pins for platform ${JSON.stringify(platformKey)}; ` +
    `known: ${Object.keys(profile.platforms).join(', ')}`
  );
}

// A tag may be overridden from the workflow input, but only the tag. The
// hashes never come from an input: an overridden tag whose contents do not
// match the pinned hashes fails the gate, which is the point.
const tag = args.tag || profile.tag;
const repo = profile.repo || process.env.GITHUB_REPOSITORY;
if (!repo) throw new Error('no release repository: set profile.repo in build/binary-pins.json or GITHUB_REPOSITORY');

const dest = path.resolve(ROOT, args.dest || 'resources/bin');
const staging = path.resolve(ROOT, args.staging || 'staging');
const exe = platformKey.startsWith('win') ? '.exe' : '';

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function run(cmd, cmdArgs, opts = {}) {
  return execFileSync(cmd, cmdArgs, { stdio: 'inherit', shell: false, ...opts });
}

function findOne(dir, name) {
  const stack = [dir];
  while (stack.length) {
    const here = stack.pop();
    for (const entry of fs.readdirSync(here, { withFileTypes: true })) {
      const full = path.join(here, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name === name) return full;
    }
  }
  throw new Error(`${name} was not found under ${dir}`);
}

fs.rmSync(staging, { recursive: true, force: true });
fs.mkdirSync(staging, { recursive: true });
fs.mkdirSync(dest, { recursive: true });

console.log(`profile   ${profileId} (${profile.label})`);
console.log(`release   ${repo} @ ${tag}`);
console.log(`platform  ${platformKey}  layout ${profile.layout}`);

/** The two files that end up in resources/bin, and the hash each must have. */
const placed = [
  { name: `zebrad${exe}`, member: platform.node_member || `zebrad${exe}`, asset: platform.node_asset, sha: platform.node_sha },
  { name: `privacy-miner${exe}`, member: platform.miner_member || `privacy-miner${exe}`, asset: platform.miner_asset, sha: platform.miner_sha }
];

// --from <dir>: use files already on this machine (a local build) instead of
// downloading them. The hashes decide exactly as they do for a download.
const fromDir = args.from ? path.resolve(args.from) : null;

// THE CLOSED-START TUNNEL (onetun), when this profile pins one for this
// platform. Built from source at a pinned tag by this repository's own
// workflow; the run that built it and the hash it printed are pinned here.
const tunnelPinned = !!(platform.tunnel_sha && /^[0-9a-f]{64}$/.test(platform.tunnel_sha));
if (tunnelPinned) placed.push({ name: `onetun${exe}`, member: `onetun${exe}`, sha: platform.tunnel_sha, tunnel: true });

function extractMembers(archivePath, items) {
  const unpacked = path.join(staging, 'unpacked');
  fs.mkdirSync(unpacked, { recursive: true });
  const tarExe = archivePath.endsWith('.zip') && process.platform === 'win32'
    ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
    : 'tar';
  run(tarExe, ['-xf', path.relative(unpacked, archivePath).split(path.sep).join('/')], { cwd: unpacked });
  for (const item of items) fs.copyFileSync(findOne(unpacked, item.member), path.join(dest, item.name));
}

if (profile.layout === 'run-artifact') {
  // The archive is a workflow artifact of a run in THIS private repository.
  const archive = platform.archive;
  let archivePath;
  if (fromDir) {
    archivePath = findOne(fromDir, archive);
  } else {
    run('gh', ['run', 'download', String(profile.run_id), '-R', repo, '-n', platform.artifact, '-D', staging], { env: process.env });
    archivePath = findOne(staging, archive);
  }
  const got = sha256(archivePath);
  if (got !== platform.archive_sha) throw new Error(`${archive} sha256 ${got} does not match the pinned ${platform.archive_sha}`);
  console.log(`${archive} sha256 ${got} OK (run ${profile.run_id})`);
  extractMembers(archivePath, placed.filter((p) => !p.tunnel));
} else if (profile.layout === 'archive') {
  // One archive holds every tool. `tar -xf` reads both .tar.gz and .zip on all
  // three runner images (bsdtar on Windows and macOS, GNU tar on Linux), so
  // there is one extraction path and no unzip dependency.
  const archive = platform.archive;
  run('gh', ['release', 'download', tag, '-R', repo, '-p', archive, '-D', staging], { env: process.env });
  const archivePath = path.join(staging, archive);
  const got = sha256(archivePath);
  if (got !== platform.archive_sha) {
    throw new Error(`${archive} sha256 ${got} does not match the pinned ${platform.archive_sha}`);
  }
  console.log(`${archive} sha256 ${got} OK`);
  const unpacked = path.join(staging, 'unpacked');
  fs.mkdirSync(unpacked, { recursive: true });
  // bsdtar reads .zip as well as .tar.gz; GNU tar reads only the latter, and
  // it also treats a `C:\...` argument as a remote host. So: name the archive
  // relative to the working directory, and on Windows reach for the system
  // bsdtar by path rather than whatever `tar` a shell's PATH resolves to.
  const tarExe = archive.endsWith('.zip') && process.platform === 'win32'
    ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
    : 'tar';
  run(tarExe, ['-xf', path.relative(unpacked, archivePath).split(path.sep).join('/')], { cwd: unpacked });
  for (const item of placed) {
    fs.copyFileSync(findOne(unpacked, item.member), path.join(dest, item.name));
  }
} else {
  const patterns = [];
  for (const item of placed) patterns.push('-p', item.asset);
  run('gh', ['release', 'download', tag, '-R', repo, ...patterns, '-D', staging], { env: process.env });
  for (const item of placed) {
    fs.copyFileSync(findOne(staging, item.asset), path.join(dest, item.name));
  }
}

if (tunnelPinned) {
  const tunnelItem = placed.find((p) => p.tunnel);
  let found;
  if (fromDir) {
    found = findOne(fromDir, tunnelItem.member);
  } else {
    if (!/^\d+$/.test(String(platform.tunnel_run || ''))) throw new Error(`no tunnel_run pinned for ${platformKey}`);
    const tdir = path.join(staging, 'tunnel');
    run('gh', ['run', 'download', String(platform.tunnel_run), '-R', repo, '-n', platform.tunnel_artifact, '-D', tdir], { env: process.env });
    found = findOne(tdir, tunnelItem.member);
  }
  fs.copyFileSync(found, path.join(dest, tunnelItem.name));
} else if (profile.tunnel) {
  console.log(`note: no tunnel pinned for ${platformKey}; a closed-start build cannot connect without it`);
}

// swarm-keytool creates spending keys. Make shipping it impossible, not
// unlikely — the archive layout contains it, so this is a real check.
for (const entry of fs.readdirSync(dest)) {
  if (/keytool/i.test(entry)) throw new Error(`refusing to package ${entry}`);
}

let failed = false;
for (const item of placed) {
  const file = path.join(dest, item.name);
  if (!exe) fs.chmodSync(file, 0o755);
  const got = sha256(file);
  if (got !== item.sha) {
    console.error(`${item.name} sha256 ${got} does not match the pinned ${item.sha}`);
    failed = true;
  } else {
    console.log(`${item.name} sha256 ${got} OK`);
  }
}
if (failed) process.exit(1);

fs.rmSync(staging, { recursive: true, force: true });
console.log(`placed ${placed.map((p) => p.name).join(' and ')} in ${path.relative(ROOT, dest)}`);
