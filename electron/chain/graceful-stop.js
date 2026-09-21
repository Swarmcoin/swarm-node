// Graceful shutdown of a console child process on Windows.
//
// The rule this module enforces: a hard kill is a LAST resort and is always
// reported. zebrad keeps a RocksDB state directory; killing it hard leaves the
// database to be recovered on the next start and, in the worst case, loses the
// non-finalized state it was about to write.
//
// Sequence:
//   1. send a real console Ctrl-C through the bundled helper;
//   2. wait for the process to exit, polling its own 'exit' event;
//   3. send one more Ctrl-C after a third of the budget, in case the first
//      arrived before the signal handler was installed;
//   4. only after the whole budget has elapsed, taskkill /F, and say so.

'use strict';

const path = require('path');
const { spawn, execFile } = require('child_process');

const DEFAULT_TIMEOUT_MS = 20000;

/** Resolve a path that must exist on disk even when the app is packed in an asar. */
function unpackedPath(p) {
  return p.includes('app.asar') ? p.replace('app.asar', 'app.asar.unpacked') : p;
}

function helperScriptPath() {
  return unpackedPath(path.join(__dirname, '..', 'resources', 'swarm-stop.ps1'));
}

/**
 * Generate a console Ctrl-C for `pid`.
 * @returns {Promise<{ok:boolean, code:number, detail:string}>}
 */
function sendCtrlC(pid, { timeoutMs = 8000 } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return Promise.resolve({ ok: false, code: -1, detail: 'no pid' });
  }
  if (process.platform !== 'win32') {
    // Everywhere else a plain SIGINT is the same signal zebrad listens for.
    try { process.kill(pid, 'SIGINT'); return Promise.resolve({ ok: true, code: 0, detail: 'SIGINT' }); }
    catch (e) { return Promise.resolve({ ok: false, code: -1, detail: e.message }); }
  }
  return new Promise((resolve) => {
    // Argument array, never a shell string.
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helperScriptPath(), '-ProcessId', String(pid)],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
    );
    let out = '';
    let done = false;
    const finish = (ok, code, detail) => { if (!done) { done = true; resolve({ ok, code, detail }); } };
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const t = setTimeout(() => { try { child.kill(); } catch {} finish(false, -1, 'helper timed out'); }, timeoutMs);
    child.on('error', (e) => { clearTimeout(t); finish(false, -1, e.message); });
    child.on('exit', (code) => { clearTimeout(t); finish(code === 0, code, out.trim().slice(0, 400)); });
  });
}

/** Hard kill, including the whole process tree. Only ever a fallback. */
function hardKill(pid) {
  return new Promise((resolve) => {
    if (!Number.isInteger(pid) || pid <= 0) return resolve(false);
    if (process.platform !== 'win32') {
      try { process.kill(pid, 'SIGKILL'); return resolve(true); } catch { return resolve(false); }
    }
    execFile('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, (err) => resolve(!err));
  });
}

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/**
 * Stop a console child gracefully.
 *
 * @param {ChildProcess|null} child  the spawned process, if we own it
 * @param {number} pid
 * @param {object} opts  timeoutMs, onLog(line)
 * @returns {Promise<{graceful:boolean, ms:number, attempts:number, hardKilled:boolean, detail:string}>}
 */
async function stopGracefully(child, pid, opts = {}) {
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : DEFAULT_TIMEOUT_MS;
  const log = typeof opts.onLog === 'function' ? opts.onLog : () => {};
  const started = Date.now();

  if (!isAlive(pid)) return { graceful: true, ms: 0, attempts: 0, hardKilled: false, detail: 'already exited' };

  let exited = false;
  const exitPromise = new Promise((resolve) => {
    if (child && typeof child.once === 'function') child.once('exit', () => { exited = true; resolve(); });
  });

  let attempts = 0;
  let lastDetail = '';
  const first = await sendCtrlC(pid);
  attempts += 1;
  lastDetail = first.detail;
  log(`[stop] Ctrl-C -> pid ${pid}: ${first.ok ? 'sent' : 'failed (' + first.detail + ')'}`);

  const retryAt = started + Math.floor(timeoutMs / 3);
  let retried = false;

  while (Date.now() - started < timeoutMs) {
    if (exited || !isAlive(pid)) {
      const ms = Date.now() - started;
      log(`[stop] pid ${pid} exited gracefully after ${ms} ms`);
      return { graceful: true, ms, attempts, hardKilled: false, detail: lastDetail };
    }
    if (!retried && Date.now() >= retryAt) {
      retried = true;
      const again = await sendCtrlC(pid);
      attempts += 1;
      lastDetail = again.detail;
      log(`[stop] second Ctrl-C -> pid ${pid}: ${again.ok ? 'sent' : 'failed'}`);
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  // Budget spent. Say plainly that we are about to do the thing we try to avoid.
  log(`[stop] pid ${pid} did not stop within ${timeoutMs} ms — forcing termination. ` +
      'The node database may need recovery on the next start.');
  const killed = await hardKill(pid);
  await Promise.race([exitPromise, new Promise((r) => setTimeout(r, 3000))]);
  return { graceful: false, ms: Date.now() - started, attempts, hardKilled: killed, detail: lastDetail };
}

module.exports = { stopGracefully, sendCtrlC, hardKill, isAlive, helperScriptPath, unpackedPath, DEFAULT_TIMEOUT_MS };
