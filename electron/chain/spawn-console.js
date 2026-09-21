// Starting a console child that can later be stopped gracefully.
//
// The whole reason this module is not two lines of child_process.spawn is a
// Windows fact measured on 2026-09-21 (see electron/resources/swarm-start.ps1):
// a child created with CREATE_NO_WINDOW — which is exactly what Node's
// `windowsHide: true` produces — never receives CTRL_C_EVENT, so zebrad can
// only be killed hard. A child created with CREATE_NEW_CONSOLE + SW_HIDE has a
// real, invisible console and stops cleanly in well under a second.
//
// Windows  : launch through the bundled PowerShell starter, read the PID back,
//            tail the redirected log files, poll for exit.
// Elsewhere: plain spawn with pipes; SIGINT is the same signal zebrad listens
//            for, so nothing special is needed.

'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const { unpackedPath, isAlive } = require('./graceful-stop');

const TAIL_INTERVAL_MS = 400;
const ALIVE_INTERVAL_MS = 500;

function starterScriptPath() {
  return unpackedPath(path.join(__dirname, '..', 'resources', 'swarm-start.ps1'));
}

/** Follows a growing file and emits whole lines. */
class FileTail extends EventEmitter {
  constructor(file, kind) {
    super();
    this.file = file;
    this.kind = kind;
    this.offset = 0;
    this.buf = '';
    this.timer = null;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.pump(), TAIL_INTERVAL_MS);
    if (this.timer.unref) this.timer.unref();
  }

  pump() {
    let size;
    try { size = fs.statSync(this.file).size; } catch { return; }
    if (size < this.offset) { this.offset = 0; this.buf = ''; }   // file was truncated
    if (size === this.offset) return;
    let chunk;
    try {
      const fd = fs.openSync(this.file, 'r');
      const len = size - this.offset;
      const b = Buffer.allocUnsafe(len);
      fs.readSync(fd, b, 0, len, this.offset);
      fs.closeSync(fd);
      chunk = b.toString('utf8');
    } catch { return; }
    this.offset = size;
    this.buf += chunk;
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).replace(/\r$/, '');
      this.buf = this.buf.slice(i + 1);
      if (line) this.emit('line', line, this.kind);
    }
    if (this.buf.length > 16384) this.buf = '';
  }

  stop() {
    this.pump();
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }
}

/**
 * A started console child. Emits 'line' (text, kind) and 'exit' ({code}).
 * `pid` is the PID of the real program, not of any launcher.
 */
class ConsoleChild extends EventEmitter {
  constructor({ pid, child, tails, logFiles }) {
    super();
    this.pid = pid;
    this.child = child || null;          // null on Windows: the launcher has gone
    this.tails = tails || [];
    this.logFiles = logFiles || {};
    this.exited = false;
    this.aliveTimer = null;
    for (const t of this.tails) {
      t.on('line', (line, kind) => this.emit('line', line, kind));
      t.start();
    }
  }

  watchForExit() {
    if (this.child) {
      this.child.on('exit', (code, signal) => this.handleExit(code, signal));
      return;
    }
    this.aliveTimer = setInterval(() => {
      if (!isAlive(this.pid)) this.handleExit(null, null);
    }, ALIVE_INTERVAL_MS);
    if (this.aliveTimer.unref) this.aliveTimer.unref();
  }

  handleExit(code, signal) {
    if (this.exited) return;
    this.exited = true;
    if (this.aliveTimer) { clearInterval(this.aliveTimer); this.aliveTimer = null; }
    // Drain whatever the program wrote on its way out before saying it is gone.
    for (const t of this.tails) t.stop();
    this.emit('exit', { code, signal });
  }

  dispose() {
    if (this.aliveTimer) { clearInterval(this.aliveTimer); this.aliveTimer = null; }
    for (const t of this.tails) t.stop();
  }
}

/**
 * Start a console program.
 *
 * @param {object} o
 *   binaryPath {string}
 *   args       {string[]}  argument ARRAY, never a shell string
 *   cwd        {string}
 *   logDir     {string}    where the redirected output goes on Windows
 *   logBase    {string}    file name stem, e.g. "node" -> node.out.log
 * @returns {Promise<ConsoleChild>}
 */
function startConsoleChild(o) {
  const { binaryPath, args = [], cwd, logDir, logBase } = o;
  if (!Array.isArray(args)) throw new Error('args must be an array');

  if (process.platform !== 'win32') {
    const child = spawn(binaryPath, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], detached: false });
    const cc = new ConsoleChild({ pid: child.pid, child, tails: [] });
    const feed = (stream, kind) => {
      let buf = '';
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          if (line) cc.emit('line', line, kind);
        }
        if (buf.length > 16384) buf = '';
      });
    };
    feed(child.stdout, 'out');
    feed(child.stderr, 'err');
    child.on('error', (e) => cc.emit('error', e));
    cc.watchForExit();
    return Promise.resolve(cc);
  }

  // ---- Windows: real but hidden console ----
  fs.mkdirSync(logDir, { recursive: true });
  const outFile = path.join(logDir, `${logBase}.out.log`);
  const errFile = path.join(logDir, `${logBase}.err.log`);
  // Start-Process truncates these; rotate the previous run so a crash report
  // is still readable afterwards.
  for (const f of [outFile, errFile]) {
    try { if (fs.existsSync(f)) fs.renameSync(f, f + '.1'); } catch { /* not fatal */ }
  }

  // One base64 blob, so no path or argument can be re-parsed by PowerShell.
  const requestB64 = Buffer.from(JSON.stringify({
    bin: binaryPath,
    cwd,
    stdout: outFile,
    stderr: errFile,
    args: args.map(String)
  }), 'utf8').toString('base64');

  return new Promise((resolve, reject) => {
    const launcher = spawn(
      'powershell.exe',
      [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', starterScriptPath(),
        '-RequestB64', requestB64
      ],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
    );

    let out = '';
    let err = '';
    launcher.stdout.on('data', (d) => { out += d; });
    launcher.stderr.on('data', (d) => { err += d; });
    launcher.on('error', (e) => reject(new Error(`could not start the launcher: ${e.message}`)));
    launcher.on('exit', (code) => {
      if (code !== 0) return reject(new Error(`launcher failed (exit ${code}): ${(err || out).trim().slice(0, 400)}`));
      const m = /\{"pid":(\d+)\}/.exec(out);
      if (!m) return reject(new Error(`launcher printed no pid: ${(out + err).trim().slice(0, 400)}`));
      const pid = Number(m[1]);
      const cc = new ConsoleChild({
        pid,
        child: null,
        tails: [new FileTail(outFile, 'out'), new FileTail(errFile, 'err')],
        logFiles: { out: outFile, err: errFile }
      });
      cc.watchForExit();
      resolve(cc);
    });
  });
}

module.exports = { startConsoleChild, ConsoleChild, FileTail, starterScriptPath };
