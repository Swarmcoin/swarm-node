// The full node: spawn, observe and stop zebrad.
//
// Facts from the 2026-09-21 native-build spike that this file encodes:
//   * zebrad is a console program, so it is spawned hidden;
//   * it holds an exclusive lock on its state directory — one instance per
//     directory, and a stale lock means a previous run was killed hard;
//   * it only stops cleanly on a console Ctrl-C (see graceful-stop.js);
//   * it writes its startup banner to stderr, not stdout.

'use strict';

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { stopGracefully, isAlive } = require('./graceful-stop');
const { startConsoleChild } = require('./spawn-console');
const { generateZebraConfig, writeConfigFile } = require('./config-gen');
const { redact } = require('./rpc');

const LOG_LINES_KEPT = 500;

class ZebraNode extends EventEmitter {
  /**
   * @param {object} cfg
   *   binaryPath {string} verified zebrad executable
   *   dataDir    {string} per-user directory: config, state/, .cookie
   *   manifest   {object} embedded network manifest
   */
  constructor(cfg) {
    super();
    this.binaryPath = cfg.binaryPath;
    this.dataDir = cfg.dataDir;
    this.manifest = cfg.manifest;
    this.child = null;
    this.pid = null;
    this.startedAt = null;
    this.stopping = false;
    this.exitInfo = null;
    this.logLines = [];
    this.lastStopReport = null;
    this.configPath = path.join(this.dataDir, 'zebra.toml');
  }

  get running() { return this.child != null && this.pid != null && isAlive(this.pid); }

  pushLog(line, kind = 'node') {
    const text = redact(String(line).replace(/\r/g, '').trimEnd());
    if (!text) return;
    const entry = { t: Date.now(), kind, text: text.slice(0, 1000) };
    this.logLines.push(entry);
    if (this.logLines.length > LOG_LINES_KEPT) this.logLines.splice(0, this.logLines.length - LOG_LINES_KEPT);
    this.emit('log', entry);
  }

  getLogs(limit = LOG_LINES_KEPT) { return this.logLines.slice(-limit); }

  /** Write the config Zebra will read. Returns the generated text. */
  writeConfig(opts) {
    fs.mkdirSync(path.join(this.dataDir, 'state'), { recursive: true });
    const text = generateZebraConfig(this.manifest, { ...opts, dataDir: this.dataDir });
    writeConfigFile(fs, this.configPath, text);
    return text;
  }

  /**
   * Start the node. Rejects if a node is already running in this data
   * directory, because zebrad's own state lock would fail anyway.
   */
  async start(opts = {}) {
    if (this.running) return { ok: true, alreadyRunning: true, pid: this.pid };
    this.exitInfo = null;
    this.stopping = false;

    // A leftover cookie from a previous run would authenticate nothing; remove
    // it so a stale file cannot be mistaken for a live node.
    try { fs.unlinkSync(path.join(this.dataDir, '.cookie')); } catch { /* fine */ }

    this.writeConfig(opts);

    const args = ['-c', this.configPath, 'start'];
    this.pushLog(`starting node: ${path.basename(this.binaryPath)} ${args.join(' ')}`, 'app');

    // A real but hidden console, so the graceful Ctrl-C stop actually works.
    let child;
    try {
      child = await startConsoleChild({
        binaryPath: this.binaryPath,
        args,
        cwd: this.dataDir,
        logDir: path.join(this.dataDir, 'logs'),
        logBase: 'node'
      });
    } catch (e) {
      this.pushLog(`node failed to start: ${e.message}`, 'app');
      this.emit('exit', { code: null, error: e.message });
      return { ok: false, error: e.message };
    }

    this.child = child;
    this.pid = child.pid;
    this.startedAt = Date.now();

    child.on('line', (line) => {
      // The engine gets every raw line, for the miner's own announcements.
      this.emit('line', line);
      // The log the user reads gets a translated one, or none. Zebra says some
      // frightening things that are not problems on this network; the raw text
      // stays in the node's own log files either way.
      const t = typeof this.translate === 'function' ? this.translate(line) : undefined;
      if (t === null) return;
      if (t && typeof t === 'object') this.pushLog(t.text, t.kind || 'app');
      else this.pushLog(line, 'node');
    });
    child.on('error', (e) => this.pushLog(`node reported: ${e.message}`, 'app'));
    child.on('exit', ({ code, signal }) => {
      this.exitInfo = { code, signal, at: Date.now(), expected: this.stopping };
      this.pushLog(`node exited${code == null ? '' : ` (code ${code})`}`, 'app');
      this.child = null;
      this.pid = null;
      this.emit('exit', this.exitInfo);
    });

    return { ok: true, pid: this.pid, configPath: this.configPath };
  }

  /** Stop the node gracefully. Always safe to call. */
  async stop({ timeoutMs = 20000 } = {}) {
    if (!this.child && !isAlive(this.pid)) {
      this.lastStopReport = { graceful: true, ms: 0, attempts: 0, hardKilled: false, detail: 'not running' };
      return this.lastStopReport;
    }
    this.stopping = true;
    const pid = this.pid;
    const report = await stopGracefully(this.child, pid, { timeoutMs, onLog: (l) => this.pushLog(l, 'app') });
    if (this.child && typeof this.child.dispose === 'function') this.child.dispose();
    this.child = null;
    this.pid = null;
    this.lastStopReport = report;
    this.emit('stopped', report);
    return report;
  }

  /** Size on disk of the state directory, in bytes. Walks lazily, capped. */
  stateSizeBytes(maxEntries = 20000) {
    const root = path.join(this.dataDir, 'state');
    let total = 0;
    let seen = 0;
    const stack = [root];
    while (stack.length && seen < maxEntries) {
      const dir = stack.pop();
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        seen += 1;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) stack.push(p);
        else { try { total += fs.statSync(p).size; } catch { /* skip */ } }
      }
    }
    return total;
  }
}

module.exports = { ZebraNode, LOG_LINES_KEPT };
