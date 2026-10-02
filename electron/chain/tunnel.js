// The tunnel to the SWARM server, run inside the app: no WireGuard install,
// no administrator rights, no network adapter.
//
// During the closed start the server node's peer port is reachable only
// inside a private WireGuard network (see access-code.js). This file runs the
// bundled user-space WireGuard port forwarder, onetun (MIT, built from source
// at a pinned release in CI; its SHA-256 is pinned beside the node's), as a
// child process of the app. It listens on 127.0.0.1:<local port> ONLY and
// carries each TCP connection through the tunnel to the server node; the
// node's single peer is that local port.
//
// RULES THIS FILE KEEPS
//   * the private key reaches the forwarder through its environment
//     (ONETUN_PRIVATE_KEY), never on a command line other processes can list,
//     and never in a file;
//   * the listener is loopback, always: the source address is written here,
//     not taken from anywhere;
//   * nothing the forwarder prints reaches the app's log as it is: key-shaped
//     text is removed and only state changes are said, in words;
//   * it is supervised: started before the node, restarted with a growing
//     wait if it exits, and stopped with the app. Nothing runs hidden.

'use strict';

const { spawn } = require('child_process');
const { EventEmitter } = require('events');

// The forwarder's own log, as pretty_env_logger writes it. boringtun's
// handshake events are debug-level, so the filter lifts that one module.
const LOG_FILTER = 'info,boringtun=debug';
// Seconds between keepalives, as the kits used (PersistentKeepalive = 25).
const KEEPALIVE_S = 25;
// WireGuard rekeys every two minutes while packets flow, and the keepalive
// keeps them flowing, so a fresh handshake is never more than about two
// minutes old on a working tunnel. Allow some slack before saying otherwise.
const HANDSHAKE_FRESH_MS = 5 * 60 * 1000;
const READY_TIMEOUT_MS = 10000;
const BIND_GRACE_MS = 800;
const BACKOFF_MS = [1000, 2000, 5000, 10000, 30000, 60000];
const STABLE_AFTER_MS = 5 * 60 * 1000;

/** Anything shaped like a WireGuard key or longer base64 is cut out. */
function redact(line) {
  return String(line)
    .replace(/[A-Za-z0-9+/]{40,}={0,2}/g, '[redacted]')
    .replace(/SWARMKEY1\.[A-Za-z0-9_.-]+/g, '[redacted]');
}

