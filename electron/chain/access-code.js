// The access code: one string that lets this computer join SWARM's closed start.
//
// WHY. During the closed start (from the relaunch of 2 October 2026 until the
// date in the embedded network definition) the SWARM server node accepts
// peers only inside a private WireGuard tunnel. The owner's words were: "add
// that I need to add to the node application a code". So each machine gets
// ONE string from the SWARM team, pasted once; it carries that machine's
// tunnel key, and the app runs the tunnel itself (electron/chain/tunnel.js).
// Nothing else is installed and nothing needs administrator rights.
//
// FORMAT (the operator tool scripts/swarm/closed/make_access_code.py in the
// project repository writes it, and its tests are the other half of these):
//
//   SWARMKEY1.<base64url, no padding, of compact UTF-8 JSON>.<checksum>
//   JSON     {"v":1,"n":name,"k":private key,"a":tunnel address,
//             "s":server public key,"e":endpoint host:port,"p":server node ip:port}
//   checksum first 8 hex characters of SHA-256 over the ASCII base64url part
//
// The checksum only catches typos. The code is a SECRET (its private key lets
// whoever holds it join as this machine), so this module never logs it, never
// returns the key to the renderer, and its describe() names the machine only.

'use strict';

const crypto = require('crypto');
const net = require('net');

const PREFIX = 'SWARMKEY1.';
const FIELDS = Object.freeze(['v', 'n', 'k', 'a', 's', 'e', 'p']);
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,39}$/;
const KEY_RE = /^[A-Za-z0-9+/]{43}=$/;
const HOST_RE = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;

class AccessCodeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AccessCodeError';
  }
}

const fail = (m) => { throw new AccessCodeError(m); };

function checkKey(value, what) {
  if (typeof value !== 'string' || !KEY_RE.test(value)) fail(`The ${what} in this code is not a WireGuard key.`);
  if (Buffer.from(value, 'base64').length !== 32) fail(`The ${what} in this code is not 32 bytes long.`);
  return value;
}

function checkIpv4(value, what) {
  // net.isIPv4 accepts only dotted quads; the round trip refuses leading zeros.
  if (typeof value !== 'string' || !net.isIPv4(value)) fail(`The ${what} in this code is not an IPv4 address.`);
  const parts = value.split('.').map(Number);
  if (parts.join('.') !== value) fail(`The ${what} in this code is not an IPv4 address.`);
  if (value === '0.0.0.0' || parts[0] === 127 || parts[0] >= 224) fail(`The ${what} in this code is not usable.`);
  return value;
}

function checkPort(text, what) {
  if (!/^[0-9]{1,5}$/.test(text || '')) fail(`The ${what} in this code has no port.`);
  const n = Number(text);
  if (n < 1 || n > 65535) fail(`The ${what} in this code has a port out of range.`);
  return n;
}

function checkHostPort(value, what, ipOnly) {
  if (typeof value !== 'string' || value.split(':').length !== 2) fail(`The ${what} in this code is not host:port.`);
  const [host, port] = value.split(':');
  checkPort(port, what);
  if (ipOnly || /^[0-9.]+$/.test(host)) checkIpv4(host, what);
  else if (!HOST_RE.test(host)) fail(`The ${what} in this code is not a valid host name.`);
  return { host, port: Number(port) };
}

/** Every field present, nothing extra, each strictly shaped. */
function checkPayload(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) fail('This access code is damaged.');
  const keys = Object.keys(d).sort();
  if (keys.length !== FIELDS.length || keys.join() !== [...FIELDS].sort().join()) {
    fail('This access code does not have the fields SWARM Node expects.');
  }
  if (d.v !== 1) fail('This access code is for a different version of SWARM Node.');
  if (typeof d.n !== 'string' || !NAME_RE.test(d.n)) fail('The machine name in this code is not valid.');
  checkKey(d.k, 'tunnel key');
  checkKey(d.s, 'server key');
  if (d.k === d.s) fail('This access code is damaged.');
  checkIpv4(d.a, 'tunnel address');
  const endpoint = checkHostPort(d.e, 'server address', false);
  const node = checkHostPort(d.p, 'server node', true);
  if (node.host === d.a) fail('This access code is damaged.');
  return {
    version: 1,
    name: d.n,
    privateKey: d.k,
    tunnelAddress: d.a,
    serverPublicKey: d.s,
    endpoint: d.e,
    endpointHost: endpoint.host,
    endpointPort: endpoint.port,
    node: d.p,
    nodeHost: node.host,
    nodePort: node.port
  };
}

const checksum = (body) => crypto.createHash('sha256').update(body, 'ascii').digest('hex').slice(0, 8);

/**
 * Read a pasted code. Whitespace anywhere (a code wrapped by an email client)
 * is ignored; everything else must be exact.
 * @returns {{ok:true, code:string, payload:object} | {ok:false, error:string}}
 */
function parse(raw) {
  try {
    if (typeof raw !== 'string') fail('Paste the access code you were given.');
    if (raw.length > 4000) fail('That is too long to be an access code.');
    const s = raw.replace(/\s+/g, '');
    if (!s) fail('Paste the access code you were given.');
    if (!s.startsWith(PREFIX)) fail('That is not a SWARM access code. It starts with SWARMKEY1.');
    const rest = s.slice(PREFIX.length).split('.');
    if (rest.length !== 2) fail('This access code is incomplete. Copy all of it, including the end.');
    const [body, check] = rest;
    if (!/^[A-Za-z0-9_-]{40,2000}$/.test(body) || !/^[0-9a-f]{8}$/.test(check)) fail('This access code is damaged.');
    if (checksum(body) !== check) fail('This access code has a typo. Copy it again, all of it.');
    let payload;
    try {
      payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    } catch {
      fail('This access code is damaged.');
    }
    return { ok: true, code: s, payload: checkPayload(payload) };
  } catch (e) {
    if (e instanceof AccessCodeError) return { ok: false, error: e.message };
    return { ok: false, error: 'This access code could not be read.' };
  }
}

/** For tests and tools: the inverse of parse(). */
function encode(d) {
  checkPayload(d);
  const ordered = {};
  for (const f of FIELDS) ordered[f] = d[f];
  const body = Buffer.from(JSON.stringify(ordered), 'utf8').toString('base64url');
  return `${PREFIX}${body}.${checksum(body)}`;
}

/** What may be shown and logged about a code: never the key, never the code. */
function describe(payload) {
  if (!payload) return null;
  return {
    machine: payload.name,
    tunnelAddress: payload.tunnelAddress,
    server: payload.endpointHost,
    node: payload.node
  };
}

module.exports = { parse, encode, describe, checkPayload, checksum, AccessCodeError, PREFIX, FIELDS };
