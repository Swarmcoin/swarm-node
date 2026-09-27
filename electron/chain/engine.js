// ChainEngine — the one object the Electron main process talks to.
//
// It owns the node, the miners, the sync gate and the reward ledger, and it
// pushes one state object to the UI every second. It has no Electron import,
// so the headless integration test drives exactly the same code the app runs.
//
// Rules it enforces, not suggestions:
//   * nothing runs hidden: stopAll() leaves no child process behind, and the
//     window closing calls it;
//   * mining never starts while the sync gate is closed, and stops by itself
//     when the gate closes under it;
//   * no number reaches the UI that was not read from the chain, from a
//     miner's own output, or measured on this machine.

'use strict';

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const { ZebraNode } = require('./zebrad');
const { ZebraRpc } = require('./rpc');
const { MinerPool } = require('./miner');
const { SyncGate, tipAgeSeconds, REASON } = require('./sync-gate');
const { RewardLedger, coinbasePaidTo, parseMinedLine, parseSolverRate, splitSubsidy } = require('./rewards');

// How long a solver rate the node reported stays usable. The miners report
// every ten seconds while they are solving, so a minute-old reading means the
// solver stopped; showing it as the current rate would be a lie.
const SOLVER_RATE_MAX_AGE_MS = 60 * 1000;
const { validateWithNode } = require('./address');
const { machineCheck, canBindPort, freeEphemeralPort } = require('./hardware');
const { requireBinary, loadBaseline } = require('./binaries');
const { TipOracle } = require('./tip-oracle');
const { nextAction } = require('./next-action');
const { explainExit, findForeignNode, stopNodeProcess, writeRecord, clearRecord } = require('./node-trouble');
const { profileForManifestOrKind, checkNodeChain, checkNodeGenesis } = require('./network-profile');

const TICK_MS = 1000;
const SCAN_BUDGET_PER_TICK = 25;   // blocks re-checked per tick by the backstop scan
const IDLE_THRESHOLD_S = 120;      // "pause while I'm using the machine"
// How long a freshly started node may take to find peers before its silence
// counts against it. Shielded mining restarts the node by design, so this is
// the difference between mining and a restart loop. See N-8.
const SETTLE_AFTER_RESTART_MS = 90000;

class ChainEngine extends EventEmitter {
  /**
   * @param {object} cfg
   *   manifest    {object}  embedded network manifest
   *   dataDir     {string}  per-user data directory
   *   settings    {object}  persisted settings (see config-store.js)
   *   saveSettings{function}
   *   allowUnpinnedBinaries {boolean} development only
   *   idleSeconds {function|null} returns system idle seconds (powerMonitor)
   *   simulateStandardMiner {boolean} UI-test only, never mines
   */
  constructor(cfg) {
    super();
    this.manifest = cfg.manifest;
    // WHICH SWARM NETWORK. Resolved from the manifest the build carries, or
    // handed in by the main process when a profile was selected. It is never a
    // string this file invents, and it can never be upstream Zcash: see
    // electron/chain/network-profile.js.
    this.profile = cfg.profile || profileForManifestOrKind(cfg.manifest);
    // The chain label this node must report. A build carrying a throwaway or
    // rehearsal definition names its own; otherwise it is the profile's.
    this.expectedChainLabel =
      ((cfg.manifest || {}).identity || {}).light_wallet_chain_label || this.profile.chainLabel;
    this.dataDir = cfg.dataDir;
    this.settings = cfg.settings;
    this.saveSettings = cfg.saveSettings || (() => {});
    this.idleSeconds = cfg.idleSeconds || null;
    this.allowUnpinned = cfg.allowUnpinnedBinaries === true;
    this.simulateStandardMiner = cfg.simulateStandardMiner === true;

    const gateCfg = this.manifest.sync_gate || {};
    this.gate = new SyncGate({
      minPeers: gateCfg.min_peers,
      maxBehind: gateCfg.max_behind_blocks,
      quietSeconds: gateCfg.quiet_seconds,
      patienceSeconds: gateCfg.patience_seconds,
      maxTipAgeSec: this.settings.maxTipAgeSeconds || gateCfg.max_tip_age_seconds,
      firstNode: this.settings.firstNodeOverride === true
    });

    // The independent view of the tip. See tip-oracle.js and defect N-1: a
    // node cannot tell whether it is behind by looking only at itself.
    this.tipOracle = new TipOracle({
      url: this.settings.tipOracleUrl || gateCfg.tip_oracle_url || null,
      expectChain: (this.manifest.identity || {}).light_wallet_chain_label || null
    });
    // When this node last accepted a new block, which separates "still
    // downloading" from "the chain is simply quiet".
    this.lastHeightChangeAt = null;

    this.ledger = new RewardLedger({
      maturity: (this.manifest.consensus || {}).coinbase_maturity_blocks,
      recipients: (this.manifest.economics || {}).recipients || [],
      atomicPerCoin: (this.manifest.economics || {}).atomic_unit_per_coin
    });

    const ports = this.manifest.ports || {};
    this.rpcPort = Number(this.settings.rpcPort) || Number(ports.rpc);
    // The canonical manifest calls it public_p2p; fixtures may say p2p.
    this.p2pPort = Number(this.settings.p2pPort) || Number(ports.p2p != null ? ports.p2p : ports.public_p2p);
    // Set when the network's port was taken and the node moved to another.
    this.p2pMoved = null;
    // The same for the node's private control port. See chooseRpcPort().
    this.rpcMoved = null;

    this.rpc = new ZebraRpc({ host: '127.0.0.1', port: this.rpcPort, cookieDir: this.dataDir, timeoutMs: 12000 });

    this.node = null;
    this.pool = null;
    this.timer = null;
    this.appLog = [];
    this.lastError = null;

    // Observed chain state, refreshed each tick. Null means "not known yet",
    // which the UI renders as "—" rather than zero.
    this.chain = {
      height: null, bestHash: null, tipTimeUnix: null, tipAgeSec: null,
      peersIn: 0, peersOut: 0, peers: 0, verificationProgress: null,
      networkSolps: null, difficulty: null, stateBytes: null, synced: null,
      estimatedHeight: null,
      // The independent view of the tip, and when it was taken.
      networkHeight: null, networkHeightAt: null, networkHeightError: null
    };
    this._lastSeenHeight = null;

    this.mining = { on: false, mode: this.settings.miningMode === 'shielded' ? 'shielded' : 'standard', startedAt: null, pausedByGate: false, pausedByIdle: false, armed: false, wanted: false };
    // Drives internal_miner in the generated config. Kept separate from
    // mining.on so that stopping the node (which must also stop mining) can
    // never trigger a restart loop.
    this.wantInternalMiner = false;
    this._sizeTick = 0;
    // null until the node has told us which block 0 it holds.
    this.genesisState = null;
    // null until the node has told us which chain it is on. See checkChain():
    // ok:false means the node answered and named a DIFFERENT network, and that
    // refuses mining outright.
    this.chainCheck = null;
    // Why the node is not running, when the answer is not 'it was not started'.
    this.nodeTrouble = null;
    this.address = { value: this.settings.payoutAddress || '', kind: this.settings.payoutKind || null, detail: this.settings.payoutDetail || '', confirmed: false };
    this.scanFromHeight = null;
    this.scanCursor = null;
    this.benchmark = null;   // { solps, at, seconds } once the user runs one
    // The last solver rate the NODE ITSELF reported, or null. The internal
    // miner runs inside the node, so its rate arrives in the node's own log;
    // a reading older than SOLVER_RATE_MAX_AGE_MS is dropped rather than shown
    // as if it were current.
    this.solverRate = null;
  }

  // ---------------------------------------------------------------- logging
  log(text, kind = 'app') {
    const entry = { t: Date.now(), kind, text: String(text).slice(0, 1000) };
    this.appLog.push(entry);
    if (this.appLog.length > 400) this.appLog.splice(0, this.appLog.length - 400);
    this.emit('log', entry);
  }

  getLogs(limit = 300) {
    const nodeLines = this.node ? this.node.getLogs(limit) : [];
    return [...this.appLog, ...nodeLines].sort((a, b) => a.t - b.t).slice(-limit);
  }

