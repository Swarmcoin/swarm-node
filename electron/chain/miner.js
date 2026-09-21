// Standard mining: a pool of privacy-miner processes, one CPU core each.
//
// The miner's contract, from work/standalone-miner/INTEGRATION.md:
//   privacy-miner --config <node.toml> --rpc http://127.0.0.1:<port>
//                 --cookie <dir>/.cookie --payout <transparent address>
//                 --blocks 0
// One CPU worker per process, a random starting nonce per job, so N copies
// use N cores. It rereads the cookie for each call, never takes a secret on
// the command line, and cancels on Ctrl+C — the same console-signal shutdown
// path the node uses, so stopping the pool is graceful too.
//
// The node must already carry the same payout in [mining].miner_address; the
// engine guarantees that before it starts the pool.
//
// WHEN THE BINARY IS NOT BUNDLED: standard mining is a feature flag that is
// off, and the UI says so. A simulated worker exists for UI tests only. It
// never produces a block, never touches the chain, and every number it feeds
// the dashboard is tagged simulated:true so nothing downstream can mistake it
// for real mining.

'use strict';

const path = require('path');
const { EventEmitter } = require('events');
const { stopGracefully, isAlive } = require('./graceful-stop');
const { startConsoleChild } = require('./spawn-console');
const { redact } = require('./rpc');

// Lines the miner prints that we can turn into real numbers. Anything we
// cannot parse is shown as "—", never invented.
const ACCEPTED_RE = /\b(?:accepted|submitted)\b[^0-9a-f]*([0-9a-f]{64})/i;
const REJECTED_RE = /\brejected\b/i;
const SOLPS_RE = /([0-9]+(?:\.[0-9]+)?)\s*(k|K|M)?\s*sol\/s/;

function parseSolps(line) {
  const m = SOLPS_RE.exec(String(line || ''));
  if (!m) return null;
  const mult = m[2] === 'M' ? 1e6 : m[2] && m[2].toLowerCase() === 'k' ? 1e3 : 1;
  const v = Number(m[1]) * mult;
  return Number.isFinite(v) ? v : null;
}

class MinerPool extends EventEmitter {
  /**
   * @param {object} cfg
   *   binaryPath {string|null} verified privacy-miner, or null when unavailable
   *   simulate   {boolean} run fake workers for UI tests (never mines)
   */
  constructor(cfg = {}) {
    super();
    this.binaryPath = cfg.binaryPath || null;
    this.simulate = cfg.simulate === true;
    this.workers = [];      // {index, child, pid, solps, accepted}
    this.desired = 0;
    this.args = null;
    this.acceptedHashes = new Set();
    this.rejected = 0;
  }

  get available() { return this.simulate || !!this.binaryPath; }
  get running() { return this.workers.length > 0; }
  get workerCount() { return this.workers.filter((w) => this.simulate || isAlive(w.pid)).length; }

  /** Sum of per-worker Sol/s, or null when no worker ever reported a rate. */
  solps() {
    const measured = this.workers.map((w) => w.solps).filter((v) => Number.isFinite(v));
    if (!measured.length) return null;
    return measured.reduce((a, b) => a + b, 0);
  }

  log(text, kind = 'miner') {
    this.emit('log', { t: Date.now(), kind, text: redact(String(text)).slice(0, 1000) });
  }

  /**
   * @param {object} opts
   *   count      {number} workers to run
   *   configPath {string} the node's zebra.toml
   *   rpcPort    {number}
   *   cookieDir  {string}
   *   payout     {string} transparent address; must match the node's config
   */
  async start(opts) {
    if (!this.available) return { ok: false, error: 'privacy-miner is not bundled with this build' };
    const count = Math.max(1, Math.min(256, Number(opts.count) || 1));
    if (typeof opts.payout !== 'string' || !opts.payout) return { ok: false, error: 'payout address missing' };

    this.args = [
      '--config', opts.configPath,
      '--rpc', `http://127.0.0.1:${Number(opts.rpcPort)}`,
      '--cookie', path.join(opts.cookieDir, '.cookie'),
      '--payout', opts.payout,
      '--blocks', '0'
    ];
    this.cwd = opts.cookieDir;
    this.logDir = path.join(opts.cookieDir, 'logs');
    this.desired = count;

    for (let i = this.workers.length; i < count; i += 1) await this.spawnWorker(i);
    this.log(`${this.simulate ? 'SIMULATED ' : ''}standard mining started with ${this.workers.length} worker(s), one CPU core each`, 'app');
    return { ok: true, workers: this.workers.length, simulated: this.simulate };
  }

