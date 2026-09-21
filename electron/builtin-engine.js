// BuiltinEngine — JS implementation of the engine interface contract.
//
// Used whenever the native Go engine isn't running. Hardware detection is
// REAL (nvidia-smi, then WMI fallback); job execution is SIMULATED — no
// network jobs run through this engine, it exists so the Shell is fully
// drivable end-to-end before the native engine ships. The simulated job
// loop respects start/stop/throttle exactly as the real engine must.

const { execFile } = require('child_process');
const os = require('os');
const { EventEmitter } = require('events');

const TICK_MS = 1000;

// Capability tiers by VRAM — mirrors the network's job-matching bands.
const TIERS = [
  { minVram: 24, tier: 'A — Datacenter-class', ethPerJob: 0.00041, estMonthlyUsd: [220, 380] },
  { minVram: 16, tier: 'B — Enthusiast', ethPerJob: 0.00028, estMonthlyUsd: [140, 240] },
  { minVram: 10, tier: 'C — Gaming', ethPerJob: 0.00017, estMonthlyUsd: [80, 150] },
  { minVram: 6, tier: 'D — Entry', ethPerJob: 0.00009, estMonthlyUsd: [35, 70] },
  { minVram: 0, tier: 'E — Below minimum', ethPerJob: 0, estMonthlyUsd: [0, 0] }
];

const JOB_TYPES = ['image-gen (SDXL)', 'image-gen (Flux)', 'upscale (ESRGAN)'];

function execOut(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 8000, windowsHide: true }, (err, stdout) => {
      resolve(err ? null : String(stdout));
    });
  });
}

class BuiltinEngine extends EventEmitter {
  constructor(config = {}) {
    super();
    this.running = false;
    this.idleOnly = config.idleOnly !== false;
    this.throttle = typeof config.throttle === 'number' ? config.throttle : 80;
    this.hardware = null;
    this.currentJob = null;
    this.jobProgress = 0;
    this.sessionStart = null;
    this.ledger = {
      totalEth: 0,
      jobsCompleted: 0,
      jobsVerified: 0,
      withdrawals: []
    };
    this.timer = null;
  }

  // ---- hardware (REAL detection) ----

  async detectGpu() {
    // Preferred: nvidia-smi gives exact model + VRAM.
    const smi = await execOut('nvidia-smi', [
      '--query-gpu=name,memory.total,driver_version',
      '--format=csv,noheader,nounits'
    ]);
    if (smi) {
      const [name, memMb, driver] = smi.trim().split('\n')[0].split(',').map((s) => s.trim());
      return { model: name, vramGb: Math.round(Number(memMb) / 1024), driver, source: 'nvidia-smi' };
    }
    // Fallback: WMI (works for AMD/Intel too, VRAM capped at 4GB by the API).
    const wmi = await execOut('powershell.exe', [
      '-NoProfile', '-Command',
      "Get-CimInstance Win32_VideoController | Select-Object -First 1 Name,AdapterRAM | ConvertTo-Json"
    ]);
    if (wmi) {
      try {
        const g = JSON.parse(wmi);
        return {
          model: g.Name || 'Unknown GPU',
          vramGb: g.AdapterRAM ? Math.max(1, Math.round(g.AdapterRAM / 1073741824)) : 0,
          driver: null,
          source: 'wmi'
        };
      } catch { /* fall through */ }
    }
    return { model: 'No GPU detected', vramGb: 0, driver: null, source: 'none' };
  }

  async measureBandwidth() {
    // Placeholder until the real engine does a measured transfer against
    // the dispatch server. Reports interface presence only.
    const ifaces = os.networkInterfaces();
    const online = Object.values(ifaces).flat().some((i) => i && !i.internal && i.family === 'IPv4');
    return { online, downMbps: online ? null : 0, upMbps: online ? null : 0 };
  }

  async scan() {
    const gpu = await this.detectGpu();
    const net = await this.measureBandwidth();
    const tier = TIERS.find((t) => gpu.vramGb >= t.minVram);
    this.hardware = {
      gpu: gpu.model,
      vramGb: gpu.vramGb,
      gpuSource: gpu.source,
      driver: gpu.driver,
      cpu: os.cpus()[0] ? os.cpus()[0].model.trim() : 'Unknown CPU',
      cores: os.cpus().length,
      ramGb: Math.round(os.totalmem() / 1073741824),
      platform: `${os.platform()} ${os.release()}`,
      online: net.online,
      tier: tier.tier,
      ethPerJob: tier.ethPerJob,
      estMonthlyUsd: tier.estMonthlyUsd,
      eligible: tier.ethPerJob > 0
    };
    return this.hardware;
  }