  // ---------------------------------------------------------------- binaries
  binaryStatus() {
    const z = requireBinary('zebrad', { allowUnpinned: this.allowUnpinned });
    const m = this.simulateStandardMiner
      ? { ok: true, path: null, sha256: null, reason: 'SIMULATED — no miner binary; this build cannot mine with the standard engine' }
      : requireBinary('miner', { allowUnpinned: this.allowUnpinned });
    // Where each program came from, straight out of the baseline file that
    // also pins its hash, so the About screen cannot drift from the manifest.
    const baseline = loadBaseline();
    const prov = (k) => {
      const b = baseline[k] || {};
      return {
        branch: b.branch || null,
        commit: b.commit || null,
        upstreamBase: b.upstream_base || null,
        changes: b.changes_vs_upstream || null,
        workflowRun: b.workflow_run || null
      };
    };
    return {
      zebrad: {
        ok: z.ok, reason: z.reason, sha256: z.sha256,
        path: z.ok ? path.basename(z.path || '') : null,
        provenance: prov('zebrad')
      },
      miner: {
        ok: m.ok, reason: m.reason, sha256: m.sha256,
        simulated: this.simulateStandardMiner,
        provenance: prov('miner')
      }
    };
  }

  /** Standard mining is only offered when a real miner binary is available. */
  standardMiningAvailable() {
    if (this.simulateStandardMiner) return true;
    return requireBinary('miner', { allowUnpinned: this.allowUnpinned }).ok;
  }

  // ---------------------------------------------------------------- node
  nodeConfigOptions() {
    const first = this.settings.firstNodeOverride === true;
    return {
      rpcPort: this.rpcPort,
      p2pListen: this.settings.p2pListen || `0.0.0.0:${this.p2pPort}`,
      seedPeers: Array.isArray(this.settings.seedPeers) ? this.settings.seedPeers : undefined,
      // Zebra's own health gate is switched on whenever we are NOT claiming to
      // be the first node. It is belt-and-braces behind this app's gate.
      enforceHealthGate: !first && this.settings.zebraHealthGate !== false,
      cpuThreads: Math.max(1, Math.min(8, Number(this.settings.nodeThreads) || 2)),
      // The node must carry the payout the standard miner will ask for, and
      // the node's own miner reads its payout from here too.
      minerAddress: this.address.value || null,
      internalMiner: this.wantInternalMiner === true,
      // The shielded engine gets the same slice of the machine the user chose
      // for the standard one. Before this it always got one core, so a fifteen
      // core machine paying a swm1 address contributed one core's work.
      internalMinerThreads: this.wantInternalMiner === true ? this.effectiveWorkerCount() : null
    };
  }

  async startNode() {
    if (this.node && this.node.running) return { ok: true, alreadyRunning: true };

    const bin = requireBinary('zebrad', { allowUnpinned: this.allowUnpinned });
    if (!bin.ok) {
      this.lastError = bin.reason;
      this.log(`cannot start the node: ${bin.reason}`);
      return { ok: false, error: bin.reason };
    }
    this.log(`zebrad verified, SHA-256 ${bin.sha256}`);

    await this.chooseP2pPort();
    await this.chooseRpcPort();

    fs.mkdirSync(this.dataDir, { recursive: true });

    // N-8. An older version's daemon, still running, still holds this chain
    // folder's database. Starting on top of it does not fail politely: the
    // new daemon panics with "Database likely already open" and exits, and
    // the app used to sit there for ever. Look first, and say so.
    const foreign = findForeignNode(this.dataDir, this.node ? this.node.pid : null);
    if (foreign) {
      this.nodeTrouble = {
        action: 'stop-foreign-node',
        pid: foreign.pid,
        text: 'A SWARM node from an earlier version is still running and is using this chain folder. '
          + 'Two nodes cannot share it, so this one cannot start until that one stops.',
        detail: `${foreign.source} (process ${foreign.pid})`
      };
      this.lastError = this.nodeTrouble.text;
      this.log(`${this.nodeTrouble.text} ${this.nodeTrouble.detail}`);
      return { ok: false, error: this.nodeTrouble.text, code: 'FOREIGN_NODE', pid: foreign.pid };
    }
    this.nodeTrouble = null;

    this.node = new ZebraNode({ binaryPath: bin.path, dataDir: this.dataDir, manifest: this.manifest });
    // Rewrite or drop the node's more alarming lines before they reach the
    // log the user reads. See translateNodeLine.
    this.node.translate = (line) => this.translateNodeLine(line);
    this.node.on('log', (e) => this.emit('log', e));
    this.node.on('line', (line) => this.onNodeLine(line));
    this.node.on('exit', (info) => {
      if (!info || !info.expected) {
        // NEVER a spinner. The daemon writes why it died to its own error
        // log; read it and put that on the Mining page as the reason.
        const why = explainExit(path.join(this.dataDir, 'logs'));
        this.nodeTrouble = why
          ? { action: why.action, text: why.text, detail: why.raw, pid: null }
          : { action: null, text: 'The node stopped unexpectedly.', detail: null, pid: null };
        this.lastError = this.nodeTrouble.text;
        this.log(`the node stopped: ${this.nodeTrouble.text}`);
        clearRecord(this.dataDir);
      }
      this.dropMining().catch(() => {});
    });

    let started;
    try {
      started = await this.node.start(this.nodeConfigOptions());
    } catch (e) {
      this.lastError = e.message;
      this.log(`node configuration refused: ${e.message}`);
      this.node = null;
      return { ok: false, error: e.message };
    }
    if (!started.ok) { this.node = null; return started; }
    // Written down so a later run - or a later VERSION - can recognise a
    // daemon this app started and never stopped.
    writeRecord(this.dataDir, { pid: started.pid, startedAt: Date.now(), configPath: started.configPath });
    this.nodeTrouble = null;
    this.lastError = null;
    this.log(`node started (pid ${started.pid}) on ${this.manifest.identity.network_name}`);
    this.ensureTicking();
    this.ensureGenesis().catch((e) => this.log(`genesis check failed: ${e.message}`));
    return { ok: true, pid: started.pid };
  }

  /**
   * Make sure the node has block 0 — and that it is the RIGHT block 0.
   *
   * Zebra inserts a genesis block by itself only on Regtest. On a configured
   * testnet a fresh node normally receives block 0 from a peer during sync,
   * which is what happens for anybody who installs this app and connects to
   * the seed. Two cases need help:
   *   * the very first node of a brand-new network, which has no peer;
   *   * a node whose peers are slow or unreachable on first start.
   * In both, the bytes the network was defined with are handed to the node's
   * own RPC, once. This is not consensus code: the node validates the block
   * itself and rejects anything that is not the genesis its config names.
   *
   * If the node somehow already holds a DIFFERENT block 0, that is a wrong
   * chain, and the app says so loudly instead of carrying on.
   */
  /**
   * Single-flight wrapper: startNode() kicks this off and the UI may ask for
   * it too. Two concurrent runs would race on submitblock and each report the
   * other's half-finished state, so callers share one run.
   */
  ensureGenesis() {
    if (!this._genesisRun) {
      this._genesisRun = this.ensureGenesisOnce().finally(() => { this._genesisRun = null; });
    }
    return this._genesisRun;
  }

