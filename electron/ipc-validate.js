// IPC argument validation.
//
// Everything that crosses from the renderer into the main process is
// untrusted: a compromised renderer must not be able to make the main process
// spawn something, read an arbitrary file, or write outside its own data
// directory. Every handler in main.js runs its argument through a validator
// here first, and a validator either returns a clean value or throws.
//
// Pure functions, no Electron import, so the whole set is unit-tested.

'use strict';

class IpcError extends Error {}

function fail(msg) { throw new IpcError(msg); }

/** A boolean, and nothing that merely looks like one. */
function bool(v, name = 'value') {
  if (typeof v !== 'boolean') fail(`${name} must be true or false`);
  return v;
}

/** An integer inside a range. Rejects strings, floats, NaN and Infinity. */
function int(v, { min, max, name = 'value' } = {}) {
  if (typeof v !== 'number' || !Number.isInteger(v)) fail(`${name} must be a whole number`);
  if (min != null && v < min) fail(`${name} must be at least ${min}`);
  if (max != null && v > max) fail(`${name} must be at most ${max}`);
  return v;
}

/** A short string with no control characters. */
function text(v, { max = 512, min = 0, name = 'value', pattern = null } = {}) {
  if (typeof v !== 'string') fail(`${name} must be text`);
  const s = v.trim();
  if (s.length < min) fail(`${name} is too short`);
  if (s.length > max) fail(`${name} is too long (max ${max} characters)`);
  if (/[\u0000-\u001f\u007f]/.test(s)) fail(`${name} contains control characters`);
  if (pattern && !pattern.test(s)) fail(`${name} has an unexpected format`);
  return s;
}

/** One of a fixed set. */
function oneOf(v, allowed, name = 'value') {
  if (!allowed.includes(v)) fail(`${name} must be one of: ${allowed.join(', ')}`);
  return v;
}

// A payout address is base58/bech32 text only. It is NOT parsed here: the node
// decides validity. This only keeps shell metacharacters and paths out.
const ADDRESS_RE = /^[0-9A-Za-z]{20,512}$/;
function payoutAddress(v) {
  const s = text(v, { max: 512, min: 20, name: 'address' });
  if (!ADDRESS_RE.test(s)) fail('An address is letters and digits only. Copy it from the SWARM Wallet.');
  return s;
}

const MINING_MODES = ['standard', 'shielded'];
function miningMode(v) { return oneOf(text(v, { max: 16, name: 'mode' }), MINING_MODES, 'mode'); }

/**
 * A directory the user picked for chain data. Absolute, no traversal segments,
 * and never inside a Windows system directory.
 */
const FORBIDDEN_ROOTS = [
  /^[a-z]:[\\/]windows(?:[\\/]|$)/i,
  /^[a-z]:[\\/]program files(?: \(x86\))?(?:[\\/]|$)/i,
  /^[a-z]:[\\/]programdata[\\/]microsoft(?:[\\/]|$)/i,
  /^\\\\/                                   // UNC path
];
function dataDir(v) {
  const s = text(v, { max: 240, min: 3, name: 'folder' });
  if (process.platform === 'win32') {
    if (!/^[a-zA-Z]:[\\/]/.test(s)) fail('Choose a folder on a local drive, for example D:\\SWARM.');
  } else if (!s.startsWith('/')) {
    fail('Choose an absolute path.');
  }
  if (s.split(/[\\/]/).some((seg) => seg === '..')) fail('The folder path may not contain "..".');
  for (const re of FORBIDDEN_ROOTS) if (re.test(s)) fail('That folder belongs to Windows. Choose another one.');
  return s;
}

/** An https link the app is allowed to hand to the OS browser. */
function externalUrl(v, allowedHosts) {
  const s = text(v, { max: 512, name: 'link' });
  let u;
  try { u = new URL(s); } catch { fail('That is not a link.'); }
  if (u.protocol !== 'https:') fail('Only https links can be opened.');
  if (Array.isArray(allowedHosts) && allowedHosts.length && !allowedHosts.includes(u.host)) {
    fail('That link is not one of the app\u2019s own links.');
  }
  return u.toString();
}

/** How many log lines the UI may ask for. */
function logLimit(v) {
  if (v == null) return 300;
  return int(v, { min: 1, max: 1000, name: 'limit' });
}

/** The confirmation phrase for the first-node override. */
function confirmPhrase(v) {
  const s = text(v, { max: 40, name: 'confirmation' });
  return s;
}

module.exports = {
  IpcError, bool, int, text, oneOf,
  payoutAddress, miningMode, dataDir, externalUrl, logLimit, confirmPhrase,
  MINING_MODES, ADDRESS_RE
};