  async getHardware() {
    return this.hardware || this.scan();
  }

  // ---- lifecycle ----

  async start() {
    if (this.running) return this.getStatus();
    if (!this.hardware) await this.scan();
    this.running = true;
    this.sessionStart = Date.now();
    this.timer = setInterval(() => this.tick(), TICK_MS);
    return this.getStatus();
  }

  async stop() {
    // Contract: stop is instant and halts all compute.
    this.running = false;
    this.currentJob = null;
    this.jobProgress = 0;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.emitState();
    return this.getStatus();
  }

  setIdleOnly(v) { this.idleOnly = !!v; return { idleOnly: this.idleOnly }; }
  setThrottle(v) { this.throttle = Math.max(0, Math.min(100, Number(v) || 0)); return { throttle: this.throttle }; }
  setAccount(addr) { this.payoutAddress = String(addr || ''); return { ok: true, payoutAddress: this.payoutAddress }; }
  pause() { this.paused = true; return this.getStatus(); }
  resume() { this.paused = false; return this.getStatus(); }
  getHistory() { return this.history || []; }
  getLogs() { return ['[builtin] native engine offline — running on the builtin fallback (no real jobs)']; }
  getMachineId() { return { fingerprint: 'unavailable (native engine offline)', machineHash: '' }; }

  // ---- simulated job loop (replaced by the sandboxed runner in the Go engine) ----

  tick() {
    if (!this.running) return;
    if (this.throttle === 0) { this.emitState(); return; }

    if (!this.currentJob) {
      // New job arrives over the (simulated) dispatch channel.
      this.currentJob = {
        id: 'job_' + Math.random().toString(36).slice(2, 10),
        type: JOB_TYPES[Math.floor(Math.random() * JOB_TYPES.length)]
      };
      this.jobProgress = 0;
    } else {
      // Throttle scales how fast work progresses, like a GPU utilization cap.
      this.jobProgress += (8 + Math.random() * 10) * (this.throttle / 100);
      if (this.jobProgress >= 100) {
        this.ledger.jobsCompleted += 1;
        // ~98% of simulated jobs verify, matching expected network behavior.
        if (Math.random() < 0.98) {
          this.ledger.jobsVerified += 1;
          this.ledger.totalEth += this.hardware ? this.hardware.ethPerJob : 0;
        }
        this.currentJob = null;
        this.jobProgress = 0;
      }
    }
    this.emitState();
  }

  // ---- state + earnings ----

  getStatus() {
    return {
      running: this.running,
      online: this.hardware ? this.hardware.online : false,
      idleOnly: this.idleOnly,
      throttle: this.throttle,
      currentJob: this.currentJob
        ? { ...this.currentJob, progress: Math.min(99, Math.round(this.jobProgress)) }
        : null
    };
  }

  getEarnings() {
    const verifiedRate = this.ledger.jobsCompleted
      ? this.ledger.jobsVerified / this.ledger.jobsCompleted
      : 1;
    return {
      totalEth: this.ledger.totalEth,
      sessionUptime: this.sessionStart && this.running
        ? Math.floor((Date.now() - this.sessionStart) / 1000)
        : 0,
      jobsCompleted: this.ledger.jobsCompleted,
      verifiedRate
    };
  }

  withdraw(addr) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(addr || '')) {
      return { ok: false, error: 'Invalid wallet address (expected 0x… 40 hex chars).' };
    }
    if (this.ledger.totalEth <= 0) {
      return { ok: false, error: 'Nothing to withdraw yet.' };
    }
    const amount = this.ledger.totalEth;
    this.ledger.totalEth = 0;
    this.ledger.withdrawals.push({ addr, amount, at: new Date().toISOString() });
    // Real engine: fires a payout claim against the network's L2 settlement
    // contract. Builtin: records the claim locally.
    return { ok: true, amount, addr, note: 'Payout claim queued (simulated — native engine settles on L2).' };
  }

  emitState() {
    this.emit('state', { status: this.getStatus(), earnings: this.getEarnings() });
  }
}

module.exports = { BuiltinEngine };
