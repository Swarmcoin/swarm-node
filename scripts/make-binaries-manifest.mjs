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

const WANT = {
  zebrad: { file: 'zebrad.exe', required: true },
  miner: { file: 'privacy-miner.exe', required: false }
};

// Things that must never be shipped inside the app, whatever ends up in the
// staging folder. The key tool can create spending keys; a user-facing miner
// has no business carrying it.
const FORBIDDEN = [/keytool/i, /\.keys\.json$/i, /^cookie$/i, /\.env/i];

const out = {
  _comment: 'SHA-256 of the binaries this build is allowed to run. Written by scripts/make-binaries-manifest.mjs.',
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
  out[key] = { file: spec.file, sha256, bytes: buf.length };
  console.log(`${key.padEnd(7)} ${spec.file.padEnd(20)} ${sha256}  ${buf.length} bytes`);
}

if (missingRequired) process.exit(1);

const dest = path.join(ROOT, 'electron', 'net', 'binaries.json');
fs.writeFileSync(dest, Buffer.from(JSON.stringify(out, null, 2) + '\n', 'utf8'));
console.log(`wrote ${path.relative(ROOT, dest)}`);
