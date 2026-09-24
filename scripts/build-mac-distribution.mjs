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
const output = path.join(root, 'release-mac-signed');
const profile = process.env.APPLE_KEYCHAIN_PROFILE;
const version = require('../package.json').version;
const app = path.join(output, 'mac-arm64', 'SWARM Node.app');
const dmName = `SWARM-Node-${version}-mac-arm64.dmg`;
const zipName = `SWARM-Node-${version}-mac-arm64.zip`;
const dmg = path.join(output, dmName);
const zip = path.join(output, zipName);
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function run(command, args, options = {}) {
  return execFileSync(command, args, { cwd: root, stdio: 'inherit', ...options });
}

if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Build on an Apple-silicon Mac with native arm64 Node.js');
if (process.versions.node.split('.')[0] !== '22') throw new Error('Use Node.js 22 for SWARM Node');
if (!profile) throw new Error('Set APPLE_KEYCHAIN_PROFILE to an owner-configured notarytool profile name');
for (const key of ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER']) {
  if (process.env[key]) throw new Error(`Unset ${key}; notarization must use the Keychain profile`);
}
developerIdIdentity();
try {
  run('xcrun', ['notarytool', 'history', '--keychain-profile', profile, '--output-format', 'json'],
    { stdio: ['ignore', 'pipe', 'pipe'] });
} catch {
  throw new Error(`Cannot use notarytool Keychain profile ${profile}; configure it locally before building`);
}
if (fs.existsSync(output)) throw new Error(`${output} exists; archive or remove the previous generated output before rebuilding`);

const assets = [
  ['zebrad-darwin-arm64', 'swarm-node-daemon', '61a2333ff660aa55f4351f88654bc4ad9f6041b65b0bf5349cd57d95e25160cb'],
  ['privacy-miner-darwin-arm64', 'swarm-miner', 'b556538fc0e43a0842c1a76005e947334bcbcfc622afc737bce379326c93358a'],
];
const binDir = path.join(root, 'resources/bin');
fs.mkdirSync(binDir, { recursive: true });
for (const [source, dest, expected] of assets) {
  const raw = path.join(root, 'staging', source);
  if (sha(raw) !== expected) throw new Error(`${source} differs from the reviewed SHA256`);
  const staged = path.join(binDir, dest);
  fs.copyFileSync(raw, staged);
  fs.chmodSync(staged, 0o755);
}
if (fs.readdirSync(binDir).some((name) => /keytool|\.keys\.json$|^cookie$|\.env/i.test(name))) {
  throw new Error('Refusing to package a key tool or private material');
}

run('node', ['scripts/make-binaries-manifest.mjs']);
run('node', ['scripts/prepare-mac-signed-binaries.mjs']);
run('npm', ['run', 'build:ui']);
run('npx', ['electron-builder', '--mac', '--arm64', '--config', 'configs/swarm-mac-developer-id.cjs', '--publish', 'never']);

run('bash', ['scripts/check-arch.sh', path.join(output, 'mac-arm64'), 'arm64']);
run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]);
run('xcrun', ['stapler', 'validate', app]);
run('spctl', ['--assess', '--type', 'execute', '--verbose=4', app]);
run('node', ['scripts/smoke-renderer.mjs', path.join(app, 'Contents/MacOS'), path.join(output, 'smoke')]);

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
run('node', ['scripts/make-release-manifest.mjs', out, 'darwin-arm64', '--signed', '--notary-submission', result.id]);
console.log(checksums);
console.log(`Signed artifacts and manifest: ${out}`);
