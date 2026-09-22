// A second opinion on how high the chain is.
//
// WHY THIS EXISTS — defect N-1, 2026-09-21.
// The owner opened SWARM Node while their own node was at block 86, which WAS
// the network tip, and Start mining was greyed out with "still downloading".
// The gate was guessing from tip age, and on this chain that guess is wrong:
// block spacing averages 60-90 s but the process is Poisson, so gaps of three
// to five minutes are ordinary. Any rule of the form "the newest block must be
// young" holds back a perfectly synced node, and flaps.
//
// Zebra cannot help: getpeerinfo carries no peer height, and
// getblockchaininfo.estimatedheight is extrapolated from this node's own tip
// (zebra-chain/src/chain_tip.rs), so it is tip age wearing a hat.
//
// The project already runs something that DOES know: the public wallet server,
// which serves GetLightdInfo over gRPC and reports blockHeight. Asking it is a
// genuine second opinion — a different machine, a different codebase, the same
// chain. This module asks it, over TLS, from the MAIN process only, and treats
// the answer as a hint that can be absent, stale or wrong without breaking
// anything.
//
// It is never authoritative on its own. The gate combines it with "do I have a
// peer", and when it cannot be reached the gate says so and falls back to a
// rule the user can read.

'use strict';

const http2 = require('http2');
const { URL } = require('url');

// GetLightdInfo takes an empty protobuf message and returns LightdInfo, whose
// field 9 is blockHeight (varint). We speak just enough gRPC to ask that one
// question: a 5-byte length-prefixed frame containing an empty message.
const GRPC_PATH = '/cash.z.wallet.sdk.rpc.CompactTxStreamer/GetLightdInfo';
const EMPTY_MESSAGE = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x00]); // uncompressed, length 0

/** Read a protobuf varint at `offset`. Returns [value, nextOffset]. */
function readVarint(buf, offset) {
  let result = 0n;
  let shift = 0n;
  let i = offset;
  while (i < buf.length) {
    const b = buf[i];
    i += 1;
    result |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) return [result, i];
    shift += 7n;
    if (shift > 63n) break;
  }
  return [null, i];
}

/**
 * Pull one field out of a protobuf message without a schema.
 * Only the wire types LightdInfo actually uses are handled.
 */
function findField(buf, wanted) {
  let i = 0;
  while (i < buf.length) {
    const [key, afterKey] = readVarint(buf, i);
    if (key === null) return null;
    const field = Number(key >> 3n);
    const wire = Number(key & 7n);
    i = afterKey;
    if (wire === 0) {
      const [v, next] = readVarint(buf, i);
      if (v === null) return null;
      i = next;
      if (field === wanted) return v;
    } else if (wire === 2) {
      const [len, next] = readVarint(buf, i);
      if (len === null) return null;
      const start = next;
      const end = start + Number(len);
      if (end > buf.length) return null;
      i = end;
      if (field === wanted) return buf.subarray(start, end);
    } else if (wire === 5) {
      i += 4;
    } else if (wire === 1) {
      i += 8;
    } else {
      return null;
    }
  }
  return null;
}

class TipOracle {
  /**
   * @param {object} cfg
   *   url        {string} https://host:port of the wallet server
   *   timeoutMs  {number}
   *   minIntervalMs {number} never ask more often than this
   */
  constructor(cfg = {}) {
    this.url = cfg.url || null;
    this.timeoutMs = Number(cfg.timeoutMs) || 8000;
    this.minIntervalMs = Number(cfg.minIntervalMs) || 20000;
    this.lastAskedAt = 0;
    this.inFlight = null;
    /** @type {{height:number, at:number}|null} last good answer */
    this.last = null;
    this.lastError = null;
    this.consecutiveFailures = 0;
  }

  get available() { return !!this.url; }

  /** The freshest answer, or null. Ages out after five minutes. */
  current(nowMs = Date.now()) {
    if (!this.last) return null;
    if (nowMs - this.last.at > 300000) return null;
    return this.last;
  }

  /** Ask, at most every minIntervalMs. Never throws. */
  async refresh() {
    if (!this.url) return null;
    const now = Date.now();
    if (this.inFlight) return this.inFlight;
    if (now - this.lastAskedAt < this.minIntervalMs) return this.current();
    this.lastAskedAt = now;
    this.inFlight = this.ask()
      .then((height) => {
        if (Number.isInteger(height) && height >= 0) {
          this.last = { height, at: Date.now() };
          this.lastError = null;
          this.consecutiveFailures = 0;
        }
        return this.last;
      })
      .catch((e) => {
        this.consecutiveFailures += 1;
        this.lastError = e.message;
        return this.current();
      })
      .finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  ask() {
    return new Promise((resolve, reject) => {
      let u;
      try { u = new URL(this.url); } catch { return reject(new Error('bad wallet-server URL')); }
      if (u.protocol !== 'https:') return reject(new Error('the wallet server must be https'));

      const session = http2.connect(u.origin, { rejectUnauthorized: true });
      const done = (err, value) => {
        try { session.close(); } catch { /* already closing */ }
        if (err) reject(err); else resolve(value);
      };
      const timer = setTimeout(() => { try { session.destroy(); } catch {} done(new Error('the wallet server did not answer in time')); }, this.timeoutMs);

      session.on('error', (e) => { clearTimeout(timer); done(new Error(e.message)); });

      const req = session.request({
        ':method': 'POST',
        ':path': GRPC_PATH,
        'content-type': 'application/grpc',
        te: 'trailers'
      });
      const chunks = [];
      let grpcStatus = null;
      req.on('response', (h) => { if (h['grpc-status'] != null) grpcStatus = String(h['grpc-status']); });
      req.on('trailers', (h) => { if (h['grpc-status'] != null) grpcStatus = String(h['grpc-status']); });
      req.on('data', (c) => chunks.push(c));
      req.on('error', (e) => { clearTimeout(timer); done(new Error(e.message)); });
      req.on('end', () => {
        clearTimeout(timer);
        if (grpcStatus && grpcStatus !== '0') return done(new Error(`wallet server returned grpc-status ${grpcStatus}`));
        const body = Buffer.concat(chunks);
        if (body.length < 5) return done(new Error('the wallet server sent an empty answer'));
        // 1 byte compression flag + 4 byte big-endian length, then the message.
        const len = body.readUInt32BE(1);
        const msg = body.subarray(5, 5 + len);
        const height = findField(msg, 9);   // LightdInfo.blockHeight
        if (typeof height !== 'bigint') return done(new Error('the wallet server sent no block height'));
        const n = Number(height);
        if (!Number.isSafeInteger(n) || n < 0 || n > 100000000) return done(new Error('the wallet server sent an implausible height'));
        done(null, n);
      });
      req.end(EMPTY_MESSAGE);
    });
  }
}

module.exports = { TipOracle, findField, readVarint, GRPC_PATH };
