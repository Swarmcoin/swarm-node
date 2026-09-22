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
