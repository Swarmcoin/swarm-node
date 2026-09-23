// The code that locks this application, and the rules for it.
//
// Pure: no Electron, no disk, no clock beyond the wall clock a wait needs. The
// main process owns the store and the window; this module owns the arithmetic,
// which is why it can be tested with `node --test` on its own.
//
// The code is a SESSION LOCK. It does not encrypt anything this app holds, and
// no screen may suggest it does. What is written to disk is a random salt plus
// a scrypt-derived key — never the code itself — so reading the settings file
// does not reveal it. That file is what this application has: unlike the wallet
// there is no keychain to put it in, which is stated where the user sets it.

'use strict';

const crypto = require('crypto');

const MIN_LENGTH = 6;
const MAX_LENGTH = 12;
const SALT_BYTES = 16;
const KEY_BYTES = 32;

// 2^15 with r=8 is about 32 MB and tens of milliseconds: invisible to somebody
// typing their code, expensive for a script guessing against the stored hash.
const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

// Five free tries, then a wait that doubles each try, capped at a minute. The
// count lives in memory for the life of the process, so reopening the app
// clears it: this app holds no keys, so the code guards the controls on a
// machine rather than a fortune, and saying so is better than implying more.
const FREE_ATTEMPTS = 5;
const MAX_WAIT_SECONDS = 60;

/** Digits only, and long enough to be worth typing. */
function checkShape(value) {
  const code = typeof value === 'string' ? value.trim() : '';
  if (!/^[0-9]+$/.test(code)) return { ok: false, reason: 'Use digits only.' };
  if (code.length < MIN_LENGTH) return { ok: false, reason: `Use at least ${MIN_LENGTH} digits.` };
  if (code.length > MAX_LENGTH) return { ok: false, reason: `Use at most ${MAX_LENGTH} digits.` };
  return { ok: true, code };
}

function derive(code, salt, params) {
  return crypto.scryptSync(code, salt, KEY_BYTES, params);
}

/** A new record for a code. The code itself is not in here. */
function createRecord(code) {
  const shape = checkShape(code);
  if (!shape.ok) return shape;
  const salt = crypto.randomBytes(SALT_BYTES);
  return {
    ok: true,
    record: {
      version: 1,
      salt: salt.toString('base64'),
      hash: derive(shape.code, salt, SCRYPT).toString('base64'),
      params: { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p },
    },
  };
}

/** Whether a record is one this module wrote. Anything else means "no code". */
function isRecord(value) {
  return !!(
    value &&
    typeof value === 'object' &&
    typeof value.salt === 'string' &&
    typeof value.hash === 'string'
  );
}

function matches(record, value) {
  if (!isRecord(record)) return false;
  const salt = Buffer.from(record.salt, 'base64');
  const expected = Buffer.from(record.hash, 'base64');
  const params = {
    N: (record.params && record.params.N) || SCRYPT.N,
    r: (record.params && record.params.r) || SCRYPT.r,
    p: (record.params && record.params.p) || SCRYPT.p,
    maxmem: SCRYPT.maxmem
  };
  let given;
  try {
    given = derive(typeof value === 'string' ? value : '', salt, params);
  } catch {
    return false;
  }
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

/**
 * The counter and the wait, in one place, so the lock screen, the settings
 * screen and any future caller cannot disagree about how many tries are left.
 */
function createGate(now = () => Date.now()) {
  let failures = 0;
  let blockedUntil = 0;

  return {
    waitSeconds() {
      const left = blockedUntil - now();
      return left > 0 ? Math.ceil(left / 1000) : 0;
    },
    /** One code against the record, with the wait applied first. */
    verify(record, value) {
      const wait = this.waitSeconds();
      if (wait > 0) {
        return { ok: false, waitSeconds: wait, reason: `Too many wrong tries. Wait ${wait} seconds.` };
      }
      if (!isRecord(record)) return { ok: true, waitSeconds: 0 };
      if (matches(record, value)) {
        failures = 0;
        blockedUntil = 0;
        return { ok: true, waitSeconds: 0 };
      }
      failures += 1;
      if (failures >= FREE_ATTEMPTS) {
        const seconds = Math.min(2 ** (failures - FREE_ATTEMPTS), MAX_WAIT_SECONDS);
        blockedUntil = now() + seconds * 1000;
        return { ok: false, waitSeconds: seconds, reason: `Wrong code. Wait ${seconds} seconds.` };
      }
      const left = FREE_ATTEMPTS - failures;
      return { ok: false, waitSeconds: 0, reason: `Wrong code. ${left} tr${left === 1 ? 'y' : 'ies'} left.` };
    },
    reset() {
      failures = 0;
      blockedUntil = 0;
    }
  };
}

module.exports = {
  MIN_LENGTH,
  MAX_LENGTH,
  FREE_ATTEMPTS,
  MAX_WAIT_SECONDS,
  checkShape,
  createRecord,
  isRecord,
  matches,
  createGate
};
