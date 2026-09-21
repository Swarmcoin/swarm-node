// JSON-RPC client for the local zebrad.
//
// Cookie authentication rules this file follows, and they are not negotiable:
//   * the cookie file is rewritten every time zebrad starts, so it is read
//     fresh from disk before EVERY call — never cached in memory;
//   * the cookie value is never logged, never sent to the renderer, never put
//     in an error message, and never written anywhere by this app;
//   * the endpoint is loopback only. A non-loopback host is refused here.

'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');

const COOKIE_FILE = '.cookie';

class RpcError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

/** Redact anything that could be a cookie before a string is logged. */
function redact(s) {
  return String(s == null ? '' : s).replace(/__cookie__:[^\s"'&]+/g, '__cookie__:<redacted>');
}

class ZebraRpc {
  /**
   * @param {object} cfg
   *   host      {string} must be 127.0.0.1 or ::1
   *   port      {number}
   *   cookieDir {string} the directory zebrad writes .cookie into
   *   timeoutMs {number}
   */
  constructor(cfg = {}) {
    const host = cfg.host || '127.0.0.1';
    if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
      throw new RpcError(`RPC host must be loopback, got ${host}`);
    }
    this.host = host;
    this.port = Number(cfg.port);
    this.cookieDir = cfg.cookieDir;
    this.timeoutMs = Number(cfg.timeoutMs) || 15000;
    this.nextId = 1;
  }

  cookiePath() { return path.join(this.cookieDir, COOKIE_FILE); }

  /**
   * Read the cookie fresh. Returns the Basic auth header value, or null when
   * the node has not written a cookie yet (it has not finished starting).
   * The caller must never store or print the return value.
   */
  readAuthHeader() {
    let raw;
    try {
      raw = fs.readFileSync(this.cookiePath(), 'utf8').trim();
    } catch {
      return null;
    }
    if (!raw) return null;
    return 'Basic ' + Buffer.from(raw, 'utf8').toString('base64');
  }

  /**
   * One JSON-RPC call.
   * @param {string} method
   * @param {Array} params
   */
  call(method, params = []) {
    if (typeof method !== 'string' || !/^[a-z_][a-z0-9_]{0,40}$/i.test(method)) {
      return Promise.reject(new RpcError(`bad RPC method name ${JSON.stringify(method)}`));
    }
    if (!Array.isArray(params)) return Promise.reject(new RpcError('RPC params must be an array'));

    const auth = this.readAuthHeader();
    if (!auth) return Promise.reject(new RpcError('the node has not written its RPC cookie yet', 'NO_COOKIE'));

    const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: this.nextId++, method, params }), 'utf8');

    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: this.host,
          port: this.port,
          path: '/',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': body.length,
            Authorization: auth
          },
          timeout: this.timeoutMs
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            if (res.statusCode === 401) return reject(new RpcError('the node rejected the RPC cookie', 'AUTH'));
            let parsed;
            try {
              parsed = JSON.parse(text);
            } catch {
              return reject(new RpcError(`the node returned non-JSON (HTTP ${res.statusCode})`, 'PARSE'));
            }
            if (parsed && parsed.error) {
              const msg = parsed.error.message || JSON.stringify(parsed.error);
              return reject(new RpcError(`${method}: ${redact(msg)}`, parsed.error.code));
            }
            resolve(parsed ? parsed.result : null);
          });
        }
      );
      req.on('timeout', () => { req.destroy(new RpcError(`${method} timed out`, 'TIMEOUT')); });
      req.on('error', (e) => reject(new RpcError(`${method}: ${redact(e.message)}`, e.code || 'NET')));
      req.end(body);
    });
  }

  // ---- the handful of calls this app makes ----
  getBlockchainInfo() { return this.call('getblockchaininfo'); }
  getInfo() { return this.call('getinfo'); }
  getMiningInfo() { return this.call('getmininginfo'); }
  getPeerInfo() { return this.call('getpeerinfo'); }
  getNetworkSolps() { return this.call('getnetworksolps'); }
  getBlockCount() { return this.call('getblockcount'); }
  getBlockHash(height) { return this.call('getblockhash', [height]); }
  getBlock(hashOrHeight, verbosity) { return this.call('getblock', [String(hashOrHeight), verbosity]); }
  getBlockSubsidy(height) { return this.call('getblocksubsidy', [height]); }
  getRawTransaction(txid, verbose) { return this.call('getrawtransaction', [txid, verbose]); }
  validateAddress(addr) { return this.call('validateaddress', [addr]); }
  zValidateAddress(addr) { return this.call('z_validateaddress', [addr]); }
  zListUnifiedReceivers(addr) { return this.call('z_listunifiedreceivers', [addr]); }
  submitBlock(hex) { return this.call('submitblock', [hex]); }
}

module.exports = { ZebraRpc, RpcError, redact, COOKIE_FILE };
