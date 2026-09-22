// Why the node is not running, in words a person can act on.
//
// WHAT HAPPENED, 2026-09-22 (N-8). The owner installed 0.2.0-testnet.3 over
// 0.2.0-testnet.2. The OLD version's daemon was still running - it had been up
// since 12:36 and nothing had stopped it - and it still held the chain
// database. The new daemon started, found the database locked, and died:
//
//   Database likely already open C:/…/chain/state\state\v28\swarmtestnet
//   Hint: Check if another zebrad process is running
//
// The app showed a spinner for ever. Two separate failures produced that:
// nothing noticed the foreign node, and nothing showed the daemon's own
// explanation of why it had exited. This file fixes the second and detects
// the first.
//
// Nothing here guesses. `explainExit` only recognises messages the daemon
// actually printed, and falls back to the daemon's own first line rather than
// inventing a cause. `findForeignNode` reports a process it can see, with its
// id, or reports nothing.

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

/** The record this app keeps of the daemon it started. */
const RECORD = 'node.pid.json';

/**
 * Known daemon failures, translated. Each pattern is one this daemon really
 * prints; `action` is what the app should offer, and the UI decides how.
 */
const KNOWN = [
  {
    test: /Database likely already open|LOCK: Resource temporarily unavailable|already held by process/i,
    action: 'stop-foreign-node',
    text: 'Another SWARM node is already using this chain folder, so this one could not open it. '
      + 'That is almost always an older version of SWARM Node still running in the background.'
  },
  {
    test: /Only one usage of each socket address|EADDRINUSE|AddrInUse|address already in use/i,
    action: 'stop-foreign-node',
    text: 'Another program is already using the port this node needs. '
      + 'That is almost always an older version of SWARM Node still running in the background.'
  },
  {
    test: /No space left on device|not enough space/i,
    action: 'choose-folder',
    text: 'The disk holding the chain folder is full. Free some space, or move the chain folder.'
  },
  {
    test: /Permission denied|Access is denied|os error 5/i,
    action: 'choose-folder',
    text: 'The node was not allowed to write to its chain folder. Choose a folder you own.'
  }
];

/**
 * Read the daemon's own last words.
 *
 * @param {string} logDir  where <base>.err.log lives
 * @param {string} base    log file stem, normally "node"
 * @returns {{text: string, action: string|null, raw: string}|null}
 */
function explainExit(logDir, base = 'node') {
  let raw = '';
  try {
    raw = fs.readFileSync(path.join(logDir, `${base}.err.log`), 'utf8');
  } catch {
    return null;
  }
  if (!raw.trim()) return null;

  // Keep only the tail: a restart appends, and the interesting part is the end.
  const lines = raw.replace(/\r/g, '').split('\n').map((l) => l.trim()).filter(Boolean);
  const tail = lines.slice(-40);

  for (const k of KNOWN) {
    const hit = tail.find((l) => k.test.test(l));
    if (hit) return { text: k.text, action: k.action, raw: hit.slice(0, 400) };
  }

  // Nothing recognised. Show the daemon's own first complaint rather than a
  // guess - the banner lines it prints on every start are not complaints.
  const noise = /^Thank you for running|^You're helping|^$/i;
  const first = tail.find((l) => !noise.test(l) && /panic|error|fatal|failed|refus/i.test(l));
  if (first) return { text: `The node stopped and said: ${first.slice(0, 300)}`, action: null, raw: first.slice(0, 400) };
  return null;
}

/** Is that process id alive? */
function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/** Remember the daemon we started, so a later run can recognise a leftover. */
function writeRecord(dataDir, info) {
  try {
    fs.writeFileSync(path.join(dataDir, RECORD), JSON.stringify({
      pid: info.pid,
      startedAt: info.startedAt || Date.now(),
      appPid: process.pid,
      configPath: info.configPath || null
    }, null, 2));
  } catch { /* a read-only profile must not stop the node starting */ }
}

function clearRecord(dataDir) {
  try { fs.unlinkSync(path.join(dataDir, RECORD)); } catch { /* already gone */ }
}

function readRecord(dataDir) {
  try {
    const r = JSON.parse(fs.readFileSync(path.join(dataDir, RECORD), 'utf8'));
    return Number.isInteger(r.pid) ? r : null;
  } catch {
    return null;
  }
}

/**
 * The programs a SWARM node is ever called: the name it ships under now, and
 * the upstream name earlier versions used.
 */
const NODE_IMAGES = [/(^|[\\/])swarm-node-daemon(\.exe)?$/i, /(^|[\\/])zebrad(\.exe)?$/i];

/**
 * Nodes whose command line mentions `needle`, excluding this process.
 *
 * It matches on the EXECUTABLE as well as the folder, for two reasons. The
 * obvious one is that a text editor with that path open is not a node. The
 * one that actually bit: on Windows this scan runs PowerShell with the folder
 * name inside its own command line, so matching command lines alone made the
 * scan find itself, every single time.
 *
 * Returns [] when it cannot tell, which is treated as "nothing found" rather
 * than as an accusation.
 */
function pidsUsing(needle) {
  const want = String(needle || '');
  if (!want) return [];
  const isNode = (image) => NODE_IMAGES.some((re) => re.test(String(image || '').trim()));
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command',
        "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine -like '*"
        + want.replace(/'/g, "''") + "*' } | ForEach-Object { \"$($_.ProcessId)|$($_.ExecutablePath)\" }"
      ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000 });
      return out.split(/\r?\n/)
        .map((l) => l.split('|'))
        .filter((f) => f.length >= 2 && isNode(f.slice(1).join('|')))
        .map((f) => Number(f[0].trim()))
        .filter((n) => Number.isInteger(n) && n > 0 && n !== process.pid);
    }
    const out = execFileSync('/bin/sh', ['-c', 'ps -Ao pid=,args='], { encoding: 'utf8', timeout: 15000 });
    return out.split('\n')
      .filter((l) => l.includes(want) && isNode(l.trim().split(/\s+/)[1]))
      .map((l) => Number(l.trim().split(/\s+/)[0]))
      .filter((n) => Number.isInteger(n) && n > 0 && n !== process.pid);
  } catch {
    return [];
  }
}

/**
 * Is somebody else's node holding this chain folder?
 *
 * Two independent ways of telling, because either can be blind: the record
 * this app writes when it starts a daemon, and a scan of running command
 * lines for the folder. A process THIS engine started is not foreign, so the
 * caller passes the pid it owns.
 *
 * @param {string} dataDir
 * @param {number|null} ourPid  the daemon this engine started, if any
 * @returns {{pid:number, source:string, since:number|null}|null}
 */
function findForeignNode(dataDir, ourPid = null) {
  const record = readRecord(dataDir);
  if (record && record.pid !== ourPid && alive(record.pid)) {
    return { pid: record.pid, source: 'this app started it and never stopped it', since: record.startedAt || null };
  }
  for (const pid of pidsUsing(dataDir)) {
    if (pid === ourPid) continue;
    return { pid, source: 'a program is using this chain folder', since: null };
  }
  return null;
}

/** End a foreign node. Only ever called with a pid findForeignNode returned. */
function stopNodeProcess(pid) {
  if (!alive(pid)) return { ok: true, alreadyGone: true };
  try {
    if (process.platform === 'win32') execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(pid, 'SIGTERM');
  } catch (e) {
    return { ok: false, error: e.message };
  }
  return { ok: !alive(pid), pid };
}

module.exports = {
  explainExit, findForeignNode, stopNodeProcess,
  writeRecord, clearRecord, readRecord, pidsUsing, alive,
  RECORD, KNOWN
};
