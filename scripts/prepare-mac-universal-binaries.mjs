// Merge the two reviewed mainnet native programs into fat Mach-O files before
// electron-builder merges its own x64 and arm64 Electron apps. Both platform
// baselines then pin the exact same signed universal bytes.
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
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const pins = require('../build/binary-pins.json').profiles['swarm-mainnet'].platforms;
const binDir = path.join(root, 'resources/bin');
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  throw new Error('Build universal Mac binaries on a native Apple-silicon Mac');
}
const identity = developerIdIdentity();
fs.mkdirSync(binDir, { recursive: true });

for (const [kind, name, pinField] of [
  ['zebrad', 'swarm-node-daemon', 'node_sha'],
  ['miner', 'swarm-miner', 'miner_sha'],
]) {
  const inputs = ['arm64', 'x64'].map((arch) => {
    const entry = manifest.platforms?.[`darwin-${arch}`]?.[kind];
    const file = path.join(root, 'staging', `universal-bin-${arch}`, name);
    const pin = pins[`darwin-${arch}`]?.[pinField];
    if (!entry || entry.file !== name || !pin || entry.sha256 !== pin || sha(file) !== pin) {
      throw new Error(`Unreviewed ${kind} input for darwin-${arch}`);
    }
    const slices = execFileSync('lipo', ['-archs', file], { encoding: 'utf8' }).trim().split(/\s+/);
    if (!slices.includes(arch === 'x64' ? 'x86_64' : 'arm64')) {
      throw new Error(`${kind} input is missing its ${arch} slice`);
    }
    return { arch, file, entry };
  });

  const output = path.join(binDir, name);
  execFileSync('lipo', ['-create', inputs[0].file, inputs[1].file, '-output', output], { stdio: 'inherit' });
  fs.chmodSync(output, 0o755);
  const slices = execFileSync('lipo', ['-archs', output], { encoding: 'utf8' }).trim().split(/\s+/);
  if (!['arm64', 'x86_64'].every((slice) => slices.includes(slice))) {
    throw new Error(`${kind} is not universal: ${slices.join(', ')}`);
  }
  execFileSync('codesign', ['--force', '--sign', identity, '--options', 'runtime', '--timestamp', output], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--strict', '--verbose=2', output], { stdio: 'inherit' });
  const signedHash = sha(output);
  for (const { entry } of inputs) {
    entry.source_sha256 = entry.sha256;
    entry.source_bytes = entry.bytes;
    entry.sha256 = signedHash;
    entry.bytes = fs.statSync(output).size;
    entry.universal_architectures = ['arm64', 'x86_64'];
  }
  console.log(`${kind}: signed universal ${signedHash}`);
}

manifest.generated_at = new Date().toISOString();
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
