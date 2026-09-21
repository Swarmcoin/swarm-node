// Account manager — the operator's network identity + payout wallet.
//
// Two ways to get an account:
//   create  — generates a real ETH wallet (ethers). The private key is
//             encrypted with the user's password into a standard V3
//             keystore JSON (scrypt) stored in userData. The recovery
//             phrase is returned ONCE for backup and never stored.
//   import  — either a watch-only payout address (no key held) or a raw
//             private key (encrypted to a keystore like `create`).
//
// Renderer never sees private keys — only the address and, at creation
// time, the one-time recovery phrase. All addresses are EIP-55 validated.

const path = require('path');
const fs = require('fs');
const { Wallet, HDNodeWallet, getAddress, isAddress } = require('ethers');

class AccountManager {
  constructor(userDataDir) {
    this.dir = userDataDir;
    this.file = path.join(userDataDir, 'account.json');
  }

  get() {
    try {
      const acc = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return {
        address: acc.address, mode: acc.mode, createdAt: acc.createdAt,
        hasKeystore: !!acc.keystoreFile, email: acc.email || null, profile: acc.profile || null
      };
    } catch {
      return null;
    }
  }

  // Export the private key by decrypting the keystore with the operator's
  // password. Sensitive: the caller must confirm intent in the UI, the
  // password is required every time, and the key is never logged or stored.
  async exportPrivateKey(password) {
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      return { ok: false, error: 'No account on this machine.' };
    }
    if (!raw.keystoreFile) {
      return { ok: false, error: 'This is a watch-only account — no private key is stored here.' };
    }
    let json;
    try {
      json = fs.readFileSync(raw.keystoreFile, 'utf8');
    } catch {
      return { ok: false, error: 'Keystore file not found.' };
    }
    try {
      const wallet = await Wallet.fromEncryptedJson(json, password);
      return {
        ok: true,
        address: wallet.address,
        privateKey: wallet.privateKey,
        mnemonic: wallet.mnemonic ? wallet.mnemonic.phrase : null,
      };
    } catch {
      return { ok: false, error: 'Wrong password (or the keystore is corrupt).' };
    }
  }

  // Sign out: forget the active account so the app returns to onboarding.
  // The encrypted keystore file is deliberately LEFT on disk — signing out
  // is not deleting the wallet; the operator can re-import it (or recover
  // from their phrase) later. Only the "which account is active" pointer
  // (account.json) is removed.
  clear() {
    try { fs.unlinkSync(this.file); } catch { /* already absent */ }
    return { ok: true };
  }

  // Operator profile (email + onboarding answers), merged into the record.
  saveProfile(email, profile) {
    const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    raw.email = String(email).trim().toLowerCase();
    raw.profile = profile || {};
    this.save(raw);
  }

  // EIP-55: throws on a bad checksum, accepts all-lowercase legacy form.
  validate(addr) {
    try {
      return { ok: true, address: getAddress(String(addr || '').trim()) };
    } catch (e) {
      return { ok: false, error: 'Invalid address' + (isAddress((addr || '').toLowerCase()) ? ' checksum (EIP-55)' : '') };
    }
  }

  async create(password) {
    if (!password || password.length < 8) {
      return { ok: false, error: 'Password must be at least 8 characters.' };
    }
    const wallet = HDNodeWallet.createRandom();
    const keystore = await wallet.encrypt(password); // V3 keystore, scrypt
    const keystoreFile = path.join(this.dir, `keystore-${wallet.address}.json`);
    fs.writeFileSync(keystoreFile, keystore);
    this.save({ address: wallet.address, mode: 'created', keystoreFile, createdAt: new Date().toISOString() });
    // The phrase crosses to the renderer exactly once, for the backup screen.
    return { ok: true, address: wallet.address, mnemonic: wallet.mnemonic.phrase };
  }

  async import(value, password) {
    const v = String(value || '').trim();

    // Watch-only payout address: we hold no key, just pay out to it.
    if (/^0x[0-9a-fA-F]{40}$/.test(v)) {
      const check = this.validate(v);
      if (!check.ok) return check;
      this.save({ address: check.address, mode: 'watch-only', createdAt: new Date().toISOString() });
      return { ok: true, address: check.address };
    }

    // Raw private key: encrypt it into a keystore, same as `create`.
    if (/^(0x)?[0-9a-fA-F]{64}$/.test(v)) {
      if (!password || password.length < 8) {
        return { ok: false, error: 'A password (8+ chars) is required to encrypt the key.' };
      }
      let wallet;
      try {
        wallet = new Wallet(v.startsWith('0x') ? v : '0x' + v);
      } catch {
        return { ok: false, error: 'Invalid private key.' };
      }
      const keystoreFile = path.join(this.dir, `keystore-${wallet.address}.json`);
      fs.writeFileSync(keystoreFile, await wallet.encrypt(password));
      this.save({ address: wallet.address, mode: 'imported', keystoreFile, createdAt: new Date().toISOString() });
      return { ok: true, address: wallet.address };
    }

    return { ok: false, error: 'Enter an ETH address (0x…, 40 hex) or a private key (64 hex).' };
  }

  save(acc) {
    fs.writeFileSync(this.file, JSON.stringify(acc, null, 2));
  }
}

module.exports = { AccountManager };
