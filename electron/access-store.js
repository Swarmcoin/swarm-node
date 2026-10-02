// Where the closed-start access code is kept on this computer.
//
// The code carries this machine's tunnel key, so it is a secret. It is kept
// with the operating system's own protection that Electron offers
// (safeStorage: DPAPI on Windows, the Keychain on macOS, the desktop's secret
// store on Linux): settings.json then holds only an encrypted blob.
//
// Where this computer has no such store (some Linux desktops), the code is
// written to a file of its own in the app's data folder with owner-only
// permissions (0600), and the app says so where the code is pasted. On
// Windows that file's protection is the user profile's own access list.
//
// Pure apart from the injected safeStorage and fs, so it is unit-tested.

'use strict';

const path = require('path');

const FILE_NAME = 'access-code.secret';

/**
 * @param {object} deps
 *   settings     the SettingsStore (data + save)
 *   safeStorage  Electron's safeStorage, or a stand-in
 *   fs           node:fs, or a stand-in
 *   dir          the app's data folder
 */
function createAccessStore({ settings, safeStorage, fs, dir }) {
  const file = path.join(dir, FILE_NAME);

  const encryptionAvailable = () => {
    try { return !!(safeStorage && safeStorage.isEncryptionAvailable()); } catch { return false; }
  };

  /** {ok:true, code, encrypted} | {ok:false, missing:true} | {ok:false, error} */
  function read() {
    const rec = settings.data.accessCode;
    if (!rec || typeof rec !== 'object') return { ok: false, missing: true };
    if (typeof rec.enc === 'string') {
      try {
        return { ok: true, code: safeStorage.decryptString(Buffer.from(rec.enc, 'base64')), encrypted: true };
      } catch {
        return { ok: false, error: 'The saved access code could not be unlocked on this computer. Paste it again.' };
      }
    }
    if (rec.file === true) {
      try {
        return { ok: true, code: fs.readFileSync(file, 'utf8').trim(), encrypted: false };
      } catch {
        return { ok: false, error: 'The saved access code is missing. Paste it again.' };
      }
    }
    return { ok: false, missing: true };
  }

  /** Keep a code that has already been checked. Returns {ok, encrypted}. */
  function write(code) {
    if (encryptionAvailable()) {
      try {
        const enc = safeStorage.encryptString(code).toString('base64');
        settings.save({ accessCode: { enc } });
        try { fs.unlinkSync(file); } catch { /* there was none */ }
        return { ok: true, encrypted: true };
      } catch { /* fall through to the file */ }
    }
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, code + '\n', { mode: 0o600 });
    try { fs.chmodSync(tmp, 0o600); } catch { /* Windows keeps its own access list */ }
    fs.renameSync(tmp, file);
    settings.save({ accessCode: { file: true } });
    return { ok: true, encrypted: false };
  }

  /** Forget it everywhere. Returns {ok, removed}. */
  function remove() {
    const had = !!settings.data.accessCode;
    settings.save({ accessCode: null });
    let fileRemoved = false;
    try { fs.unlinkSync(file); fileRemoved = true; } catch { /* there was none */ }
    return { ok: true, removed: had || fileRemoved };
  }

  return { read, write, remove, encryptionAvailable, file };
}

module.exports = { createAccessStore, FILE_NAME };