  handleLine(w, line) {
    const index = w.index;
    this.log(`[w${index}] ${line}`);
    const rate = parseSolps(line);
    if (rate != null) w.solps = rate;
    const acc = ACCEPTED_RE.exec(line);
    if (acc) {
      w.accepted += 1;
      const hash = acc[1].toLowerCase();
      if (!this.acceptedHashes.has(hash)) {
        this.acceptedHashes.add(hash);
        this.emit('block', { hash, worker: index, line });
      }
    } else if (REJECTED_RE.test(line)) {
      this.rejected += 1;
      this.emit('rejected', { worker: index, line });
    }
  }

  async spawnWorker(index) {
    if (this.simulate) {
      // A timer, not a process. It exists so the dashboard can be driven in a
      // UI test; it never mines and never reports a found block.
      const w = { index, child: null, pid: null, solps: null, accepted: 0, simulated: true };
      w.timer = setInterval(() => { this.emit('tick', { index, simulated: true }); }, 1000);
      if (w.timer.unref) w.timer.unref();
      this.workers.push(w);
      return w;
    }

    const w = { index, child: null, pid: null, solps: null, accepted: 0, simulated: false };
    this.workers.push(w);
    let child;
    try {
      child = await startConsoleChild({
        binaryPath: this.binaryPath,
        args: this.args,
        cwd: this.cwd,
        logDir: this.logDir,
        logBase: `miner-${index}`
      });
    } catch (e) {
      this.log(`[w${index}] failed to start: ${e.message}`, 'app');
      this.workers = this.workers.filter((x) => x !== w);
      return null;
    }
    w.child = child;
    w.pid = child.pid;
    child.on('line', (line) => this.handleLine(w, line));
    child.on('exit', ({ code }) => {
      this.log(`[w${index}] exited${code == null ? '' : ` (code ${code})`}`, 'app');
      this.workers = this.workers.filter((x) => x !== w);
      this.emit('workerExit', { index, code, desired: this.desired });
    });
    return w;
  }

  /** Change the number of workers without restarting the node or the others. */
  async setCount(count) {
    const target = Math.max(0, Math.min(256, Number(count) || 0));
    if (target === 0) return this.stop();
    if (!this.running) return { ok: false, error: 'pool is not running' };
    this.desired = target;
    while (this.workers.length > target) {
      const w = this.workers[this.workers.length - 1];
      this.workers.pop();
      await this.stopWorker(w);
    }
    for (let i = this.workers.length; i < target; i += 1) await this.spawnWorker(i);
    return { ok: true, workers: this.workers.length };
  }

  async stopWorker(w) {
    if (w.timer) { clearInterval(w.timer); w.timer = null; return { graceful: true, ms: 0 }; }
    if (!w.pid) return { graceful: true, ms: 0 };
    const report = await stopGracefully(w.child, w.pid, { timeoutMs: 10000, onLog: (l) => this.log(l, 'app') });
    if (w.child && typeof w.child.dispose === 'function') w.child.dispose();
    return report;
  }

  /** Stop every worker. Gracefully: the miner cancels on Ctrl+C. */
  async stop() {
    this.desired = 0;
    const list = this.workers.slice();
    this.workers = [];
    const reports = [];
    for (const w of list) reports.push(await this.stopWorker(w));
    if (list.length) this.log(`standard mining stopped (${list.length} worker(s))`, 'app');
    return { ok: true, stopped: list.length, reports };
  }
}

module.exports = { MinerPool, parseSolps, ACCEPTED_RE, SOLPS_RE };
