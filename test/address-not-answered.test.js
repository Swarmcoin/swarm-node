// A valid address must never be blamed for the node's silence.
//
// WHAT HAPPENED, 2026-09-22. The owner pasted a good unified address, copied
// from a synced SWARM Wallet, into Settings while the node was stopped, and
// was told: "The node does not recognise that address on this network. Check
// you copied it from a SWARM Wallet set to the same network."
//
// The address was perfect. A real node, asked directly, answers
// isvalid: true, address_type: "unified", with an orchard receiver. What had
// happened is that the node never answered at all: validateWithNode mapped
// only three transport error codes to "the node is not answering", and every
// other failure - a rejected cookie, a timeout, a method the node does not
// implement, an unreadable reply - fell through to a sentence that ASSERTS
// the node rejected the address.
//
// These tests use that exact address. It is a public testnet receive address;
// nothing secret is involved, and no key exists for it in this repository.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ZebraRpc } = require('../electron/chain/rpc');
const { validateWithNode } = require('../electron/chain/address');

// The owner's address, from the SWARM Wallet 0.1.0-testnet.4 Receive page.
const OWNER_UA =
  'utest1ve9q2phl7hgu95nxg96d75v5hltu7wh4u2kpcz0t7dm2x7x8tns7hecem8m67e9uzruj2py7tu0s4sa5m59qcgw7936n3su40s9hrefr';

/** A cookie directory, with or without a cookie in it. */
function cookieDir(withCookie) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-addr-'));
  if (withCookie) fs.writeFileSync(path.join(d, '.cookie'), '__cookie__:stale-from-a-dead-node');
  return d;
}

/** A fake node on loopback. `handler` decides what it says. */
async function fakeNode(handler) {
  const srv = http.createServer(handler);
  const port = await new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
  return { port, close: () => new Promise((r) => srv.close(r)) };
}

const rpcFor = (port, dir) => new ZebraRpc({ host: '127.0.0.1', port, cookieDir: dir, timeoutMs: 1500 });

/** Answers RPC calls from a table of method -> result. */
const answering = (table) => (q, s) => {
  let body = '';
  q.on('data', (c) => { body += c; });
  q.on('end', () => {
    let method = '';
    try { method = JSON.parse(body).method; } catch { /* malformed */ }
    s.writeHead(200, { 'content-type': 'application/json' });
    if (Object.prototype.hasOwnProperty.call(table, method)) {
      return s.end(JSON.stringify({ result: table[method], error: null, id: 1 }));
    }
    s.end(JSON.stringify({ result: null, error: { code: -32601, message: 'Method not found' }, id: 1 }));
  });
};

test('a real node accepts the address, and the app reports it as unified', async () => {
  const node = await fakeNode(answering({
    validateaddress: { isvalid: false },
    // Exactly what the bundled node answered when asked this address.
    z_validateaddress: { isvalid: true, address: OWNER_UA, address_type: 'unified', ismine: false },
    z_listunifiedreceivers: { orchard: OWNER_UA }
  }));
  try {
    const r = await validateWithNode(rpcFor(node.port, cookieDir(true)), OWNER_UA);
    assert.equal(r.ok, true);
    assert.equal(r.kind, 'unified');
    assert.equal(r.confirmed, true);
    assert.deepEqual(r.modes, ['shielded']);
    assert.match(r.detail, /orchard/);
  } finally { await node.close(); }
});

test('the node being stopped never blames the address', async () => {
  // Nothing listening, but a cookie left behind by a node that has exited.
  const rpc = rpcFor(1, cookieDir(true));            // port 1: refused
  const r = await validateWithNode(rpc, OWNER_UA);
  assert.equal(r.ok, true, 'a well-formed address is usable while the node is down');
  assert.equal(r.kind, 'unified');
  assert.equal(r.confirmed, false, 'but it is not claimed to be confirmed');
  assert.match(r.note, /Start the node to confirm/);
  assert.ok(!/does not recognise/.test(JSON.stringify(r)), 'the address is never blamed');
});

test('no cookie yet is the same: not the address’s fault', async () => {
  const r = await validateWithNode(rpcFor(1, cookieDir(false)), OWNER_UA);
  assert.equal(r.ok, true);
  assert.equal(r.confirmed, false);
  assert.match(r.note, /not running/);
});

test('a stale cookie against another node on the port is named for what it is', async () => {
  // This is the case the owner hit: the harness node had died on a port
  // conflict, leaving its cookie behind, while another node held the port.
  const node = await fakeNode((q, s) => { s.writeHead(401); s.end('unauthorized'); });
  try {
    const r = await validateWithNode(rpcFor(node.port, cookieDir(true)), OWNER_UA);
    assert.equal(r.ok, true);
    assert.equal(r.confirmed, false);
    assert.match(r.note, /control port/);
    assert.ok(!/does not recognise/.test(JSON.stringify(r)));
  } finally { await node.close(); }
});

test('a node that does not implement the shielded call is not an accusation', async () => {
  const node = await fakeNode(answering({ validateaddress: { isvalid: false } }));  // z_* -> method not found
  try {
    const r = await validateWithNode(rpcFor(node.port, cookieDir(true)), OWNER_UA);
    assert.equal(r.ok, true);
    assert.equal(r.confirmed, false);
    assert.ok(!/does not recognise/.test(JSON.stringify(r)));
  } finally { await node.close(); }
});

test('a node that never replies is not an accusation either', async () => {
  const node = await fakeNode(() => { /* silence */ });
  try {
    const r = await validateWithNode(rpcFor(node.port, cookieDir(true)), OWNER_UA);
    assert.equal(r.ok, true);
    assert.equal(r.confirmed, false);
    assert.match(r.note, /in time/);
  } finally { await node.close(); }
});

test('when the node really does say no, the app says so - and only then', async () => {
  const node = await fakeNode(answering({
    validateaddress: { isvalid: false },
    z_validateaddress: { isvalid: false }
  }));
  try {
    const r = await validateWithNode(rpcFor(node.port, cookieDir(true)), OWNER_UA);
    assert.equal(r.ok, false);
    assert.equal(r.confirmed, false);
    assert.match(r.error, /does not recognise that address/);
  } finally { await node.close(); }
});

test('a malformed address with the node down blames the shape, and says why it could not be checked', async () => {
  const r = await validateWithNode(rpcFor(1, cookieDir(true)), 'u1thisisamainnetaddressnotatestnetone0234567');
  assert.equal(r.ok, false);
  assert.match(r.error, /mainnet/);
  assert.match(r.error, /could not be checked/);
});

test('the transparent case still works offline', async () => {
  const r = await validateWithNode(rpcFor(1, cookieDir(true)), 't2Li46A4YNFqRDvdKA212w7DtsLkbGMG2xU');
  assert.equal(r.ok, true);
  assert.equal(r.kind, 'transparent');
  assert.deepEqual(r.modes, ['standard']);
  assert.equal(r.confirmed, false);
});
