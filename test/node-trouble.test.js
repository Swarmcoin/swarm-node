// N-8: the owner could not mine, and the app never said why.
//
// WHAT HAPPENED, 2026-09-22. The owner installed 0.2.0-testnet.3 over
// 0.2.0-testnet.2. The old version's window was gone but its daemon had been
// running since 12:36 and nothing had stopped it, so it still held the chain
// database. The new daemon started, found the database locked, printed
//
//   Database likely already open …/chain/state\state\v28\swarmtestnet
//   Hint: Check if another zebrad process is running
//
// and exited. The app showed the armed spinner for ever, and the node log the
// user could see kept filling with the OLD process's happy sync lines.
//
// Three failures, three sets of tests:
//   1. nothing stopped the old daemon when the app was replaced;
//   2. nothing noticed a foreign node holding the folder;
//   3. nothing put the daemon's own explanation on the screen.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const T = require('../electron/chain/node-trouble');
const { nextAction } = require('../electron/chain/next-action');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-trouble-'));
const withLog = (text) => {
  const d = tmp();
  fs.mkdirSync(path.join(d, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(d, 'logs', 'node.err.log'), text);
  return d;
};

// ---------------------------------------------------------------- 3. say why
test('the owner\u2019s exact panic becomes a sentence and an action', () => {
  const dir = withLog([
    'Thank you for running a swarmtestnet zebrad 6.3.0 node!',
    "You're helping to strengthen the network and contributing to a social good :)",
    '',
    'thread \'main\' panicked at zebrad/src/commands/start.rs:216:14:',
    'Opening database: Database likely already open '
      + 'C:/Users/o5o-o/AppData/Roaming/green.swarm.node/chain/state\\state\\v28\\swarmtestnet '
      + 'Hint: Check if another zebrad process is running'
  ].join('\n'));
  const why = T.explainExit(path.join(dir, 'logs'));
  assert.ok(why, 'the daemon said why, and it must be read');
  assert.equal(why.action, 'stop-foreign-node');
  assert.match(why.text, /Another SWARM node is already using this chain folder/);
  assert.ok(!/panicked|RocksDB|v28/.test(why.text), 'the SENTENCE is for a person');
  assert.match(why.raw, /Database likely already open/, 'the raw line is kept for diagnosis');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a port clash is recognised too, and points at the same cause', () => {
  const dir = withLog('Error: Only one usage of each socket address (protocol/network address/port) is normally permitted. (os error 10048)');
  const why = T.explainExit(path.join(dir, 'logs'));
  assert.equal(why.action, 'stop-foreign-node');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a full disk and a permission problem are not blamed on another node', () => {
  for (const [line, action] of [
    ['Error: No space left on device (os error 28)', 'choose-folder'],
    ['Error: Access is denied. (os error 5)', 'choose-folder']
  ]) {
    const dir = withLog(line);
    assert.equal(T.explainExit(path.join(dir, 'logs')).action, action);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an unrecognised failure quotes the daemon rather than inventing a cause', () => {
  const dir = withLog('Thank you for running a swarmtestnet zebrad 6.3.0 node!\nError: something nobody has seen before');
  const why = T.explainExit(path.join(dir, 'logs'));
  assert.equal(why.action, null, 'no action is offered for something not understood');
  assert.match(why.text, /something nobody has seen before/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a clean start says nothing, and neither does a missing log', () => {
  const dir = withLog('Thank you for running a swarmtestnet zebrad 6.3.0 node!\n');
  assert.equal(T.explainExit(path.join(dir, 'logs')), null);
  assert.equal(T.explainExit(path.join(tmp(), 'logs')), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------- 2. notice the leftover
test('a daemon this app started and never stopped is found again later', () => {
  const dir = tmp();
  // This process stands in for the leftover: it is alive, and its id is ours.
  T.writeRecord(dir, { pid: process.pid, startedAt: Date.now() - 3600_000 });
  const found = T.findForeignNode(dir, null);
  assert.ok(found, 'the record is the point of writing it');
  assert.equal(found.pid, process.pid);
  assert.match(found.source, /never stopped/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the daemon THIS engine owns is never called foreign', () => {
  const dir = tmp();
  T.writeRecord(dir, { pid: process.pid, startedAt: Date.now() });
  assert.equal(T.findForeignNode(dir, process.pid), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a record for a process that has gone is not an accusation', () => {
  const dir = tmp();
  // A pid that cannot be running: 2^22 is above every platform's maximum.
  T.writeRecord(dir, { pid: 4194303, startedAt: Date.now() });
  assert.equal(T.findForeignNode(dir, null), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a stopped node clears its own record', () => {
  const dir = tmp();
  T.writeRecord(dir, { pid: process.pid, startedAt: Date.now() });
  assert.ok(T.readRecord(dir));
  T.clearRecord(dir);
  assert.equal(T.readRecord(dir), null);
  T.clearRecord(dir);   // twice must not throw
  fs.rmSync(dir, { recursive: true, force: true });
});

// ------------------------------------------------- the screen, not a spinner
test('a stopped node with a reason shows the reason and a button, never a spinner', () => {
  const s = {
    mining: { on: false, mode: 'shielded', armed: true, workers: 0, standardAvailable: true },
    node: {
      running: false,
      trouble: {
        action: 'stop-foreign-node',
        text: 'A SWARM node from an earlier version is still running and is using this chain folder.',
        pid: 133428
      }
    },
    gate: { allow: false, message: 'The full node is not running yet.' },
    payout: { address: 'utest1ve9q2phl7hgu95nxg96d75v5hltu7wh4u2kpcz0t7dm2x7x8tns7hecem8m67e9uzruj2py7tu0s4sa5m59qcgw7936n3su40s9hrefr' }
  };
  const a = nextAction(s);
  assert.equal(a.id, 'stop-foreign-node', 'armed or not, the REASON wins');
  assert.equal(a.label, 'Stop it and continue');
  assert.match(a.why, /earlier version is still running/);
  assert.ok(!('disabled' in a));
});

test('a disk problem offers a folder, not a process to kill', () => {
  const a = nextAction({
    mining: { on: false, mode: 'standard', armed: false, standardAvailable: true },
    node: { running: false, trouble: { action: 'choose-folder', text: 'The disk holding the chain folder is full.' } },
    gate: { allow: false },
    payout: { address: 'tmEXAMPLEEXAMPLEEXAMPLEEXAMPLEEXAMP' }
  });
  assert.equal(a.id, 'choose-folder');
});

test('a node stopped for no known reason still offers a way forward', () => {
  const a = nextAction({
    mining: { on: false, mode: 'standard', armed: false, standardAvailable: true },
    node: { running: false, trouble: { action: null, text: 'The node stopped unexpectedly.' } },
    gate: { allow: false },
    payout: { address: 'tmEXAMPLEEXAMPLEEXAMPLEEXAMPLEEXAMP' }
  });
  assert.equal(a.id, 'start-node');
  assert.match(a.label, /again/);
});

// -------------------------------------------- 1. the installer stops the old
test('the installer stops what is running from the folder it replaces, and nothing else', () => {
  // Comments explain the mistake by quoting it, so read the CODE.
  const nsh = fs.readFileSync(path.join(__dirname, '..', 'build', 'installer.nsh'), 'utf8')
    .split(/\r?\n/).filter((l) => !/^\s*;/.test(l)).join('\n');
  assert.match(nsh, /!macro customInit/, 'nothing stopped the old version before its files were replaced');
  assert.match(nsh, /!macro customUnInit/, 'uninstalling must not leave a miner running');
  assert.match(nsh, /ExecutablePath[\s\S]{0,80}INSTDIR/, 'it must match on the install PATH');
  // The blunt version of this would kill a node the user started themselves.
  // This machine runs one, on other ports, deliberately.
  assert.ok(!/IM\s+"?zebrad\.exe/i.test(nsh), 'an installer must never kill every zebrad on the machine');
  assert.ok(!/IM\s+"?privacy-miner\.exe/i.test(nsh), 'nor every miner');
});

// The installer's actual command, run for real, against real processes.
//
// Running the NSIS installer itself in a test would install over whatever is
// on this machine, so what is exercised here is the ONE line inside it: the
// PowerShell that ends every process running from the folder being replaced.
// Two stand-ins are started from two different folders. The one inside the
// "install directory" must die; the one outside it must not, because on this
// very machine there is a node the owner started by hand and an installer
// that killed it would be worse than the problem it solves.
test('the installer\u2019s kill command ends only what runs from the install folder', { skip: process.platform !== 'win32' ? 'Windows only' : false }, async () => {
  const { execFileSync, spawn } = require('node:child_process');
  const nsh = fs.readFileSync(path.join(__dirname, '..', 'build', 'installer.nsh'), 'utf8');
  const m = /Get-CimInstance Win32_Process[^']*/.exec(nsh);
  assert.ok(m, 'the installer must carry a command that stops the old version');

  const inside = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-inst-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-other-'));
  const copyNode = (dir) => {
    const dest = path.join(dir, 'stand-in.exe');
    fs.copyFileSync(process.execPath, dest);
    return dest;
  };
  const a = copyNode(inside);
  const b = copyNode(outside);
  const live = (p) => spawn(p, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore' });
  const pa = live(a);
  const pb = live(b);
  await new Promise((r) => setTimeout(r, 2500));

  try {
    // The installer's own line, with $INSTDIR resolved and NSIS's $$ escaping
    // undone, exactly as NSIS would hand it to the shell.
    // The match runs to the NSIS single quote, so it carries the closing
    // double quote of PowerShell's -Command argument with it.
    const cmd = m[0]
      .replace(/"\s*$/, '')
      .replace(/\$\$/g, '$')
      .replace(/\\"/g, '"')
      .replace(/\$INSTDIR/g, inside);
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd],
      { stdio: 'ignore', timeout: 30000 });
    await new Promise((r) => setTimeout(r, 2000));

    const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
    assert.equal(alive(pa.pid), false, 'the old version, inside the folder being replaced, must be stopped');
    assert.equal(alive(pb.pid), true, 'a program outside that folder must be left alone');
  } finally {
    for (const p of [pa, pb]) { try { execFileSync('taskkill.exe', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ } }
    await new Promise((r) => setTimeout(r, 800));
    for (const d of [inside, outside]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* locked */ } }
  }
});