  async ensureGenesisOnce() {
    const gen = this.manifest.genesis || {};
    const expected = String(gen.hash || '').toLowerCase();
    const hex = typeof gen.hex === 'string' && /^[0-9a-f]+$/i.test(gen.hex) ? gen.hex : null;

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    /**
     * null = the node has no block 0. A node that is not answering YET is a
     * different thing from a node with an empty chain, so this waits for the
     * RPC to come up rather than reporting "no genesis" while it is starting.
     */
    const readGenesis = async () => {
      const until = Date.now() + 90000;
      while (Date.now() < until) {
        try {
          const h = await this.rpc.getBlockHash(0);
          return h ? String(h).toLowerCase() : null;
        } catch (e) {
          if (e.code === 'NO_COOKIE' || e.code === 'NET' || e.code === 'ECONNREFUSED' || e.code === 'TIMEOUT') {
            await sleep(1000);
            continue;
          }
          return null; // "block not found" on an empty chain
        }
      }
      return null;
    };

    /** Compare what the node holds with what this build expects. */
    const settle = (got, source) => {
      if (got === expected) {
        this.genesisState = { ok: true, hash: got, source };
        this.log(`genesis block confirmed: ${got.slice(0, 16)}… (${source})`);
        return this.genesisState;
      }
      // A different block 0 means a different chain. Say so; do not mine on it.
      this.genesisState = { ok: false, hash: got, expected, error: 'wrong chain' };
      this.lastError =
        `This node holds a different genesis block (${got.slice(0, 16)}…) from the one this build ` +
        `expects (${expected.slice(0, 16)}…). That data folder belongs to another network. ` +
        'Stop the node and choose an empty folder.';
      this.log(this.lastError);
      this.dropMining().catch(() => {});
      return this.genesisState;
    };

    // Phase 1 — let peers deliver block 0, which is what happens for everyone
    // who installs this app and connects to the seed. The first node of a new
    // network has nobody to wait for, so it skips straight to phase 2.
    const graceMs = this.settings.firstNodeOverride === true ? 0 : 45000;
    if (graceMs > 0) this.log(`waiting up to ${Math.round(graceMs / 1000)}s for a peer to send the genesis block…`);
    const graceUntil = Date.now() + graceMs;
    do {
      const got = await readGenesis();
      if (got) return settle(got, 'received from a peer');
      if (Date.now() >= graceUntil) break;
      await sleep(2000);
    } while (true);

    // Phase 2 — no peer produced it. Hand the node the bytes this build ships.
    if (!hex) {
      this.genesisState = { ok: false, error: 'no peer sent the genesis block and this build does not carry it' };
      this.log(this.genesisState.error);
      return this.genesisState;
    }
    try {
      const r = await this.rpc.submitBlock(hex);
      if (r != null && r !== 'duplicate') {
        this.genesisState = { ok: false, error: String(r) };
        this.log(`the node refused the genesis block: ${r}`);
        return this.genesisState;
      }
      this.log('no peer had the genesis block, so it was taken from this build and handed to the node');
    } catch (e) {
      this.log(`could not submit the genesis block: ${e.message}`);
    }

    // Phase 3 — read it back and verify. Trusting our own submission is not
    // verification; the node's answer is.
    const until = Date.now() + 30000;
    while (Date.now() < until) {
      const got = await readGenesis();
      if (got) return settle(got, 'taken from this build');
      await sleep(1500);
    }

    this.genesisState = { ok: false, error: 'the node never reported a genesis block' };
    this.log(this.genesisState.error);
    return this.genesisState;
  }

  async stopNode() {
    // Stop the miners first, WITHOUT restarting the node: this is the path a
    // node restart itself goes through, so it must never loop.
    await this.dropMining();
    if (!this.node) return { graceful: true, ms: 0, attempts: 0, hardKilled: false, detail: 'not running' };
    const report = await this.node.stop({ timeoutMs: Number(this.settings.stopTimeoutMs) || 20000 });
    clearRecord(this.dataDir);
    this.chain = { ...this.chain, height: null, peers: 0, peersIn: 0, peersOut: 0, synced: null, tipAgeSec: null };
    return report;
  }

  /** Restart with a new config. Used when a setting the node reads changes. */
  async restartNode(why) {
    // A gate pause and a user changing payout can request restarts together.
    // Queue them so neither stop can tear down the other's newly started node.
    const previous = this._restartRun || Promise.resolve();
    const run = previous.catch(() => {}).then(async () => {
      this.log(`restarting the node: ${why}`);
      await this.stopNode();
      return this.startNode();
    });
    this._restartRun = run;
    try { return await run; }
    finally { if (this._restartRun === run) this._restartRun = null; }
  }

