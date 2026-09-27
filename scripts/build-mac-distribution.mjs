// Native Apple-silicon release path. No credentials are accepted on the command
// line: Developer ID is read from Keychain and notarization uses a stored
// notarytool Keychain profile. The draft release is never changed here.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { developerIdIdentity } = require('./mac-distribution-identity.cjs');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const archIndex = process.argv.indexOf('--arch');
const arch = archIndex < 0 ? 'arm64' : process.argv[archIndex + 1];
if (!['arm64', 'x64'].includes(arch)) throw new Error(`Unsupported Mac architecture: ${arch}`);
const output = path.join(root, arch === 'x64' ? 'release-mac-signed-x64' : 'release-mac-signed');
const profile = process.env.APPLE_KEYCHAIN_PROFILE;
const resume = process.argv.includes('--resume');
const version = require('../package.json').version;
const app = path.join(output, arch === 'x64' ? 'mac' : 'mac-arm64', 'SWARM Node.app');
const dmName = `SWARM-Node-${version}-mac-${arch}.dmg`;
const zipName = `SWARM-Node-${version}-mac-${arch}.zip`;
const dmg = path.join(output, dmName);
const zip = path.join(output, zipName);
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function run(command, args, options = {}) {
  return execFileSync(command, args, { cwd: root, stdio: 'inherit', ...options });
}

function requireCleanSource() {
  const changes = run('git', ['status', '--porcelain', '--untracked-files=normal'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();
  if (changes) throw new Error('Commit and review source changes before signing; HEAD must describe the built source');
}

if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Build on an Apple-silicon Mac with native arm64 Node.js');
if (process.versions.node.split('.')[0] !== '22') throw new Error('Use Node.js 22 for SWARM Node');
if (!profile) throw new Error('Set APPLE_KEYCHAIN_PROFILE to an owner-configured notarytool profile name');
if (process.env.SWARM_NETWORK_PROFILE && process.env.SWARM_NETWORK_PROFILE !== 'swarm-mainnet') {
  throw new Error('The mainnet release cannot be built with another network profile');
}
process.env.SWARM_NETWORK_PROFILE = 'swarm-mainnet';
for (const key of ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER']) {
  if (process.env[key]) throw new Error(`Unset ${key}; notarization must use the Keychain profile`);
}
developerIdIdentity();
requireCleanSource();
try {
  run('xcrun', ['notarytool', 'history', '--keychain-profile', profile, '--output-format', 'json'],
    { stdio: ['ignore', 'pipe', 'pipe'] });
} catch {
  throw new Error(`Cannot use notarytool Keychain profile ${profile}; configure it locally before building`);
}
if (resume) {
  for (const file of [app, dmg, zip]) {
    if (!fs.existsSync(file)) throw new Error(`Cannot resume without generated output: ${file}`);
  }
  if (fs.existsSync(path.join(output, 'out'))) throw new Error('Signed release output already finalized');
} else if (fs.existsSync(output)) {
  throw new Error(`${output} exists; archive or remove the previous generated output before rebuilding`);
}

if (!resume) {
const pins = require('../build/binary-pins.json').profiles['swarm-mainnet'].platforms[`darwin-${arch}`];
if (!version.includes('-mainnet.') || !pins) throw new Error('A pinned mainnet Mac build is required');
const verified = path.join(root, 'staging', 'verified-bin');
run('node', ['scripts/fetch-pinned-binaries.mjs', '--platform', `darwin-${arch}`,
  '--profile', 'swarm-mainnet', '--dest', verified, '--staging', 'staging/download']);
const assets = [
  ['zebrad', 'swarm-node-daemon', pins.node_sha],
  ['privacy-miner', 'swarm-miner', pins.miner_sha],
];
const binDir = path.join(root, 'resources/bin');
fs.rmSync(binDir, { recursive: true, force: true });
fs.mkdirSync(binDir, { recursive: true });
for (const [source, dest, expected] of assets) {
  const raw = path.join(verified, source);
  if (sha(raw) !== expected) throw new Error(`${source} differs from the reviewed SHA256`);
  const staged = path.join(binDir, dest);
  fs.copyFileSync(raw, staged);
  fs.chmodSync(staged, 0o755);
}
if (fs.readdirSync(binDir).some((name) => /keytool|\.keys\.json$|^cookie$|\.env/i.test(name))) {
  throw new Error('Refusing to package a key tool or private material');
}

run('node', ['scripts/make-binaries-manifest.mjs', '--platform', `darwin-${arch}`]);
run('node', ['scripts/prepare-mac-signed-binaries.mjs', '--arch', arch]);
run('node', ['scripts/set-build-profile.mjs', 'swarm-mainnet']);
run('npm', ['run', 'build:ui']);
run('npx', ['electron-builder', '--mac', `--${arch}`, '--config', 'configs/swarm-mac-developer-id.cjs', '--publish', 'never'],
  { env: { ...process.env, SWARM_MAC_ARCH: arch } });
}

run('bash', ['scripts/check-arch.sh', path.dirname(app), arch === 'x64' ? 'x86_64' : 'arm64']);
run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]);
run('xcrun', ['stapler', 'validate', app]);
run('spctl', ['--assess', '--type', 'execute', '--verbose=4', app]);
if (!process.argv.includes('--skip-smoke')) {
  run('node', ['scripts/smoke-renderer.mjs', path.join(app, 'Contents/MacOS'), path.join(output, 'smoke')]);
}

// The app is already notarized and stapled before electron-builder writes the
// DMG. Submit that exact final DMG as well, then staple its own ticket.
const result = JSON.parse(run('xcrun', [
  'notarytool', 'submit', dmg, '--keychain-profile', profile,
  '--wait', '--output-format', 'json',
], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }));
if (result.status !== 'Accepted' || !/^[a-f0-9-]{36}$/i.test(result.id || '')) {
  throw new Error(`DMG notarization did not reach Accepted: ${JSON.stringify({ id: result.id, status: result.status })}`);
}
console.log(`DMG notarization accepted: ${result.id}`);
run('xcrun', ['stapler', 'staple', dmg]);
run('xcrun', ['stapler', 'validate', dmg]);

// Recreate ZIP from the final stapled app, never from a pre-staple archive.
fs.rmSync(zip, { force: true });
run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, zip]);

const out = path.join(output, 'out');
fs.mkdirSync(out);
for (const file of [dmg, zip]) fs.copyFileSync(file, path.join(out, path.basename(file)));
const checksums = [dmName, zipName].sort().map((name) => `${sha(path.join(out, name))} *${name}`).join('\n') + '\n';
fs.writeFileSync(path.join(out, 'SHA256SUMS'), checksums);
run('node', ['scripts/make-release-manifest.mjs', out, `darwin-${arch}`, '--signed', '--notary-submission', result.id]);
console.log(checksums);
console.log(`Signed artifacts and manifest: ${out}`);
