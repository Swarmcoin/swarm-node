// Binary resolution and integrity check.
//
// SWARM Node runs two third-party executables on the user's machine. It
// refuses to launch either unless its SHA-256 matches a baseline baked into
// the build. The baseline lives in electron/net/binaries.json, which the CI
// workflow writes from the artifacts it downloaded and verified itself, so a
// binary swapped after installation cannot be started by this app.
//
// The check is a supply-chain guard, not a security boundary: a user with
// write access to the install directory can also edit binaries.json. It stops
// the realistic case — a tampered or corrupted download, or a half-written
// file from an interrupted install.

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { unpackedPath } = require('./graceful-stop');

const BIN_NAMES = {
  zebrad: process.platform === 'win32' ? 'zebrad.exe' : 'zebrad',
  miner: process.platform === 'win32' ? 'privacy-miner.exe' : 'privacy-miner'
};

function sha256File(file) {
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(file));
  return h.digest('hex');
}

/** Candidate locations, most-specific first. */
function candidates(name) {
  const out = [];
  if (process.env.SWARM_NODE_BIN_DIR) out.push(path.join(process.env.SWARM_NODE_BIN_DIR, name));
  if (process.resourcesPath) out.push(path.join(process.resourcesPath, 'bin', name));
  out.push(unpackedPath(path.join(__dirname, '..', '..', 'resources', 'bin', name)));
  return out;
}

/**
 * The SHA-256 baseline, read from inside the asar.
 *
 * It must NOT go through unpackedPath. Only electron/resources/** is unpacked
 * (asarUnpack), so rewriting "app.asar" to "app.asar.unpacked" for this file
 * pointed at a path that does not exist. loadBaseline then returned {}, every
 * binary looked unpinned, and a PACKAGED build — where unpinned binaries are
 * refused — reported "privacy-miner is not bundled with this build" while the
 * file sat right there in resources/bin. The owner saw exactly that on the
 * Mining page. Electron's fs reads straight out of the archive, so the plain
 * path is the correct one; the unpacked path stays as a fallback for a build
 * that does unpack it.
 */
function loadBaseline() {
  const inAsar = path.join(__dirname, '..', 'net', 'binaries.json');
  for (const file of [inAsar, unpackedPath(inAsar)]) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (parsed && typeof parsed === 'object') return parsed;
    } catch { /* try the next one */ }
  }
  return {};
}

/**
 * Find and verify a bundled binary.
 * @param {'zebrad'|'miner'} kind
 * @returns {{ok:boolean, path:string|null, sha256:string|null, expected:string|null, reason:string}}
 */
function resolveBinary(kind, { baseline = loadBaseline() } = {}) {
  const name = BIN_NAMES[kind];
  if (!name) return { ok: false, path: null, sha256: null, expected: null, reason: `unknown binary ${kind}` };

  let found = null;
  for (const c of candidates(name)) {
    try { if (fs.statSync(c).isFile()) { found = c; break; } } catch { /* next */ }
  }
  if (!found) {
    return { ok: false, path: null, sha256: null, expected: null, reason: `${name} is not bundled with this build` };
  }

  const entry = baseline[kind] || {};
  const expected = typeof entry.sha256 === 'string' && /^[0-9a-f]{64}$/i.test(entry.sha256)
    ? entry.sha256.toLowerCase()
    : null;

  let actual;
  try { actual = sha256File(found); } catch (e) {
    return { ok: false, path: found, sha256: null, expected, reason: `cannot read ${name}: ${e.message}` };
  }

  if (!expected) {
    // No baseline recorded. Development builds hit this; shipped builds must
    // not, so the caller decides whether to allow it (see allowUnpinned).
    return { ok: false, path: found, sha256: actual, expected: null, reason: `no SHA-256 baseline recorded for ${name}`, unpinned: true };
  }
  if (actual !== expected) {
    return {
      ok: false, path: found, sha256: actual, expected,
      reason: `${name} does not match the SHA-256 recorded at build time. Refusing to run it. ` +
              `Reinstall SWARM Node rather than replacing files by hand.`
    };
  }
  return { ok: true, path: found, sha256: actual, expected, reason: 'verified' };
}

/**
 * The gate the engine calls. `allowUnpinned` is true only for developer builds
 * (never packaged), and the result always carries what happened so the UI can
 * show it.
 */
function requireBinary(kind, { allowUnpinned = false, baseline } = {}) {
  const r = resolveBinary(kind, baseline ? { baseline } : {});
  if (r.ok) return r;
  if (r.unpinned && allowUnpinned) {
    return { ...r, ok: true, reason: 'UNPINNED — no baseline hash; allowed because this is a development build' };
  }
  return r;
}

module.exports = { resolveBinary, requireBinary, sha256File, loadBaseline, BIN_NAMES };