  /**
   * Zebra says some frightening things that are not problems.
   *
   * The owner read "initial sync is very slow, or estimated tip is wrong" in
   * the console and asked about it. On this network it is meaningless: Zebra
   * derives that warning from its wall-clock tip estimate, which a young chain
   * always contradicts (see the note in sync-gate.js). Lines like it are
   * rewritten into something true, or dropped, before they reach the log the
   * user reads. Nothing is invented and nothing that matters is hidden: the
   * node's own log files keep every original line.
   */
  translateNodeLine(line) {
    const t = String(line);
    if (/initial sync is very slow|estimated tip is wrong/.test(t)) {
      return {
        kind: 'app',
        text: 'Note: the node reports it is behind a time-based estimate of the chain height. ' +
              'On a young network that estimate is wrong more often than the node is, so SWARM Node ' +
              'compares your height with the SWARM wallet server instead. Nothing is wrong here.'
      };
    }
    if (/below the highest checkpoint/.test(t)) return null;      // meaningless without checkpoints
    if (/assuming the open file limit is high enough/.test(t)) return null;
    if (/Thank you for running a/.test(t)) return null;
    // A peer dial prints the ENTIRE network definition - every funding-stream
    // address, the genesis hash, every activation height - as one Rust struct.
    // It filled the owner's Log with hundreds of characters of internal
    // detail per connection attempt. The node's own log files keep it.
    if (/^\s*dial\{/.test(this.stripTargets(t))) return null;
    // Everything else is shown, but tidied: no timestamps, no levels, no
    // upstream module paths. The raw line stays in the node's own log file.
    const tidy = this.tidyNodeLine(t);
    return tidy && tidy !== t ? { kind: 'node', text: tidy } : undefined;
  }

  /**
   * Make a node log line readable without lying about it.
   *
   * The owner asked why a window said "zebra". The node IS Zebra and the About
   * screen says so, but a log a person reads should talk about their node, not
   * about somebody's Rust module paths. This strips the timestamp, the level
   * and the `zebrad::components::sync:` style target tags, leaving the
   * sentence. The node's own log files on disk keep every original line, tags
   * and all, so nothing is lost for diagnosis.
   */
  /** Timestamp, level and the `crate::module::span:` tags, gone. */
  stripTargets(line) {
    let t = String(line);
    // 2026-09-22T03:33:31.782513Z  INFO  ->  gone
    t = t.replace(/^\s*\d{4}-\d{2}-\d{2}T[\d:.]+Z?\s+/, '');
    t = t.replace(/^(TRACE|DEBUG|INFO|WARN|ERROR)\s+/i, '');
    // Strip the prefixes, longest form first. A `crate::module::path:` has to
    // be matched BEFORE the bare `word:` pattern, or "zebrad::commands::start:"
    // loses only "zebrad" and leaves ":commands::start:" behind.
    for (let i = 0; i < 6; i += 1) {
      const before = t;
      t = t.replace(/^[a-z_][a-z0-9_]*(::[a-z0-9_]+)+(\{[^}]*\})?:\s*/i, '');   // crate::module:
      t = t.replace(/^[a-z_][a-z0-9_]*\{[^}]*\}:\s*/i, '');                     // span{field=x}:
      if (t === before) break;
    }
    return t.trim();
  }

  tidyNodeLine(line) {
    let t = this.stripTargets(line);

    // The upstream project's name inside the SENTENCE, not just in the target
    // tag. "activating mempool: Zebra is close to the tip" reached the owner's
    // Log page after the tags had been stripped, which is the same leak by
    // another route. This app calls it your node, everywhere a user reads.
    // The About screen still names Zebra, in full, where the credit belongs.
    t = t.replace(/\bzebrad\b/gi, 'your node').replace(/\bzebra\b/gi, 'your node');

    // Rust struct dumps run to hundreds of characters and are unreadable in a
    // log box. Cut them; the node's own files keep every original line.
    const MAX = 300;
    if (t.length > MAX) t = `${t.slice(0, MAX).trimEnd()}… (full line in the node's log file)`;
    return t.trim();
  }

  onNodeLine(line) {
    // The node's own miner reports the rate its solver measured. That is the
    // only rate the shielded engine can have: the solver runs inside the node
    // process, so there is no child to read a rate from.
    const rate = parseSolverRate(line);
    if (rate != null) this.solverRate = { solps: rate, at: Date.now() };

    // Zebra's internal miner announces its own accepted blocks. That log line
    // is the only place the shielded miner reports anything: it exposes no
    // RPC and no metric.
    const mined = parseMinedLine(line);
    if (mined) {
      this.log(`this machine mined block ${mined.height} (${mined.hash.slice(0, 12)}…)`);
      this.recordShieldedBlock(mined).catch((e) => this.log(`could not read the subsidy for block ${mined.height}: ${e.message}`));
    }
  }

  // ---------------------------------------------------------------- mining
  async waitForNodeRpc(timeoutMs = 30000) {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      if (!this.node || !this.node.running) return { ok: false, error: 'The node stopped before its RPC became ready.' };
      try {
        if (await this.rpc.getInfo()) return { ok: true };
      } catch { /* A restart removes the old cookie before the new RPC is ready. */ }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return { ok: false, error: 'The node RPC did not become ready within 30 seconds; no miner was started.' };
  }

  async startMining() {
    this.mining.armed = false;   // an explicit start supersedes an armed one
    if (this._restartRun) await this._restartRun;
    if (!this.node || !this.node.running) return { ok: false, error: 'Start the full node first.' };
    if (!this.address.value) return { ok: false, error: 'Paste a payout address first.' };

    // NEVER MINE ON THE WRONG CHAIN. A block found there pays nothing, the
    // payout address does not exist on it, and the work is thrown away.
    const mismatch = this.chainMismatch();
    if (mismatch) return { ok: false, error: mismatch, reason: 'WRONG_CHAIN' };

    const decision = this.evaluateGate();
    if (!decision.allow) return { ok: false, error: decision.message, reason: decision.reason };

    if (this.mining.mode === 'shielded') {
      // Zebra reads internal_miner from its config file at start-up only, so
      // switching shielded mining on costs one node restart. That is stated in
      // the UI next to the toggle rather than hidden.
      this.wantInternalMiner = true;
      const r = await this.restartNode('switching Zebra’s internal miner on');
      if (!r.ok) { this.wantInternalMiner = false; return r; }
      this.mining.on = true;
      this.mining.startedAt = Date.now();
      this.mining.pausedByGate = false;
      const threads = this.effectiveWorkerCount();
      this.log(`shielded mining on: ${threads} solver ${threads === 1 ? 'thread' : 'threads'} inside the node, paying your unified address`);
      return { ok: true, mode: 'shielded', restarted: true };
    }

    if (!this.standardMiningAvailable()) {
      return { ok: false, error: 'Standard mining is not available in this build: privacy-miner is not bundled yet.' };
    }
    // Changing the payout restarts Zebra. startNode() returns when the process
    // exists, before it writes its new RPC cookie; a worker launched in that
    // gap exits with "No such file or directory" and never mines.
    const ready = await this.waitForNodeRpc();
    if (!ready.ok) return ready;
    await this.refreshChain();
    const currentGate = this.evaluateGate();
    if (!currentGate.allow) return { ok: false, error: currentGate.message, reason: currentGate.reason };
    const minerBin = this.simulateStandardMiner ? { path: null } : requireBinary('miner', { allowUnpinned: this.allowUnpinned });
    this.pool = new MinerPool({ binaryPath: minerBin.path, simulate: this.simulateStandardMiner });
    this.pool.on('log', (e) => this.emit('log', e));
    this.pool.on('block', (b) => {
      this.log(`this machine mined a block (${b.hash.slice(0, 12)}…)`);
      this.recordTransparentBlock(b.hash).catch((e) => this.log(`could not read block ${b.hash.slice(0, 12)}…: ${e.message}`));
    });

    const count = this.effectiveWorkerCount();
    const r = await this.pool.start({
      count,
      configPath: this.node.configPath,
      rpcPort: this.rpcPort,
      cookieDir: this.dataDir,
      payout: this.address.value
    });
    if (!r.ok) { this.pool = null; return r; }
    this.mining.on = true;
    this.mining.startedAt = Date.now();
    this.mining.pausedByGate = false;
    if (this.scanFromHeight == null && Number.isInteger(this.chain.height)) {
      this.scanFromHeight = this.chain.height;
      this.scanCursor = this.chain.height;
    }
    return { ok: true, mode: 'standard', workers: r.workers, simulated: r.simulated };
  }

  effectiveWorkerCount() {
    const cores = require('os').cpus().length || 2;
    const max = Math.max(1, cores - 1);
    const want = Number(this.settings.intensity);
    return Math.max(1, Math.min(max, Number.isFinite(want) ? Math.round(want) : Math.max(1, Math.floor(max / 2))));
  }

  /**
   * ONE PRESS. Everything between here and a block is the app's problem.
   *
   * N-9. The owner's words: "This needs to work all with just clicking start
   * mining." Before this, a new user pressed "Start your node", waited, then
   * pressed "Start mining when ready", and had to know which engine their
   * address allowed. None of that is their job. This starts the node if it is
   * stopped, picks the engine the address dictates, and arms mining so it
   * begins by itself the moment the work would count.
   */
  async startEverything() {
    if (!this.address.value) return { ok: false, error: 'Paste a payout address first.' };

    // The ADDRESS decides the engine, not the user. A unified address can
    // only be paid by the node's own miner; a transparent one only by the
    // multi-core miner. Choosing wrongly is a refusal the user cannot act on.
    const want = this.address.kind === 'unified' ? 'shielded'
      : this.address.kind === 'transparent' ? 'standard'
        : null;
    if (want && want !== this.mining.mode && !this.mining.on) {
      this.mining.mode = want;
      this.settings.miningMode = want;
      this.saveSettings(this.settings);
      this.log(want === 'shielded'
        ? 'your address is a unified one, so mining runs inside the node'
        : 'your address is a transparent one, so mining uses your processor cores');
    }

    this.mining.wanted = true;

    if (!(this.node && this.node.running)) {
      const started = await this.startNode();
      if (!started.ok) {
        // The node could not start. Keep the intent - the reason is on screen
        // and one press of the button it offers should carry on from here.
        return started;
      }
    }

    // If the gate is already open there is nothing to wait for.
    if (this.evaluateGate().allow) {
      const r = await this.startMining();
      if (r.ok === false) this.log(`could not start mining: ${r.error}`);
      this.mining.wanted = true;
      return r;
    }

    this.mining.armed = true;
    this._settleNoted = false;
    this.log('mining will start by itself as soon as your node is ready');
    this.emit('state', this.getState());
    return { ok: true, armed: true };
  }

  /** Stop wanting to mine, and stop mining. The same button, pressed again. */
  async cancelMining() {
    this.mining.wanted = false;
    this.mining.armed = false;
    this.mining.pausedByGate = false;
    return this.stopMiningInternal('stopped by you');
  }

  /**
   * Arm mining so it starts by itself the moment the gate opens.
   *
   * This is what the Mining page's primary button does while the node is
   * catching up, instead of sitting there greyed out. Nothing is started now
   * and nothing is promised that the gate will not still have to allow.
   */
  armMining(on) {
    const want = on === true;
    if (this.mining.armed === want) return { ok: true, armed: want };
    this.mining.armed = want;
    this.log(want
      ? 'mining armed: it will start by itself as soon as your node is ready'
      : 'automatic start cancelled');
    this.emit('state', this.getState());
    return { ok: true, armed: want };
  }

  async stopMining() {
    // Stopping by hand also cancels an armed start AND the standing intent;
    // otherwise the app would start mining again behind the user a minute
    // later, which is precisely what "stop" must not mean.
    this.mining.armed = false;
    this.mining.wanted = false;
    return this.stopMiningInternal('stopped by you');
  }

  /**
   * Stop mining and, for the shielded engine, restart the node so Zebra's
   * internal miner actually goes away. Never call this from the node's own
   * stop path — use dropMining() there.
   */
  async stopMiningInternal(why) {
    const wasMode = this.mining.mode;
    const wasOn = this.mining.on || !!this.pool || this.wantInternalMiner;
    if (!wasOn) return { ok: true, wasRunning: false };

    if (this.pool) {
      const r = await this.dropMining();
      this.log(`standard mining stopped (${why})`);
      return { ok: true, wasRunning: true, mode: wasMode, ...r };
    }

    const needRestart = this.wantInternalMiner && this.node && this.node.running;
    // Clear the CONFIG intent here, not in dropMining(): dropMining runs on the
    // way through every node restart, and clearing it there would switch the
    // internal miner off again the moment we restarted to switch it on.
    this.wantInternalMiner = false;
    await this.dropMining();
    if (needRestart) {
      this.log(`shielded mining stopping (${why}) — the node restarts because Zebra reads that switch only at start-up`);
      await this.restartNode('switching Zebra’s internal miner off');
    }
    return { ok: true, wasRunning: true, mode: wasMode };
  }

  /**
   * Tear the miners down without touching the node. Used by stopNode() and by
   * the node's own exit handler, so a restart can never recurse.
   */
  async dropMining() {
    this.mining.on = false;
    this.mining.startedAt = null;
    // wantInternalMiner is deliberately NOT touched here: it is the config the
    // next node start must use, and a restart goes through this method.
    if (this.pool) {
      const r = await this.pool.stop();
      this.pool = null;
      return { ok: true, ...r };
    }
    return { ok: true, stopped: 0 };
  }

  // ---------------------------------------------------------------- gate
  evaluateGate() {
    const oracle = this.tipOracle.current();
    return this.gate.evaluate({
      nodeRunning: !!(this.node && this.node.running),
      peers: this.chain.peers,
      height: this.chain.height,
      networkHeight: oracle ? oracle.height : null,
      networkSource: oracle ? 'the SWARM wallet server' : null,
      secondsSinceNewBlock: this.lastHeightChangeAt == null
        ? null
        : Math.round((Date.now() - this.lastHeightChangeAt) / 1000),
      tipAgeSec: this.chain.tipAgeSec,
      addressKind: this.address.kind,
      mode: this.mining.mode
    });
  }

  /**
   * "Start anyway". Only accepted once the gate itself offers it, which it does
   * after the patience window and only for a network-health reason. It is the
   * user disagreeing with a guess, not a way around a missing address.
   */
  setUserOverride(on) {
    const want = on === true;
    if (want && !this.evaluateGate().offerOverride) {
      return { ok: false, error: 'Mining is not being held back by anything you can override right now.' };
    }
    this.gate.setUserOverride(want);
    this.log(want
      ? 'you chose to start mining anyway; your node may not be on the network’s best chain'
      : 'the "start anyway" choice was switched off');
    return { ok: true, userOverride: want };
  }

  // ---------------------------------------------------------------- rewards
  /** Fetch a block's coinbase transaction, whatever verbosity the node supports. */
  async fetchCoinbase(hashOrHeight) {
    let block;
    try {
      block = await this.rpc.getBlock(hashOrHeight, 2);
    } catch {
      block = null;
    }
    if (block && Array.isArray(block.tx) && block.tx.length && typeof block.tx[0] === 'object') {
      return { block, coinbase: block.tx[0] };
    }
    if (!block) block = await this.rpc.getBlock(hashOrHeight, 1);
    if (!block || !Array.isArray(block.tx) || !block.tx.length) throw new Error('block has no transactions');
    const txid = typeof block.tx[0] === 'string' ? block.tx[0] : block.tx[0].txid;
    const tx = await this.rpc.getRawTransaction(txid, 1);
    return { block, coinbase: tx };
  }

  async blockSubsidyZat(height) {
    const atomic = this.ledger.atomicPerCoin;
    try {
      const s = await this.rpc.getBlockSubsidy(height);
      if (!s) return { minerZat: null, totalZat: null };
      const minerZat = s.minerZat != null ? Math.round(Number(s.minerZat))
        : s.miner != null ? Math.round(Number(s.miner) * atomic) : null;
      let totalZat = minerZat;
      const streams = Array.isArray(s.fundingstreams) ? s.fundingstreams : [];
      for (const f of streams) {
        const v = f.valueZat != null ? Math.round(Number(f.valueZat)) : Math.round(Number(f.value) * atomic);
        if (Number.isFinite(v) && Number.isFinite(totalZat)) totalZat += v;
      }
      if (s.lockboxstreams) {
        for (const f of s.lockboxstreams) {
          const v = f.valueZat != null ? Math.round(Number(f.valueZat)) : Math.round(Number(f.value) * atomic);
          if (Number.isFinite(v) && Number.isFinite(totalZat)) totalZat += v;
        }
      }
      return { minerZat: Number.isFinite(minerZat) ? minerZat : null, totalZat: Number.isFinite(totalZat) ? totalZat : null };
    } catch {
      return { minerZat: null, totalZat: null };
    }
  }

  async recordTransparentBlock(hash) {
    const { block, coinbase } = await this.fetchCoinbase(hash);
    const paidZat = coinbasePaidTo(coinbase, this.address.value, this.ledger.atomicPerCoin);
    if (paidZat <= 0) {
      this.log(`block ${String(hash).slice(0, 12)}… does not pay this machine's address; not counted`);
      return null;
    }
    const height = Number(block.height);
    const subsidy = await this.blockSubsidyZat(height);
    const rec = this.ledger.record({
      hash: String(block.hash || hash).toLowerCase(),
      height,
      time: Number(block.time) || null,
      mode: 'transparent',
      paidZat,
      subsidyZat: subsidy.totalZat,
      minerSubsidyZat: subsidy.minerZat
    });
    this.emit('reward', rec);
    return rec;
  }

  async recordShieldedBlock({ height, hash }) {
    const subsidy = await this.blockSubsidyZat(height);
    const rec = this.ledger.record({
      hash, height, mode: 'shielded',
      subsidyZat: subsidy.totalZat,
      minerSubsidyZat: subsidy.minerZat,
      time: null
    });
    this.emit('reward', rec);
    return rec;
  }

  /**
   * Backstop scan: walk forward from where mining started and pick up any
   * block that pays our transparent address but whose "accepted" line we
   * missed (a worker crashed, the app restarted, the line was truncated).
   * Bounded per tick so it never blocks the UI.
   */
  async scanForRewards() {
    if (this.address.kind !== 'transparent') return;
    if (!Number.isInteger(this.chain.height)) return;
    if (this.scanCursor == null) return;
    let budget = SCAN_BUDGET_PER_TICK;
    while (this.scanCursor <= this.chain.height && budget > 0) {
      const h = this.scanCursor;
      budget -= 1;
      try {
        const { block, coinbase } = await this.fetchCoinbase(h);
        const paidZat = coinbasePaidTo(coinbase, this.address.value, this.ledger.atomicPerCoin);
        if (paidZat > 0) {
          const subsidy = await this.blockSubsidyZat(h);
          this.ledger.record({
            hash: String(block.hash).toLowerCase(),
            height: h,
            time: Number(block.time) || null,
            mode: 'transparent',
            paidZat,
            subsidyZat: subsidy.totalZat,
            minerSubsidyZat: subsidy.minerZat
          });
        }
      } catch {
        return; // node busy; try again next tick from the same cursor
      }
      this.scanCursor = h + 1;
    }
  }

  // ---------------------------------------------------------------- polling
  ensureTicking() {
    if (this.timer) return;
    // ONE TICK AT A TIME. A tick can await a node restart, which takes
    // seconds; without this guard the next second's tick runs on top of it,
    // sees a half-restarted node, and starts a second restart. See N-8.
    this.timer = setInterval(() => {
      if (this._ticking) return;
      this._ticking = true;
      this.tick().catch(() => {}).finally(() => { this._ticking = false; });
    }, TICK_MS);
    if (this.timer.unref) this.timer.unref();
  }

  /**
   * Compare what the node says about itself with the profile that was chosen.
   *
   * Three outcomes, and the middle one matters: `ok: null` means the node did
   * not say, which is not evidence of anything and never stops a node that
   * works today. `ok: false` is the node naming a different network, and that
   * is refused. On the production profile "did not say" IS a failure, because
   * a zebrad without SwarmMainnet support cannot say "swarm-mainnet".
   */
  applyChainCheck(reported) {
    const before = this.chainCheck ? this.chainCheck.ok : undefined;
    this.chainCheck = checkNodeChain(this.profile, reported, { expected: this.expectedChainLabel });
    if (this.chainCheck.ok === false && before !== false) {
      this.lastError = this.chainCheck.error;
      this.log(this.chainCheck.error);
    }
    return this.chainCheck;
  }

  /**
   * Everything that must be true about the node before a single hash is
   * computed: it is on the chain this app selected, and it holds that chain's
   * genesis block. Both are "unknown until asked", and unknown never blocks.
   */
  chainMismatch() {
    if (this.chainCheck && this.chainCheck.ok === false) return this.chainCheck.error;
    if (this.genesisState && this.genesisState.ok === false && this.genesisState.error === 'wrong chain') {
      const g = checkNodeGenesis(
        (this.manifest.genesis || {}).hash,
        this.genesisState.hash
      );
      return g.error || 'This node holds another network’s genesis block.';
    }
    return null;
  }

  async refreshChain() {
    if (!this.node || !this.node.running) {
      this.chain = { ...this.chain, height: null, peers: 0, peersIn: 0, peersOut: 0, synced: null, tipAgeSec: null };
      return;
    }
    try {
      const info = await this.rpc.getBlockchainInfo();
      if (info) {
        this.chain.height = Number(info.blocks);
        this.chain.bestHash = info.bestblockhash || null;
        this.chain.difficulty = Number(info.difficulty) || null;
        this.chain.verificationProgress = info.verificationprogress != null ? Number(info.verificationprogress) : null;
        // Deliberately NOT derived from info.estimatedheight — see the note in
        // sync-gate.js. That field extrapolates from the genesis timestamp and
        // reports a brand-new chain as thousands of blocks behind for ever.
        this.chain.estimatedHeight = Number.isFinite(Number(info.estimatedheight)) ? Number(info.estimatedheight) : null;
        // WRONG-CHAIN DETECTION. The node names the network it is on in its
        // own getblockchaininfo. Compare it with the profile this app was
        // asked to run, every tick, and remember the verdict: mining refuses
        // to start on a mismatch. On the production profile the answer must be
        // the exact chain label, which is also the only proof that this zebrad
        // understands SwarmMainnet at all.
        this.applyChainCheck(info.chain != null ? info.chain : info.chainname);
      }
    } catch (e) {
      if (e.code !== 'NO_COOKIE') this.lastError = e.message;
      return;
    }

    try {
      const peers = await this.rpc.getPeerInfo();
      if (Array.isArray(peers)) {
        this.chain.peers = peers.length;
        this.chain.peersIn = peers.filter((p) => p && (p.inbound === true || p.addr_direction === 'inbound')).length;
        this.chain.peersOut = this.chain.peers - this.chain.peersIn;
      }
    } catch { /* keep the previous value */ }

    try {
      if (this.chain.bestHash) {
        const tip = await this.rpc.getBlock(this.chain.bestHash, 1);
        if (tip && Number.isFinite(Number(tip.time))) {
          this.chain.tipTimeUnix = Number(tip.time);
          this.chain.tipAgeSec = tipAgeSeconds(this.chain.tipTimeUnix);
        }
      }
    } catch { /* keep the previous value */ }

    try {
      const solps = await this.rpc.getNetworkSolps();
      const v = Number(solps);
      // getnetworksolps returns 0 on a chain with too few blocks to estimate.
      // Zero is not a measurement, so it is reported as unknown.
      this.chain.networkSolps = Number.isFinite(v) && v > 0 ? v : null;
    } catch { /* keep the previous value */ }

    // When did this node last accept a new block? That separates "still
    // downloading" (blocks pouring in) from "the chain is quiet" (nothing
    // arriving because nothing was made), which tip age alone cannot do.
    if (Number.isInteger(this.chain.height) && this.chain.height !== this._lastSeenHeight) {
      this._lastSeenHeight = this.chain.height;
      this.lastHeightChangeAt = Date.now();
    }

    // Ask the independent tip oracle. It rate-limits itself and never throws.
    this.tipOracle.refresh().catch(() => {});
    const oracle = this.tipOracle.current();
    this.chain.networkHeight = oracle ? oracle.height : null;
    this.chain.networkHeightAt = oracle ? oracle.at : null;
    this.chain.networkHeightError = oracle ? null : this.tipOracle.lastError;

    // "Up to date": peers, and within a block or two of the independent tip.
    // Never a claim of certainty, and never derived from tip age alone.
    const minPeers = this.gate.minPeers;
    if (this.chain.peers < minPeers) this.chain.synced = null;
    else if (oracle && Number.isInteger(this.chain.height)) {
      this.chain.synced = oracle.height - this.chain.height <= this.gate.maxBehind;
    } else this.chain.synced = null;
  }

  idleGate() {
    if (this.settings.idleOnly !== true) return { pause: false, idleSec: null };
    if (typeof this.idleSeconds !== 'function') return { pause: false, idleSec: null };
    let idleSec = null;
    try { idleSec = Number(this.idleSeconds()); } catch { return { pause: false, idleSec: null }; }
    if (!Number.isFinite(idleSec)) return { pause: false, idleSec: null };
    return { pause: idleSec < IDLE_THRESHOLD_S, idleSec };
  }

  async tick() {
    await this.refreshChain();

    if (this.node && this.node.running) {
      this._sizeTick = (this._sizeTick + 1) % 30;
      if (this._sizeTick === 1) this.chain.stateBytes = this.node.stateSizeBytes();
    }

    const decision = this.evaluateGate();

    // Auto-pause: the gate closed while mining was running.
    //
    // N-8. Shielded mining is switched on by RESTARTING the node, because
    // Zebra reads that setting only at start-up. A node that started three
    // seconds ago has no peers and no height yet - not because anything went
    // wrong, but because it has not finished connecting. Pausing on that
    // stopped mining, which restarted the node AGAIN to switch the miner off,
    // which reset the chain state again, and the two halves of this branch
    // drove each other in a circle: "the app updates the node but it drops
    // out of the mining process ... it keeps loading but never keeps going".
    //
    // So a running node is given until SETTLE_AFTER_RESTART_MS to connect
    // before its silence is read as a failure. Nothing else is suppressed: a
    // node that is genuinely dead, or on the wrong chain, still stops mining
    // at once, because `settling` requires the node to be running.
    const upFor = this.node && this.node.startedAt ? Date.now() - this.node.startedAt : Infinity;
    const settling = !!(this.node && this.node.running) && upFor < SETTLE_AFTER_RESTART_MS;

    if (this.mining.on && !decision.allow && settling) {
      // Say it once, so the Log explains the wait instead of going quiet.
      if (!this._settleNoted) {
        this._settleNoted = true;
        this.log('the node has just restarted; waiting for it to reconnect before judging it');
      }
    } else if (this.mining.on && !decision.allow) {
      this.mining.pausedByGate = true;
      this.log(`mining paused (${decision.reason}): ${decision.message}`);
      await this.stopMiningInternal('sync gate closed');
      this.mining.pausedByGate = true;
    } else if (!this.mining.on && this.mining.pausedByGate && decision.allow && this.settings.autoResume !== false) {
      this.mining.pausedByGate = false;
      this.log('mining resumed: the node has peers again and its tip is current');
      await this.startMining();
    } else if (!this.mining.on && this.mining.wanted && !this.mining.armed && !this.mining.pausedByGate
               && decision.allow && this.node && this.node.running) {
      // The user pressed the one button and something interrupted the path
      // between there and mining. The intent did not go away, so neither
      // does the attempt.
      this.mining.armed = true;
    } else if (!this.mining.on && this.mining.armed && decision.allow) {
      // The user pressed "Start mining when ready" while the node was still
      // catching up. This is that promise being kept.
      this.mining.armed = false;
      this._settleNoted = false;
      this.log('starting mining: your node is ready, as you asked');
      const r = await this.startMining();
      if (r && r.ok === false) this.log(`could not start mining: ${r.error}`);
    }

    // Idle-only: pause while the machine is in use.
    const idle = this.idleGate();
    if (this.mining.on && idle.pause && !this.mining.pausedByIdle) {
      this.mining.pausedByIdle = true;
      this.log('mining paused: you are using this machine');
      await this.stopMiningInternal('machine in use');
      this.mining.pausedByIdle = true;
    } else if (!this.mining.on && this.mining.pausedByIdle && !idle.pause && decision.allow) {
      this.mining.pausedByIdle = false;
      this.log('mining resumed: the machine has been idle');
      await this.startMining();
    }

    if (this.mining.on && this.mining.mode === 'standard') await this.scanForRewards();

    // An address saved while the node was down is usable but unconfirmed.
    // Once the node is answering, ask it - quietly, once, and never in a way
    // that can take a working address away from the user.
    await this.confirmAddressIfPending();

    this.emit('state', this.getState(decision));
  }

  // ---------------------------------------------------------------- state
  getState(decision) {
    const d = decision || this.evaluateGate();
    const totals = this.ledger.totals(Number.isInteger(this.chain.height) ? this.chain.height : 0);
    const poolSolps = this.pool ? this.pool.solps() : null;
    // The shielded engine's rate comes from the node's own log, and only while
    // it is fresh. A stale reading is dropped, never shown as current.
    const nodeSolps = this.solverRate && Date.now() - this.solverRate.at <= SOLVER_RATE_MAX_AGE_MS
      ? this.solverRate.solps
      : null;
    const solps = poolSolps != null ? poolSolps : nodeSolps;

    const snapshot = {
      network: {
        name: this.manifest.identity.network_name,
        chain: this.manifest.identity.chain,
        ticker: this.manifest.identity.ticker,
        // THE PROFILE DECIDES, not a key the manifests do not carry. This read
        // `identity.is_testnet !== false`, and neither network.json nor
        // network-mainnet.json has an `is_testnet` key at all, so it was always
        // true: a SWARM mainnet build described itself as a testnet.
        isTestnet: this.profile.production !== true,
        status: this.manifest.status,
        // Which SWARM network this app is running, as the profile that decides
        // the configuration shape, the payout address rules and the chain check.
        profile: this.profile.id,
        profileLabel: this.profile.label,
        // How to name this network's payout addresses, so the wording in the
        // UI follows the profile instead of naming the testnet's prefixes on
        // a network where they would be wrong.
        transparentHint: `${this.profile.transparent.p2pkh}…`,
        unifiedHint: this.profile.unifiedPrefixes.map((u) => `${u}…`).join(' or '),
        production: this.profile.production === true,
        chainLabel: this.expectedChainLabel,
        // The two things that identify a chain beyond argument, on every
        // screen that shows the network. "Which network am I on" was not
        // answerable anywhere in the app: the header said SwarmTestnet on a
        // mainnet build and nothing else said anything at all.
        genesisHash: ((this.manifest.genesis || {}).hash) || null,
        genesisShort: ((this.manifest.genesis || {}).hash || '').slice(0, 8) || null,
        p2pPort: this.profile.ports.p2p,
        rpcPort: this.profile.ports.rpc
      },
      node: {
        running: !!(this.node && this.node.running),
        pid: this.node ? this.node.pid : null,
        uptimeSec: this.node && this.node.startedAt ? Math.floor((Date.now() - this.node.startedAt) / 1000) : 0,
        height: this.chain.height,
        bestHash: this.chain.bestHash,
        tipAgeSec: this.chain.tipAgeSec,
        peers: this.chain.peers,
        peersIn: this.chain.peersIn,
        peersOut: this.chain.peersOut,
        synced: this.chain.synced,
        networkHeight: this.chain.networkHeight,
        networkHeightAt: this.chain.networkHeightAt,
        networkHeightError: this.chain.networkHeightError,
        verificationProgress: this.chain.verificationProgress,
        stateBytes: this.chain.stateBytes,
        dataDir: this.dataDir,
        p2pPort: this.p2pPort,
        p2pMoved: this.p2pMoved,
        rpcMoved: this.rpcMoved,
        rpcPort: this.rpcPort,
        lastStop: this.node ? this.node.lastStopReport : null,
        genesis: this.genesisState,
        chainCheck: this.chainCheck,
        // Why the node is not running, in words, when something is wrong.
        trouble: this.nodeTrouble || null
      },
      mining: {
        on: this.mining.on,
        mode: this.mining.mode,
        standardAvailable: this.standardMiningAvailable(),
        standardSimulated: this.simulateStandardMiner,
        workers: this.pool ? this.pool.workerCount : 0,
        pids: this.pool ? this.pool.workers.map((w) => w.pid).filter(Boolean) : [],
        intensity: this.effectiveWorkerCount(),
        maxWorkers: Math.max(1, (require('os').cpus().length || 2) - 1),
        armed: this.mining.armed === true,
        wanted: this.mining.wanted === true,
        pausedByGate: this.mining.pausedByGate,
        pausedByIdle: this.mining.pausedByIdle,
        idleOnly: this.settings.idleOnly === true,
        uptimeSec: this.mining.startedAt ? Math.floor((Date.now() - this.mining.startedAt) / 1000) : 0,
        // Sol/s is shown ONLY when something measured it. The standard miner
        // reports its own rate on its own output; the node's internal miner
        // reports the rate its solver measured, in the node's log. When neither
        // exists this stays null and the UI shows "—".
        solps,
        solpsSource: poolSolps != null ? 'miner output' : nodeSolps != null ? 'node log' : null,
        benchmark: this.benchmark
      },
      gate: d,
      rewards: {
        blocksFound: totals.blocksFound,
        transparentBlocks: totals.transparentBlocks,
        shieldedBlocks: totals.shieldedBlocks,
        spendableZat: totals.spendableZat,
        maturingZat: totals.maturingZat,
        totalZat: totals.totalZat,
        shieldedSubsidyZat: totals.shieldedSubsidyZat,
        shieldedIsLabelOnly: totals.shieldedIsEstimateOfSubsidyOnly,
        nextMaturesInBlocks: totals.nextMaturesInBlocks,
        maturity: this.ledger.maturity,
        atomicPerCoin: this.ledger.atomicPerCoin,
        blocks: this.ledger.list().slice(0, 50)
      },
      network_stats: {
        networkSolps: this.chain.networkSolps,
        difficulty: this.chain.difficulty
      },
      payout: {
        address: this.address.value,
        kind: this.address.kind,
        detail: this.address.detail,
        confirmed: this.address.confirmed === true,
        // Set only when a RUNNING node told us it does not recognise the
        // address. Never set because the node could not be asked.
        rejected: this.address.rejected === true
      },
      binaries: this.binaryStatus(),
      lastError: this.lastError
    };

    // What the Mining page's one big button does right now. Decided here, from
    // the same snapshot the UI receives, so the button and the explanation next
    // to it can never disagree. See next-action.js.
    snapshot.next = nextAction(snapshot);
    return snapshot;
  }

  /**
   * Catch up on an address the node could not be asked about at the time.
   *
   * It only ever ADDS information. If the node says the address is good, the
   * app stops calling it unconfirmed; if the node says it is bad, that is
   * said once, loudly, in the log - but the stored address is left alone,
   * because silently discarding what somebody typed is worse than being
   * wrong about it out loud.
   */
  async confirmAddressIfPending() {
    if (!this.address.value || this.address.confirmed) return;
    if (!(this.node && this.node.running)) return;
    if (this._confirming) return;
    this._confirming = true;
    try {
      // THE PROFILE, ALWAYS. This call omitted it, so it fell back to the
      // module default - swarm-testnet - and on a mainnet build every
      // pending re-check decided the owner's own s3 payout address
      // "belongs to the other network". The address was fine and the node
      // had already confirmed it; the Mining screen still said the node did
      // not recognise it and told them to replace it.
      const r = await validateWithNode(this.rpc, this.address.value, this.profile.id);
      if (r.confirmed === true && r.ok) {
        this.address = { value: r.address, kind: r.kind, detail: r.detail, confirmed: true };
        this.settings.payoutKind = r.kind;
        this.settings.payoutDetail = r.detail;
        this.saveSettings(this.settings);
        this.log(`your node confirmed the payout address (${r.kind})`);
      } else if (r.ok === false && r.confirmed === false && !r.error.includes('could not be checked')) {
        this.log(`your node does not recognise the payout address: ${r.error}`);
        this.address.confirmed = false;
        this.address.rejected = true;
      }
    } catch { /* a node that stops mid-check is not an answer either */ } finally {
      this._confirming = false;
    }
  }

  /**
   * End the older version's daemon the user was told about, and carry on.
   *
   * Only ever called with a process this app has just reported to the user,
   * and only after they pressed the button. It never goes looking for
   * something to kill.
   */
  async stopForeignNode() {
    const t = this.nodeTrouble;
    const pid = t && Number.isInteger(t.pid) ? t.pid : (findForeignNode(this.dataDir, this.node ? this.node.pid : null) || {}).pid;
    if (!Number.isInteger(pid)) {
      this.nodeTrouble = null;
      return { ok: true, nothingToStop: true };
    }
    this.log(`stopping the older SWARM node (process ${pid}) so this one can use the chain folder`);
    const r = stopNodeProcess(pid);
    if (!r.ok) {
      this.log(`could not stop process ${pid}: ${r.error || 'it is still running'}`);
      return { ok: false, error: `Could not stop process ${pid}. Close the older SWARM Node yourself, or restart the computer.` };
    }
    clearRecord(this.dataDir);
    this.nodeTrouble = null;
    this.lastError = null;
    return this.startNode();
  }

  // ---------------------------------------------------------------- settings
  async setPayoutAddress(raw) {
    const result = await validateWithNode(this.rpc, raw, this.profile.id);
    if (!result.ok) return result;
    const changed = result.address !== this.address.value;
    this.address = {
      value: result.address,
      kind: result.kind,
      detail: result.detail,
      rejected: false,
      // False when the node could not be asked. The address is usable - the
      // shape is right and mining will pay it - but the app does not claim
      // the node has blessed it, and asks again once the node is up.
      confirmed: result.confirmed === true
    };
    this.settings.payoutAddress = result.address;
    this.settings.payoutKind = result.kind;
    this.settings.payoutDetail = result.detail;

    // Pre-select the engine the address can actually use, rather than leaving
    // "Standard - many cores" selected next to a shielded-only address. A
    // transparent address drives the standalone miner; a unified one drives the
    // node's own miner, which the app now gives the same number of cores.
    // There is no third option.
    const fits = Array.isArray(result.modes) && result.modes.length ? result.modes[0] : null;
    if (fits && fits !== this.mining.mode && !this.mining.on) {
      this.mining.mode = fits;
      this.settings.miningMode = fits;
      this.log(fits === 'shielded'
        ? 'that is a unified address, so shielded mining (many cores) is selected'
        : 'that is a transparent address, so standard mining (many cores) is selected');
    }

    this.saveSettings(this.settings);
    this.log(result.confirmed === true
      ? `payout address set (${result.kind}); the node confirmed it`
      : `payout address set (${result.kind}); it has the right shape but the node could not be asked yet`);
    // The node carries the payout in its own config, so it must be rewritten.
    if (this._restartRun) await this._restartRun;
    if (changed && this.node && this.node.running) {
      await this.restartNode('the payout address changed');
    }
    return { ...result, modes: result.modes };
  }

  async setMiningMode(mode) {
    const m = mode === 'shielded' ? 'shielded' : 'standard';
    if (m === this.mining.mode) return { ok: true, mode: m };
    const wasOn = this.mining.on;
    if (wasOn) await this.stopMiningInternal('mining mode changed');
    this.mining.mode = m;
    this.settings.miningMode = m;
    this.saveSettings(this.settings);
    if (wasOn) await this.startMining();
    return { ok: true, mode: m, needsAddressKind: m === 'shielded' ? 'unified' : 'transparent' };
  }

  async setIntensity(n) {
    const max = Math.max(1, (require('os').cpus().length || 2) - 1);
    const v = Math.max(1, Math.min(max, Math.round(Number(n) || 1)));
    const was = this.settings.intensity;
    this.settings.intensity = v;
    this.saveSettings(this.settings);
    if (this.pool && this.pool.running) await this.pool.setCount(v);
    // The node reads its thread count only when it starts, so a shielded miner
    // that is already running keeps the count it started with. Say so rather
    // than letting the slider claim a change it did not make.
    if (this.mining.on && this.mining.mode === 'shielded' && v !== was) {
      this.log(`shielded mining will use ${v} ${v === 1 ? 'core' : 'cores'} the next time the node starts`);
      return { ok: true, intensity: v, max, appliesAfterRestart: true };
    }
    return { ok: true, intensity: v, max };
  }

  setIdleOnly(v) {
    this.settings.idleOnly = v === true;
    this.saveSettings(this.settings);
    if (!this.settings.idleOnly) this.mining.pausedByIdle = false;
    return { ok: true, idleOnly: this.settings.idleOnly };
  }

  /**
   * The first-node override. Only ever set from an explicit, confirmed UI
   * action; it changes the generated node config, so the node restarts.
   */
  async setFirstNodeOverride(on, confirmationPhrase) {
    const want = on === true;
    if (want && String(confirmationPhrase || '').trim().toUpperCase() !== 'FIRST NODE') {
      return { ok: false, error: 'Type FIRST NODE to confirm you are starting a brand-new network.' };
    }
    this.settings.firstNodeOverride = want;
    this.gate.setFirstNode(want);
    this.saveSettings(this.settings);
    this.log(want
      ? 'FIRST NODE override on: mining is allowed with no peers. Blocks you find are confirmed by nobody else until other nodes join.'
      : 'FIRST NODE override off: mining again requires at least one peer and a current tip.');
    if (this.node && this.node.running) await this.restartNode('the first-node override changed');
    return { ok: true, firstNode: want };
  }

  async setDataDir(dir) {
    if (typeof dir !== 'string' || !dir.trim()) return { ok: false, error: 'Choose a folder.' };
    if (this.node && this.node.running) return { ok: false, error: 'Stop the node before moving its data folder.' };
    // Per profile. Two chains cannot share one state database, so the mainnet
    // folder is remembered separately from the testnet one and neither move
    // drags the other with it.
    this.settings[this.profile.dataDirSetting] = dir;
    this.dataDir = dir;
    this.rpc = new ZebraRpc({ host: '127.0.0.1', port: this.rpcPort, cookieDir: this.dataDir, timeoutMs: 12000 });
    this.saveSettings(this.settings);
    return { ok: true, dataDir: dir };
  }

  async machineCheck() {
    return machineCheck({
      dataDir: this.dataDir,
      p2pPort: this.p2pPort,
      ownNodeRunning: !!(this.node && this.node.running),
      ownNodePort: this.p2pPort
    });
  }

  /**
   * Make sure the node has a port it can actually bind.
   *
   * If the network's port is taken by something else, the node does NOT fail:
   * it moves to a free one. Outbound connections still sync the chain and
   * mining still works; the only thing lost is other nodes being able to
   * connect IN, and the UI says exactly that rather than leaving the user with
   * a node that will not start.
   */
  async chooseP2pPort() {
    if (this.node && this.node.running) return { port: this.p2pPort, moved: false };
    const wanted = Number(this.p2pPort);
    const free = await canBindPort(wanted);
    if (free.ok) { this.p2pMoved = null; return { port: wanted, moved: false }; }

    for (const candidate of [wanted + 1, wanted + 2, wanted + 3, 0]) {
      // 0 asks the operating system for any free port.
      const probe = await canBindPort(candidate || 0);
      if (!probe.ok) continue;
      const chosen = candidate || (await freeEphemeralPort());
      if (!chosen) continue;
      this.p2pMoved = { wanted, chosen, why: free.detail };
      this.log(
        `port ${wanted} is already in use (${free.detail}), so the node will listen on ${chosen} instead. ` +
        'It will still sync and mine; other nodes just cannot connect in to you until ' +
        `port ${wanted} is free.`
      );
      this.p2pPort = chosen;
      return { port: chosen, moved: true };
    }
    this.log(`port ${wanted} is in use and no nearby port is free; the node will try ${wanted} anyway`);
    return { port: wanted, moved: false };
  }

  /**
   * The same for the RPC port, which is loopback-only.
   *
   * The P2P port got this treatment in testnet.2; the RPC port did not, and a
   * second copy of the app on one machine died on start with a Rust panic:
   *   server should start: Os { code: 10048, kind: AddrInUse }
   * A user sees "the node stopped unexpectedly" and has nothing to go on.
   *
   * Nothing connects IN to this port - it is 127.0.0.1 and cookie-protected,
   * and only this app talks to it - so moving it costs the user nothing at
   * all. There is no reason for it ever to be the thing that stops a node.
   */
  async chooseRpcPort() {
    if (this.node && this.node.running) return { port: this.rpcPort, moved: false };
    const wanted = Number(this.rpcPort);
    // 127.0.0.1, not 0.0.0.0: that is the address the node's RPC server binds,
    // and on Windows a socket held on the loopback address does NOT stop a
    // bind to 0.0.0.0 on the same port. Probing the wrong address reported the
    // port free and let the node panic on it anyway.
    const free = await canBindPort(wanted, '127.0.0.1');
    if (free.ok) { this.rpcMoved = null; return { port: wanted, moved: false }; }

    for (const candidate of [wanted + 1, wanted + 2, wanted + 3, 0]) {
      const probe = await canBindPort(candidate || 0, '127.0.0.1');
      if (!probe.ok) continue;
      const chosen = candidate || (await freeEphemeralPort());
      if (!chosen) continue;
      this.rpcMoved = { wanted, chosen, why: free.detail };
      this.log(
        `the node's private control port ${wanted} is already in use (${free.detail}), so this ` +
        `node will use ${chosen}. Nothing else changes: that port is only ever reached from ` +
        'this machine, by this app.'
      );
      this.rpcPort = chosen;
      // The client has to follow the server, or every call would go to
      // whatever else is holding the old port.
      this.rpc = new ZebraRpc({ host: '127.0.0.1', port: this.rpcPort, cookieDir: this.dataDir, timeoutMs: 12000 });
      return { port: chosen, moved: true };
    }
    this.log(`the node's control port ${wanted} is in use and no nearby port is free; trying ${wanted} anyway`);
    return { port: wanted, moved: false };
  }

  // ---------------------------------------------------------------- shutdown
  /** Nothing runs hidden: leave no child process behind. */
  async stopAll() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    // dropMining, not stopMiningInternal: on the way out there is no point
    // restarting the node just to turn the internal miner off.
    this.wantInternalMiner = false;
    const miner = await this.dropMining();
    let node = { graceful: true, ms: 0 };
    if (this.node) node = await this.node.stop({ timeoutMs: Number(this.settings.stopTimeoutMs) || 20000 });
    return { miner, node };
  }
}

module.exports = { ChainEngine, TICK_MS, IDLE_THRESHOLD_S, REASON, splitSubsidy };