/** What a forwarder line tells us, or null. Pure, for tests. */
function classifyLine(line) {
  const t = String(line);
  if (/Tunneling TCP \[/.test(t)) return 'listening';
  if (/Port-forward failed|Failed to listen on TCP proxy server/.test(t)) return 'bind-failed';
  if (/New session/.test(t)) return 'handshake';
  if (/HANDSHAKE\(REKEY_TIMEOUT\)|handshake has expired|CONNECTION_EXPIRED/i.test(t)) return 'handshake-timeout';
  if (/Configuration has errors|Invalid private key|Invalid endpoint|Failed to initialize WireGuard/i.test(t)) return 'config-error';
  if (/Incoming connection from/.test(t)) return 'connection';
  return null;
}

/**
 * The forwarder's command line. The key is NOT here: see env().
 * @param {object} payload  a parsed access code (access-code.js)
 * @param {number} localPort
 */
function buildArgs(payload, localPort) {
  const port = Number(localPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('the tunnel needs a local port');
  return [
    `127.0.0.1:${port}:${payload.nodeHost}:${payload.nodePort}:TCP`,
    '--endpoint-addr', payload.endpoint,
    '--endpoint-public-key', payload.serverPublicKey,
    '--source-peer-ip', payload.tunnelAddress,
    '--keep-alive', String(KEEPALIVE_S),
    '--log', LOG_FILTER
  ];
}

/** The forwarder's environment: ours, minus any ONETUN_ setting, plus the key. */
function buildEnv(payload, base = process.env) {
  const env = {};
  for (const [k, v] of Object.entries(base || {})) {
    if (!/^ONETUN_/i.test(k)) env[k] = v;
  }
  env.ONETUN_PRIVATE_KEY = payload.privateKey;
  return env;
}

class TunnelForwarder extends EventEmitter {
  /**
   * @param {object} cfg
   *   payload      {object}   parsed access code
   *   binary       {function} () => {ok, path, reason} - the verified forwarder
   *   choosePort   {function} async () => number - a free loopback port
   *   spawnImpl    {function} child_process.spawn, replaceable in tests
   *   now          {function} clock, replaceable in tests
   *   backoffMs    {number[]} waits between restarts
   */
  constructor(cfg) {
    super();
    this.payload = cfg.payload;
    this.binary = cfg.binary;
    this.choosePort = cfg.choosePort;
    this.spawnImpl = cfg.spawnImpl || spawn;
    this.now = cfg.now || Date.now;
    this.backoffMs = Array.isArray(cfg.backoffMs) && cfg.backoffMs.length ? cfg.backoffMs : BACKOFF_MS;
    this.readyTimeoutMs = cfg.readyTimeoutMs || READY_TIMEOUT_MS;
    this.bindGraceMs = cfg.bindGraceMs == null ? BIND_GRACE_MS : cfg.bindGraceMs;

    this.child = null;
    this.pid = null;
    this.localPort = null;
    this.state = 'stopped';          // stopped | starting | running | restarting | failed
    this.wanted = false;
    this.startedAt = null;
    this.restarts = 0;
    this.lastError = null;
    this.lastHandshakeAt = null;
    this.lastHandshakeTimeoutAt = null;
    this.lastConnectionAt = null;
    this.recent = [];                // redacted lines, for diagnosis only
    this._restartTimer = null;
    this._startRun = null;
  }

  log(text) { this.emit('log', { t: this.now(), kind: 'app', text: `tunnel: ${text}` }); }

  /** Start it, or return the run already starting it. Resolves {ok, localPort}. */
  start() {
    this.wanted = true;
    if (this.state === 'running' && this.child) return Promise.resolve({ ok: true, localPort: this.localPort });
    if (!this._startRun) {
      this._startRun = this._startOnce().finally(() => { this._startRun = null; });
    }
    return this._startRun;
  }

  async _startOnce() {
    const bin = this.binary();
    if (!bin || !bin.ok) {
      this.state = 'failed';
      this.lastError = (bin && bin.reason) || 'the tunnel program is not bundled with this build';
      this.log(`cannot start: ${this.lastError}`);
      return { ok: false, error: this.lastError };
    }
    let lastErr = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const port = await this.choosePort(attempt);
      const r = await this._spawnAndWait(bin.path, port);
      if (r.ok) return r;
      lastErr = r.error;
      if (r.code !== 'BIND') break;     // only a taken port is worth another port
    }
    this.state = 'failed';
    this.lastError = lastErr;
    if (this.wanted) this._scheduleRestart();
    return { ok: false, error: lastErr };
  }

  _spawnAndWait(binPath, port) {
    return new Promise((resolve) => {
      this.state = this.restarts ? 'restarting' : 'starting';
      this.localPort = port;
      let settled = false;
      let child;
      try {
        child = this.spawnImpl(binPath, buildArgs(this.payload, port), {
          env: buildEnv(this.payload),
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe']
        });
      } catch (e) {
        resolve({ ok: false, error: `the tunnel program could not be started: ${e.message}` });
        return;
      }
      this.child = child;
      this.pid = child.pid || null;
      this.startedAt = this.now();

      const done = (r) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (r.ok) {
          this.state = 'running';
          this.lastError = null;
          this.log(`running on 127.0.0.1:${port}, carrying the node's connection to the SWARM server`);
        }
        resolve(r);
      };
      const timer = setTimeout(() => {
        // No "listening" line in time. Say so, stop it, let the caller decide.
        this._kill(child);
        done({ ok: false, error: 'the tunnel program did not start listening in time' });
      }, this.readyTimeoutMs);

      let bindTimer = null;
      const onLine = (raw) => {
        const line = redact(raw);
        this.recent.push(line.slice(0, 300));
        if (this.recent.length > 60) this.recent.splice(0, this.recent.length - 60);
        const kind = classifyLine(line);
        if (kind === 'listening' && !bindTimer) {
          // The listener is bound right after this line; a failure to bind is
          // reported on the next one. Give it a moment before calling it ready.
          bindTimer = setTimeout(() => done({ ok: true, localPort: port }), this.bindGraceMs);
        } else if (kind === 'bind-failed') {
          if (bindTimer) clearTimeout(bindTimer);
          this._kill(child);
          done({ ok: false, code: 'BIND', error: `port ${port} on this computer could not be used` });
        } else if (kind === 'config-error') {
          this._kill(child);
          done({ ok: false, error: 'the access code was refused by the tunnel program' });
        } else if (kind === 'handshake') {
          const first = this.lastHandshakeAt == null;
          this.lastHandshakeAt = this.now();
          if (first) this.log('connected to the SWARM server (tunnel handshake completed)');
        } else if (kind === 'handshake-timeout') {
          this.lastHandshakeTimeoutAt = this.now();
        } else if (kind === 'connection') {
          this.lastConnectionAt = this.now();
        }
      };
      splitLines(child.stdout, onLine);
      splitLines(child.stderr, onLine);

      child.on('error', (e) => {
        this.lastError = `the tunnel program failed: ${e.message}`;
        done({ ok: false, error: this.lastError });
      });
      child.on('exit', (code, signal) => {
        if (this.child === child) { this.child = null; this.pid = null; }
        if (!settled) {
          done({ ok: false, error: `the tunnel program stopped at once (${signal || `code ${code}`})` });
          return;
        }
        if (this.wanted && this.state !== 'stopped') {
          this.state = 'restarting';
          this.lastError = `the tunnel program stopped (${signal || `code ${code}`})`;
          this.log(`${this.lastError}; starting it again`);
          this._scheduleRestart();
        }
      });
    });
  }

  _scheduleRestart() {
    if (this._restartTimer || !this.wanted) return;
    // A forwarder that ran for a while before stopping starts the count again.
    if (this.startedAt && this.now() - this.startedAt > STABLE_AFTER_MS) this.restarts = 0;
    const wait = this.backoffMs[Math.min(this.restarts, this.backoffMs.length - 1)];
    this.restarts += 1;
    this.state = 'restarting';
    this._restartTimer = setTimeout(() => {
      this._restartTimer = null;
      if (!this.wanted) return;
      this.start().catch(() => {});
    }, wait);
    if (this._restartTimer.unref) this._restartTimer.unref();
  }

  _kill(child) {
    try { if (child && child.exitCode == null) child.kill(); } catch { /* already gone */ }
  }

  /** Stop it and do not start it again. Always safe to call. */
  async stop() {
    this.wanted = false;
    if (this._restartTimer) { clearTimeout(this._restartTimer); this._restartTimer = null; }
    if (this._startRun) { try { await this._startRun; } catch { /* stopping anyway */ } }
    const child = this.child;
    this.state = 'stopped';
    if (!child) return { ok: true, wasRunning: false };
    await new Promise((resolve) => {
      const t = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* gone */ }
        resolve();
      }, 3000);
      child.once('exit', () => { clearTimeout(t); resolve(); });
      this._kill(child);
    });
    this.child = null;
    this.pid = null;
    this.log('stopped');
    return { ok: true, wasRunning: true };
  }

  /** What the status screen shows. No key, no code. */
  status() {
    const now = this.now();
    const hsAge = this.lastHandshakeAt == null ? null : Math.max(0, Math.round((now - this.lastHandshakeAt) / 1000));
    let connected = null;
    if (this.state !== 'running') connected = this.state === 'stopped' ? null : false;
    else if (this.lastHandshakeAt != null && now - this.lastHandshakeAt <= HANDSHAKE_FRESH_MS) connected = true;
    else if (this.lastHandshakeTimeoutAt != null && (this.lastHandshakeAt == null || this.lastHandshakeTimeoutAt > this.lastHandshakeAt)) connected = false;
    else if (this.startedAt && now - this.startedAt > 60000) connected = false;
    return {
      state: this.state,
      running: this.state === 'running' && !!this.child,
      pid: this.pid,
      localPort: this.localPort,
      connected,
      lastHandshakeAt: this.lastHandshakeAt,
      handshakeAgeSec: hsAge,
      restarts: this.restarts,
      lastError: this.lastError
    };
  }
}

function splitLines(stream, onLine) {
  if (!stream) return;
  let buf = '';
  stream.setEncoding && stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      if (line.trim()) onLine(line);
    }
    if (buf.length > 8192) buf = buf.slice(-8192);
  });
}

module.exports = {
  TunnelForwarder, buildArgs, buildEnv, classifyLine, redact,
  HANDSHAKE_FRESH_MS, KEEPALIVE_S, LOG_FILTER
};
