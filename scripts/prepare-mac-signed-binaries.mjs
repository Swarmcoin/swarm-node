// Run after make-binaries-manifest.mjs has verified the original release
// assets. Sign the staged copies and record the bytes the app will execute.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { developerIdIdentity } = require('./mac-distribution-identity.cjs');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = path.join(root, 'electron/net/binaries.json');
const binDir = path.join(root, 'resources/bin');
const archIndex = process.argv.indexOf('--arch');
const arch = archIndex < 0 ? 'arm64' : process.argv[archIndex + 1];
const pins = require('../build/binary-pins.json').profiles['swarm-mainnet'].platforms[`darwin-${arch}`];
const expected = pins && { zebrad: pins.node_sha, miner: pins.miner_sha };
if (!expected) throw new Error(`Unsupported Mac architecture: ${arch}`);
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Native arm64 macOS is required');
const identity = developerIdIdentity();
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const entries = manifest.platforms?.[`darwin-${arch}`];
if (!entries?.zebrad || !entries?.miner) throw new Error(`Generate the original darwin-${arch} binary manifest first`);

for (const [kind, original] of Object.entries(expected)) {
  const entry = entries[kind];
  const file = path.join(binDir, entry.file);
  if (entry.sha256 !== original || sha(file) !== original) {
    throw new Error(`${kind} no longer matches the reviewed release asset ${original}`);
  }
  const slices = execFileSync('lipo', ['-archs', file], { encoding: 'utf8' }).trim().split(/\s+/);
  if (!slices.includes(arch === 'x64' ? 'x86_64' : 'arm64')) {
    throw new Error(`${kind} is missing the ${arch} slice: ${slices.join(', ')}`);
  }
}

for (const [kind, original] of Object.entries(expected)) {
  const entry = entries[kind];
  const file = path.join(binDir, entry.file);
  execFileSync('codesign', ['--force', '--sign', identity, '--options', 'runtime', '--timestamp', file], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--strict', '--verbose=2', file], { stdio: 'inherit' });
  entry.source_sha256 = original;
  entry.source_bytes = entry.bytes;
  entry.sha256 = sha(file);
  entry.bytes = fs.statSync(file).size;
  console.log(`${kind}: reviewed ${original}; signed ${entry.sha256}`);
}
manifest.generated_at = new Date().toISOString();
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
