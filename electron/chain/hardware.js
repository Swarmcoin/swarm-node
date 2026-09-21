// Machine check — everything here is measured locally and nothing leaves the
// machine. No capability score is computed, uploaded or compared; no GPU,
// temperature or power figure is reported, because this app has no reliable
// way to read those on every Windows machine and a wrong number is worse than
// no number.
//
// What is reported: CPU model and cores, RAM, free space on the chosen data
// drive, and whether the P2P port is reachable from this machine's own point
// of view. The port check is a hint, not a verdict: only an outside host can
// prove inbound reachability, and the UI says exactly that.

'use strict';

const os = require('os');
const fs = require('fs');
const net = require('net');
const path = require('path');

const MIN_CORES = 2;
const MIN_RAM_GB = 4;
// Headroom for the chain plus the RocksDB write-ahead files. A fresh SWARM
// testnet is tiny; the figure is a guard against installing onto a full disk.
const MIN_FREE_GB = 10;

function cpuInfo() {
  const cpus = os.cpus() || [];
  return {
    model: cpus.length ? String(cpus[0].model).replace(/\s+/g, ' ').trim() : 'Unknown CPU',
    cores: cpus.length || 1,
    arch: os.arch()
  };
}

function freeSpaceBytes(dir) {
  try {
    // Node 18+/22 exposes statfs. Walk up until a directory that exists.
    let probe = path.resolve(dir);
    for (let i = 0; i < 12; i += 1) {
      if (fs.existsSync(probe)) break;
      const parent = path.dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }
    const st = fs.statfsSync(probe);
    return Number(st.bavail) * Number(st.bsize);
  } catch {
    return null;
  }
}

/**
 * Can this machine bind the P2P port? A refusal means something else already
 * holds it. Success says nothing about whether the internet can reach it.
 */
function canBindPort(port, host = '0.0.0.0', timeoutMs = 2000) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    let settled = false;
    const done = (ok, detail) => { if (!settled) { settled = true; try { srv.close(); } catch {} resolve({ ok, detail }); } };
    const t = setTimeout(() => done(false, 'timed out'), timeoutMs);
    srv.once('error', (e) => { clearTimeout(t); done(false, e.code === 'EADDRINUSE' ? 'another program already uses this port' : e.code || e.message); });
    srv.once('listening', () => { clearTimeout(t); done(true, 'free on this machine'); });
    try { srv.listen(port, host); } catch (e) { clearTimeout(t); done(false, e.message); }
  });
}

/**
 * @param {object} opts  dataDir {string}, p2pPort {number}
 * @returns {Promise<object>} machine report; `checks` is ready to render
 */
async function machineCheck(opts = {}) {
  const cpu = cpuInfo();
  const ramGb = os.totalmem() / 1073741824;
  const freeBytes = freeSpaceBytes(opts.dataDir || os.homedir());
  const freeGb = freeBytes == null ? null : freeBytes / 1073741824;
  const port = Number(opts.p2pPort) || 0;
  const bind = port ? await canBindPort(port) : { ok: false, detail: 'no port configured' };

  const checks = [
    {
      key: 'cpu',
      name: 'Processor',
      requirement: `${MIN_CORES} cores or more`,
      found: `${cpu.model} · ${cpu.cores} cores`,
      result: cpu.cores >= MIN_CORES ? 'pass' : 'fail'
    },
    {
      key: 'ram',
      name: 'Memory',
      requirement: `${MIN_RAM_GB} GB or more`,
      found: `${ramGb.toFixed(1)} GB`,
      result: ramGb >= MIN_RAM_GB ? 'pass' : 'fail'
    },
    {
      key: 'disk',
      name: 'Free space where the chain is stored',
      requirement: `${MIN_FREE_GB} GB or more`,
      found: freeGb == null ? 'could not be read' : `${freeGb.toFixed(1)} GB free`,
      result: freeGb == null ? 'warn' : freeGb >= MIN_FREE_GB ? 'pass' : 'fail'
    },
    {
      key: 'port',
      name: `Port ${port} for other nodes`,
      requirement: 'free on this machine',
      found: bind.ok
        ? 'free on this machine — whether your router lets other nodes in cannot be tested from here'
        : `not usable: ${bind.detail}`,
      result: bind.ok ? 'pass' : 'warn'
    },
    {
      key: 'os',
      name: 'System',
      requirement: '64-bit Windows 10 or newer',
      found: `${os.type()} ${os.release()} · ${cpu.arch}`,
      result: cpu.arch === 'x64' ? 'pass' : 'warn'
    }
  ];

  return {
    cpu,
    ramGb,
    freeGb,
    freeBytes,
    platform: `${os.type()} ${os.release()}`,
    // Cores the intensity slider may use: always leave one for the user.
    maxMiningCores: Math.max(1, cpu.cores - 1),
    checks,
    canRunNode: checks.every((c) => c.result !== 'fail'),
    note: 'Every figure here was measured on this machine and stays on it. Nothing is uploaded and no score is calculated.'
  };
}

module.exports = { machineCheck, cpuInfo, freeSpaceBytes, canBindPort, MIN_CORES, MIN_RAM_GB, MIN_FREE_GB };
