'use strict';

// N-4: the machine check told the owner "Port 18233 for other nodes: CHECK —
// not usable: another program already uses this port". The other program was
// the app's own node, started one screen earlier. And if the port really is
// taken, refusing to start would be the wrong answer: a node with only
// outbound connections still syncs and still mines.

const test = require('node:test');
const assert = require('node:assert');
const net = require('net');
const { machineCheck, canBindPort, freeEphemeralPort } = require('../electron/chain/hardware');

test('the app does not report its own node as a port conflict', async () => {
  const report = await machineCheck({ dataDir: process.cwd(), p2pPort: 18233, ownNodeRunning: true, ownNodePort: 18233 });
  const port = report.checks.find((c) => c.key === 'port');
  assert.strictEqual(port.result, 'pass');
  assert.match(port.found, /your own node/);
});

test('a port genuinely held by something else is a warning, not a refusal', async () => {
  const srv = net.createServer();
  const port = await new Promise((resolve) => { srv.listen(0, '0.0.0.0', () => resolve(srv.address().port)); });
  try {
    const report = await machineCheck({ dataDir: process.cwd(), p2pPort: port, ownNodeRunning: false });
    const check = report.checks.find((c) => c.key === 'port');
    assert.strictEqual(check.result, 'warn', 'a busy port must never be a hard failure');
    assert.match(check.found, /still run and mine/);
    assert.strictEqual(report.canRunNode, true, 'a busy port must not stop the node from running');
  } finally {
    await new Promise((r) => srv.close(r));
  }
});

test('canBindPort tells a free port from a busy one', async () => {
  const srv = net.createServer();
  const port = await new Promise((resolve) => { srv.listen(0, '0.0.0.0', () => resolve(srv.address().port)); });
  try {
    const busy = await canBindPort(port);
    assert.strictEqual(busy.ok, false);
    assert.match(busy.detail, /another program/);
  } finally {
    await new Promise((r) => srv.close(r));
  }
  const free = await freeEphemeralPort();
  assert.ok(Number.isInteger(free) && free > 0, 'the operating system should offer a free port');
  assert.strictEqual((await canBindPort(free)).ok, true);
});

// The RPC port had no fallback, and that killed a node.
//
// The P2P port got one in testnet.2. The node's private control port did not,
// so a second copy of the app on one machine died on start with a Rust panic
// the user could do nothing with:
//   server should start: Os { code: 10048, kind: AddrInUse }
// Nothing connects IN to that port - 127.0.0.1, cookie-protected, and only
// this app talks to it - so moving it costs nothing.
test('the node moves its control port rather than dying on it', async () => {
  const { ChainEngine } = require('../electron/chain/engine');
  const srv = net.createServer();
  const taken = await new Promise((resolve) => { srv.listen(0, '127.0.0.1', () => resolve(srv.address().port)); });
  try {
    const e = new ChainEngine({
      manifest: require('../electron/net/network.json'),
      dataDir: process.cwd(),
      settings: { rpcPort: taken, payoutAddress: '' },
      saveSettings: () => {}
    });
    assert.equal(e.rpcPort, taken, 'it starts on the port it was asked for');
    const r = await e.chooseRpcPort();
    assert.equal(r.moved, true, 'a taken control port must not be fatal');
    assert.notEqual(r.port, taken);
    assert.equal(e.rpcPort, r.port);
    assert.equal(e.rpc.port, r.port, 'the client has to follow the server');
    assert.ok(e.rpcMoved && e.rpcMoved.wanted === taken, 'and the move is reported to the user');
    assert.equal(e.getState().node.rpcMoved.chosen, r.port);
  } finally {
    await new Promise((r) => srv.close(r));
  }
});

test('a free control port is left exactly where it was', async () => {
  const { ChainEngine } = require('../electron/chain/engine');
  const free = await freeEphemeralPort();
  const e = new ChainEngine({
    manifest: require('../electron/net/network.json'),
    dataDir: process.cwd(),
    settings: { rpcPort: free, payoutAddress: '' },
    saveSettings: () => {}
  });
  const r = await e.chooseRpcPort();
  assert.equal(r.moved, false);
  assert.equal(r.port, free);
  assert.equal(e.rpcMoved, null);
});
