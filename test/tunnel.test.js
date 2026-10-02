'use strict';

// The tunnel supervisor (electron/chain/tunnel.js), driven against a stub of
// the forwarder (fixtures/stub-onetun.js) that prints what onetun prints and
// opens no socket. What must hold:
//   * the key reaches the forwarder through its environment, never its
//     command line; the listener is 127.0.0.1;
//   * "connected" means a handshake was seen, and a stalled handshake says so;
//   * a forwarder that exits is started again; a taken port moves to another;
//   * stop() leaves nothing running and nothing restarting.

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const T = require('../electron/chain/tunnel');
const AC = require('../electron/chain/access-code');

const STUB = path.join(__dirname, 'fixtures', 'stub-onetun.js');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function payload() {
  const code = AC.encode({
    v: 1, n: 'alienware', k: crypto.randomBytes(32).toString('base64'), a: '10.88.0.3',
    s: crypto.randomBytes(32).toString('base64'), e: '64.95.11.180:51820', p: '10.88.0.1:28233'
  });
  return AC.parse(code).payload;
}

function forwarder(mode, extra = {}) {
  const report = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-tun-')), 'report.jsonl');
  const p = payload();
  const ports = [];
  const f = new T.TunnelForwarder({
    payload: p,
    binary: () => ({ ok: true, path: STUB }),
    choosePort: async (attempt) => { const port = 28243 + attempt; ports.push(port); return port; },
    // Run the stub with this Node, passing the forwarder's own env through.
    spawnImpl: (bin, args, opts) => spawn(process.execPath, [bin, ...args], {
      ...opts, env: { ...opts.env, STUB_MODE: mode, STUB_REPORT: report }
    }),
    backoffMs: [100, 200],
    readyTimeoutMs: 4000,
    bindGraceMs: 150,
    ...extra
  });
  const logs = [];
  f.on('log', (e) => logs.push(e.text));
  return { f, p, report, ports, logs };
}

const reports = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);

test('the command line: loopback listener, tunnel address, no key', () => {
  const p = payload();
  const args = T.buildArgs(p, 28243);
  assert.equal(args[0], '127.0.0.1:28243:10.88.0.1:28233:TCP');
  assert.deepEqual(args.slice(1, 9), [
    '--endpoint-addr', '64.95.11.180:51820',
    '--endpoint-public-key', p.serverPublicKey,
    '--source-peer-ip', '10.88.0.3',
    '--keep-alive', '25'
  ]);
  assert.ok(!args.join(' ').includes(p.privateKey));
  assert.ok(!args.some((a) => /private-key/.test(a)));
  const env = T.buildEnv(p, { PATH: 'x', ONETUN_PRIVATE_KEY_FILE: '/tmp/k', onetun_log: 'trace' });
  assert.equal(env.ONETUN_PRIVATE_KEY, p.privateKey);
  assert.equal(env.PATH, 'x');
  assert.equal(env.ONETUN_PRIVATE_KEY_FILE, undefined, 'no other ONETUN_ setting survives');
  assert.equal(env.onetun_log, undefined);
});

test('starts, connects, and passes the key only through the environment', async () => {
  const { f, p, report, logs } = forwarder('ok');
  const r = await f.start();
  assert.equal(r.ok, true, r.error);
  assert.equal(r.localPort, 28243);
  await wait(300);
  const st = f.status();
  assert.equal(st.state, 'running');
  assert.equal(st.connected, true);
  assert.ok(st.handshakeAgeSec != null && st.handshakeAgeSec < 5);
  const seen = reports(report)[0];
  assert.equal(seen.hasKey, true);
  assert.equal(seen.key, p.privateKey);
  assert.ok(!seen.args.join(' ').includes(p.privateKey));
  // Nothing the app logged carries the key.
  assert.ok(!logs.join('\n').includes(p.privateKey));
  assert.ok(!JSON.stringify(f.status()).includes(p.privateKey));
  assert.ok(f.recent.every((l) => !l.includes(p.serverPublicKey)), 'key-shaped text is redacted from kept lines');
  await f.stop();
  assert.equal(f.status().state, 'stopped');
  assert.equal(f.child, null);
});

test('no handshake is reported as not connected', async () => {
  const { f } = forwarder('no-handshake');
  assert.equal((await f.start()).ok, true);
  await wait(300);
  assert.equal(f.status().connected, false);
  await f.stop();
});

test('a forwarder that exits is started again, with a wait', async () => {
  const { f, report, logs } = forwarder('exit-soon');
  assert.equal((await f.start()).ok, true);
  await wait(1500);
  assert.ok(reports(report).length >= 2, 'it was started again');
  assert.ok(f.restarts >= 1);
  assert.ok(logs.some((l) => /starting it again/.test(l)));
  await f.stop();
  const n = reports(report).length;
  await wait(600);
  assert.equal(reports(report).length, n, 'nothing restarts after stop()');
});

test('a port that cannot be bound moves to another', async () => {
  const { f, ports } = forwarder('bind-fail');
  const r = await f.start();
  assert.equal(r.ok, true, r.error);
  assert.equal(r.localPort, 28244);
  assert.deepEqual(ports, [28243, 28244]);
  await f.stop();
});

test('a code the forwarder refuses fails clearly and is retried later, not hammered', async () => {
  const { f, report } = forwarder('config-error');
  const r = await f.start();
  assert.equal(r.ok, false);
  assert.match(r.error, /refused|stopped at once/);
  assert.equal(f.status().state, 'restarting');
  await f.stop();
  const n = reports(report).length;
  await wait(400);
  assert.equal(reports(report).length, n);
});

test('no bundled forwarder: a clear reason, no crash', async () => {
  const f = new T.TunnelForwarder({
    payload: payload(),
    binary: () => ({ ok: false, reason: 'swarm-tunnel.exe is not bundled with this build' }),
    choosePort: async () => 28243
  });
  const r = await f.start();
  assert.equal(r.ok, false);
  assert.match(r.error, /not bundled/);
  await f.stop();
});

test('classifyLine and redact', () => {
  assert.equal(T.classifyLine(' INFO onetun::tunnel > Tunneling TCP [127.0.0.1:1]->[10.88.0.1:28233]'), 'listening');
  assert.equal(T.classifyLine('DEBUG boringtun::noise > New session session=7'), 'handshake');
  assert.equal(T.classifyLine('WARN boringtun::noise::timers > HANDSHAKE(REKEY_TIMEOUT)'), 'handshake-timeout');
  assert.equal(T.classifyLine('ERROR onetun > Port-forward failed for x : y'), 'bind-failed');
  assert.equal(T.classifyLine('anything else'), null);
  const k = crypto.randomBytes(32).toString('base64');
  assert.ok(!T.redact(`key ${k} here`).includes(k));
});
