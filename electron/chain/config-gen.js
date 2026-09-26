// Zebra configuration generator.
//
// Turns the embedded network manifest plus this machine's choices into the
// TOML that `zebrad start -c <file>` reads. It is a pure function of its
// inputs so it can be unit-tested without Electron, a node, or a disk.
//
// Two facts from the 2026-09-21 native-build spike shape this file:
//   * the TOML must be written as UTF-8 WITHOUT a byte-order mark — a BOM
//     makes Zebra's parser fail (see writeConfigFile below);
//   * every value that decides which chain we join lives in the manifest,
//     so pointing a build at another network is a one-file swap.
//
// No consensus or cryptographic logic lives here. The generator only copies
// manifest values into the shape Zebra expects and refuses to guess.
//
// TWO NETWORKS, TWO SHAPES (added 2026-09-25).
// SWARM testnet is configured through Zebra's `[network.testnet_parameters]`,
// where the whole definition is data. SWARM mainnet is not: it is the node's
// own `SwarmMainnet` variant, whose constants are compiled in, and the only
// things the configuration supplies are the genesis hash, the three funding
// destinations and two optional ports. The renderer therefore has two shapes,
// picked by the manifest's own identity through electron/chain/network-profile
// — which refuses outright to produce `network = "Mainnet"` for either of them.

'use strict';

const {
  profileForManifest, FORBIDDEN_ZEBRA_NETWORKS, SWARM_SLOTS, swarmSlot
} = require('./network-profile');

class ConfigError extends Error {}

const ACTIVATION_ORDER = [
  'BeforeOverwinter',
  'Overwinter',
  'Sapling',
  'Blossom',
  'Heartwood',
  'Canopy',
  'NU5',
  'NU6',
  'NU6.1',
  'NU6.2',
  'NU6.3'
];

// Zebra's own funding-stream receiver slot names. Anything else is refused
// rather than passed through, because Zebra panics on an unknown receiver.
const RECEIVER_SLOTS = new Set(['ECC', 'MajorGrants', 'ZcashFoundation', 'Deferred']);

function tomlString(value) {
  // Basic TOML string: escape backslash and quote, reject control characters.
  const s = String(value);
  if (/[\x00-\x1f]/.test(s)) throw new ConfigError(`control character in value ${JSON.stringify(s)}`);
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

// Zebra reads paths from TOML. Forward slashes work on Windows and avoid the
// escaping traps of backslashes inside TOML strings, so every path is
// normalised to forward slashes before it is written.
function tomlPath(p) {
  if (typeof p !== 'string' || !p.length) throw new ConfigError('path must be a non-empty string');
  return tomlString(p.replace(/\\/g, '/').replace(/\/+$/, ''));
}

function requirePort(value, what) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new ConfigError(`${what} must be a port 1..65535, got ${value}`);
  return n;
}

function requireHex(value, bytes, what) {
  if (typeof value !== 'string' || !new RegExp(`^[0-9a-fA-F]{${bytes * 2}}$`).test(value)) {
    throw new ConfigError(`${what} must be ${bytes * 2} hex characters`);
  }
  return value.toLowerCase();
}

function checkMagic(magic) {
  if (!Array.isArray(magic) || magic.length !== 4 || !magic.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)) {
    throw new ConfigError('identity.network_magic must be four bytes 0..255');
  }
  return magic;
}

// A peer is "host:port". Hosts are passed through to Zebra untouched; only
// the obviously-wrong shapes are rejected here.
function checkPeer(peer) {
  if (typeof peer !== 'string' || !/^[A-Za-z0-9._\-[\]:]+:\d{1,5}$/.test(peer)) {
    throw new ConfigError(`seed peer ${JSON.stringify(peer)} is not host:port`);
  }
  const port = Number(peer.slice(peer.lastIndexOf(':') + 1));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ConfigError(`seed peer ${peer} has a bad port`);
  return peer;
}

/** The canonical manifest calls it upstream_slot; older fixtures say receiver. */
function receiverSlot(r) { return r.receiver != null ? r.receiver : r.upstream_slot; }

function checkRecipients(recipients) {
  if (!Array.isArray(recipients)) throw new ConfigError('economics.recipients must be an array');
  let total = 0;
  for (const r of recipients) {
    if (!RECEIVER_SLOTS.has(receiverSlot(r))) {
      throw new ConfigError(`recipient ${JSON.stringify(r.label)} has unknown receiver slot ${JSON.stringify(receiverSlot(r))}`);
    }
    if (!Number.isInteger(r.numerator) || r.numerator < 0 || r.numerator > 100) {
      throw new ConfigError(`recipient ${r.label} numerator ${r.numerator} is not 0..100`);
    }
    // Zebra asserts "address must be P2SH" for funding-stream recipients and
    // panics on anything else, so a t1.../tm... address is refused here where
    // the message is readable instead of in the node's crash log.
    if (typeof r.address !== 'string' || !/^t2[1-9A-HJ-NP-Za-km-z]{20,}$/.test(r.address)) {
      throw new ConfigError(
        `recipient ${r.label} needs a testnet P2SH address starting "t2"; got ${JSON.stringify(r.address)}`
      );
    }
    total += r.numerator;
  }
  if (total > 100) throw new ConfigError(`recipient numerators sum to ${total}, above 100`);
  return recipients;
}

/**
 * Options every profile shares, checked once so both renderers agree.
 */
function commonOptions(manifest, opts, profile) {
  const ports = manifest.ports || {};
  const dataDir = opts.dataDir;
  if (typeof dataDir !== 'string' || !dataDir.length) throw new ConfigError('opts.dataDir is required');

  const p2pPort = requirePort(
    ports.p2p == null ? (ports.public_p2p == null ? profile.ports.p2p : ports.public_p2p) : ports.p2p,
    'ports.p2p'
  );
  const rpcPort = requirePort(
    opts.rpcPort == null ? (ports.rpc == null ? profile.ports.rpc : ports.rpc) : opts.rpcPort,
    'rpc port'
  );
  const p2pListen = opts.p2pListen == null ? `0.0.0.0:${p2pPort}` : String(opts.p2pListen);
  if (!/^[0-9.]+:\d{1,5}$/.test(p2pListen) && !/^\[[0-9a-fA-F:]+\]:\d{1,5}$/.test(p2pListen)) {
    throw new ConfigError(`p2pListen ${JSON.stringify(p2pListen)} is not address:port`);
  }
  const cpuThreads = Number.isInteger(opts.cpuThreads) && opts.cpuThreads > 0 ? opts.cpuThreads : 2;
  const internalMiner = opts.internalMiner === true;
  const minerAddress = opts.minerAddress == null ? null : String(opts.minerAddress);
  if (internalMiner && !minerAddress) throw new ConfigError('internalMiner needs a minerAddress');
  if (minerAddress && !/^[0-9A-Za-z]{30,600}$/.test(minerAddress)) {
    throw new ConfigError('minerAddress has an implausible shape; it is validated by the node, not parsed here');
  }
  return { dataDir, p2pPort, rpcPort, p2pListen, cpuThreads, internalMiner, minerAddress };
}

/**
 * The SWARM mainnet (`SwarmMainnet`) configuration.
 *
 * Deliberately short. On this network the definition is IN THE NODE — the
 * magic, the difficulty limit, the halving schedule, the activation heights,
 * the funding-stream percentages and the accepted transaction versions are all
 * compiled-in constants, so none of them appear here and none of them can be
 * changed by editing this file. Exactly three things are supplied, because
 * they only exist after the launch ceremony: the genesis hash and the three
 * funding-stream destinations. The node validates the whole section while it
 * deserialises the configuration, before it binds a listener or opens a
 * database, so an incomplete definition fails to start rather than starting
 * half-defined on a production chain.
 */
function generateSwarmMainConfig(manifest, opts, profile) {
  const genesisHash = requireHex((manifest.genesis || {}).hash || '', 32, 'genesis.hash');
  const { dataDir, p2pPort, rpcPort, p2pListen, cpuThreads, internalMiner, minerAddress } = commonOptions(manifest, opts, profile);

  // The three destinations, by SWARM slot. The mapping from a manifest's
  // recorded receiver to the slot is fixed in network-profile.js, so a
  // manifest cannot move an allocation from one slot to another.
  const byslot = new Map();
  for (const r of (manifest.economics || {}).recipients || []) {
    const slot = swarmSlot(r);
    if (!slot) throw new ConfigError(`funding-stream recipient ${JSON.stringify(r.label)} names no SWARM slot`);
    if (byslot.has(slot)) throw new ConfigError(`two funding-stream recipients claim the ${slot} slot`);
    if (typeof r.address !== 'string' || !/^s3[1-9A-HJ-NP-Za-km-z]{20,}$/.test(r.address)) {
      throw new ConfigError(
        `the ${slot} destination must be a SWARM mainnet pay-to-script-hash address starting "s3"; ` +
        `got ${JSON.stringify(String(r.address || ''))}`
      );
    }
    byslot.set(slot, r);
  }
  for (const slot of SWARM_SLOTS) {
    if (!byslot.has(slot)) throw new ConfigError(`the SWARM mainnet definition has no ${slot} destination`);
  }

  const seeds = (opts.seedPeers == null ? manifest.seed_peers || [] : opts.seedPeers).map(checkPeer);

  const L = [];
  L.push(`# ${profile.networkName} -- SWARM Node local profile.`);
  L.push('# Generated by SWARM Node from the network definition embedded in this build.');
  L.push('# Do not edit by hand: the app rewrites this file on every start.');
  L.push('# SwarmMainnet is SWARM\'s own production network. It is not upstream Zcash:');
  L.push('# different magic (SWMN), different genesis, different transaction domain.');
  L.push('');

  L.push('[network]');
  L.push(`network = ${tomlString(profile.zebraNetwork)}`);
  L.push(`listen_addr = ${tomlString(p2pListen)}`);
  // Neither upstream peer list means anything here, and a Zcash seeder must
  // never be dialled by a SWARM node.
  L.push('initial_mainnet_peers = []');
  L.push('initial_testnet_peers = []');
  if (seeds.length) L.push(`initial_swarm_main_peers = [${seeds.map(tomlString).join(', ')}]`);
  L.push('cache_dir = false');
  L.push('');

  L.push('# The only values this file supplies. Everything else about');
  L.push('# SwarmMainnet -- the network magic, the difficulty limit, the');
  L.push('# halving schedule, the activation heights, the 8/4/8 split and the');
  L.push('# V5/V6-only rule -- is compiled into the node and cannot be');
  L.push('# configured, so this app cannot change what the network is.');
  L.push(`[${profile.configSection}]`);
  L.push(`genesis_hash = ${tomlString(genesisHash)}`);
  // The same two numbers `listen_addr` and the RPC listener were built from,
  // resolved once in commonOptions: the manifest names the P2P port
  // `public_p2p`, and reading it a second way here let the section disagree
  // with the listener above.
  L.push(`p2p_port = ${p2pPort}`);
  L.push(`rpc_port = ${requirePort((manifest.ports || {}).rpc == null ? profile.ports.rpc : manifest.ports.rpc, 'ports.rpc')}`);
  L.push('');

  L.push(`[${profile.configSection}.funding_stream_addresses]`);
  for (const slot of SWARM_SLOTS) {
    const r = byslot.get(slot);
    L.push(`${slot} = ${tomlString(r.address)}  # ${r.label}`);
  }
  L.push('');

  L.push('[state]');
  L.push(`cache_dir = ${tomlPath(dataDir + '/state')}`);
  L.push('');

  L.push('[rpc]');
  L.push(`listen_addr = ${tomlString('127.0.0.1:' + rpcPort)}`);
  L.push(`cookie_dir = ${tomlPath(dataDir)}`);
  L.push('enable_cookie_auth = true');
  L.push(`parallel_cpu_threads = ${cpuThreads}`);
  L.push('');

  L.push('[sync]');
  L.push(`parallel_cpu_threads = ${cpuThreads}`);
  L.push('');

  // No debug_enable_at_height here. That switch exists to stop a private
  // testnet waiting for a public chain tip; on a production network the
  // node's own rule for enabling the mempool is the right one.

  L.push('[health]');
  L.push('# SwarmMainnet is not a test network, so Zebra applies this gate');
  L.push('# without the opt-in a configured testnet needs.');
  const gate = manifest.sync_gate || {};
  L.push(`min_connected_peers = ${Number.isInteger(gate.min_peers) ? gate.min_peers : 1}`);
  L.push(`ready_max_tip_age = "${Number.isInteger(gate.max_tip_age_seconds) ? gate.max_tip_age_seconds : 900}s"`);
  L.push('');

  if (opts.metricsPort != null) {
    L.push('[metrics]');
    L.push(`endpoint_addr = ${tomlString('127.0.0.1:' + requirePort(opts.metricsPort, 'metrics port'))}`);
    L.push('');
  }

  L.push('[mining]');
  if (minerAddress) {
    L.push(`miner_address = ${tomlString(minerAddress)}`);
  } else {
    L.push('# miner_address is written only after the node has validated a payout address.');
  }
  L.push(`internal_miner = ${internalMiner}`);
  L.push('');

  L.push('[tracing]');
  L.push('use_color = false');
  L.push('');

  const text = L.join('\n');
  // Belt and braces: whatever happens above, this app never hands a node a
  // configuration that selects upstream Zcash.
  assertNotUpstream(text);
  return text;
}

/** Refuse to emit a configuration that selects an upstream Zcash network. */
function assertNotUpstream(text) {
  const m = /^\s*network\s*=\s*"([^"]*)"/m.exec(text);
  if (m && FORBIDDEN_ZEBRA_NETWORKS.includes(m[1])) {
    throw new ConfigError(`refusing to write a configuration that selects ${m[1]}; SWARM Node never runs upstream Zcash`);
  }
  return text;
}

/**
 * Build the zebrad TOML.
 *
 * @param {object} manifest  the embedded network manifest (electron/net/network.json)
 * @param {object} opts
 *   dataDir           {string} per-user directory that holds state/ and the RPC cookie
 *   p2pListen         {string} "host:port" to listen on, defaults to 0.0.0.0:<manifest p2p port>
 *   rpcPort           {number} loopback RPC port, defaults to the manifest rpc port
 *   minerAddress      {string|null} payout address, or null for "do not mine"
 *   internalMiner     {boolean} run Zebra's own one-thread shielded miner
 *   seedPeers         {string[]} override for the manifest seed list (first-node mode passes [])
 *   enforceHealthGate {boolean} ask Zebra itself to refuse "synced" without peers / fresh tip
 *   metricsPort       {number|null} optional Prometheus endpoint, loopback only
 *   cpuThreads        {number} threads Zebra may use for verification
 */
function generateZebraConfig(manifest, opts = {}) {
  if (!manifest || typeof manifest !== 'object') throw new ConfigError('manifest missing');
  const id = manifest.identity || {};
  const cons = manifest.consensus || {};
  const econ = manifest.economics || {};
  const ports = manifest.ports || {};

  if (typeof id.network_name !== 'string' || !/^[A-Za-z][A-Za-z0-9]{2,29}$/.test(id.network_name)) {
    throw new ConfigError('identity.network_name must be 3..30 alphanumeric characters starting with a letter');
  }
  // Upstream Zcash, under any of the spellings its node accepts, is refused
  // before anything else looks at this manifest.
  if (FORBIDDEN_ZEBRA_NETWORKS.includes(String(id.network_kind)) ||
      FORBIDDEN_ZEBRA_NETWORKS.includes(String(id.network_name))) {
    throw new ConfigError(
      `identity.network_kind ${JSON.stringify(String(id.network_kind))} names upstream Zcash; ` +
      `this app does not run a mainnet belonging to another chain (got ${id.network_kind})`
    );
  }
  // Which of the two SWARM networks this definition is. Throws for anything
  // that is neither.
  let profile;
  try {
    profile = profileForManifest(manifest);
  } catch (e) {
    throw new ConfigError(e.message);
  }
  if (profile.id !== 'swarm-testnet') return generateSwarmMainConfig(manifest, opts, profile);
  if (id.network_kind !== 'Testnet') {
    throw new ConfigError(`identity.network_kind must be "Testnet"; this app does not run a mainnet (got ${id.network_kind})`);
  }
  checkMagic(id.network_magic);

  const genesisHash = manifest.genesis && manifest.genesis.hash;
  if (!genesisHash) {
    throw new ConfigError(
      'genesis.hash is empty in the embedded network manifest. The app will not start a node ' +
      'without it, because a node with the wrong genesis silently joins the wrong chain.'
    );
  }
  requireHex(genesisHash, 32, 'genesis.hash');
  requireHex(cons.target_difficulty_limit, 32, 'consensus.target_difficulty_limit');

  if (cons.disable_pow === true) throw new ConfigError('consensus.disable_pow must be false; this app never runs a chain without proof of work');

  const dataDir = opts.dataDir;
  if (typeof dataDir !== 'string' || !dataDir.length) throw new ConfigError('opts.dataDir is required');

  const p2pPort = requirePort(ports.p2p == null ? ports.public_p2p : ports.p2p, 'ports.p2p');
  const rpcPort = requirePort(opts.rpcPort == null ? ports.rpc : opts.rpcPort, 'rpc port');
  const p2pListen = opts.p2pListen == null ? `0.0.0.0:${p2pPort}` : String(opts.p2pListen);
  if (!/^[0-9.]+:\d{1,5}$/.test(p2pListen) && !/^\[[0-9a-fA-F:]+\]:\d{1,5}$/.test(p2pListen)) {
    throw new ConfigError(`p2pListen ${JSON.stringify(p2pListen)} is not address:port`);
  }

  const seeds = (opts.seedPeers == null ? manifest.seed_peers || [] : opts.seedPeers).map(checkPeer);
  const recipients = checkRecipients(econ.recipients || []);
  const range = econ.funding_stream_height_range || {};
  if (!Number.isInteger(range.start) || !Number.isInteger(range.end) || range.start >= range.end) {
    throw new ConfigError('economics.funding_stream_height_range needs integers start < end');
  }

  const cpuThreads = Number.isInteger(opts.cpuThreads) && opts.cpuThreads > 0 ? opts.cpuThreads : 2;
  const internalMiner = opts.internalMiner === true;
  const minerAddress = opts.minerAddress == null ? null : String(opts.minerAddress);
  if (internalMiner && !minerAddress) throw new ConfigError('internalMiner needs a minerAddress');
  if (minerAddress && !/^[0-9A-Za-z]{30,600}$/.test(minerAddress)) {
    throw new ConfigError('minerAddress has an implausible shape; it is validated by the node, not parsed here');
  }

  const L = [];
  L.push(`# ${id.network_name} -- SWARM Node local profile.`);
  L.push('# Generated by SWARM Node from the network manifest embedded in this build.');
  L.push('# Do not edit by hand: the app rewrites this file on every start.');
  L.push(`# Reward allocation: ${econ.miner_percent}% miner, ` +
    recipients.map((r) => `${r.numerator}% ${r.label}`).join(', ') + '.');
  L.push('# Testnet engineering settings. Not a mainnet launch, not audited.');
  L.push('');

  L.push('[network]');
  L.push('network = "Testnet"');
  L.push(`listen_addr = ${tomlString(p2pListen)}`);
  L.push('initial_mainnet_peers = []');
  L.push(`initial_testnet_peers = [${seeds.map(tomlString).join(', ')}]`);
  // cache_dir = false keeps Zebra from writing a peer cache for a private
  // network whose addresses would be meaningless anywhere else.
  L.push('cache_dir = false');
  L.push('');

  // ------------------------------------------------------------------
  // From here to the end of the activation heights, this block is produced
  // byte for byte identically to scripts/swarm/render_config.py, the
  // project's canonical renderer. A unit test compares the two outputs, so a
  // drift between the desktop app and the seed server cannot go unnoticed:
  // a node that disagrees about any of these values is on a different chain.
  // ------------------------------------------------------------------
  L.push('[network.testnet_parameters]');
  L.push(`network_name = ${tomlString(id.network_name)}`);
  L.push(`network_magic = [${checkMagic(id.network_magic).join(', ')}]`);
  L.push(`genesis_hash = ${tomlString(genesisHash.toLowerCase())}`);
  L.push(`disable_pow = ${cons.disable_pow === true}`);
  L.push(`checkpoints = ${cons.checkpoints === true}`);
  L.push('# Keep the upstream Testnet bound: an easier limit can overflow the');
  L.push('# 17-target difficulty average.');
  L.push(`target_difficulty_limit = ${tomlString(String(cons.target_difficulty_limit))}`);
  L.push(`slow_start_interval = ${Number(econ.slow_start_interval) || 0}`);
  L.push(`pre_blossom_halving_interval = ${Number(econ.pre_blossom_halving_interval)}`);
  L.push(`extend_funding_stream_addresses_as_required = ${econ.extend_funding_stream_addresses_as_required === true}`);
  L.push(`lockbox_disbursements = ${JSON.stringify(econ.lockbox_disbursements || [])}`);
  L.push('');
  L.push('# Reward allocation, specs/ECONOMICS.md v0.4. One range covers the');
  L.push('# whole emission schedule; the miner keeps the remainder plus fees.');
  L.push('funding_streams = [');
  L.push(`  { height_range = { start = ${range.start}, end = ${range.end} }, recipients = [`);
  for (const r of recipients) {
    L.push(`    { receiver = ${tomlString(receiverSlot(r))}, numerator = ${r.numerator}, addresses = [${tomlString(r.address)}] },  # ${r.label}`);
  }
  L.push('  ] },');
  L.push(']');
  L.push('');

  L.push('[network.testnet_parameters.activation_heights]');
  const heights = cons.activation_heights || {};
  for (const name of ACTIVATION_ORDER) {
    const h = heights[name];
    if (!Number.isInteger(h) || h < 1) throw new ConfigError(`activation height ${name} must be an integer >= 1`);
    // Keys with a dot must be quoted in TOML.
    L.push(`${name.includes('.') ? tomlString(name) : name} = ${h}`);
  }
  L.push('');

  L.push('[state]');
  L.push(`cache_dir = ${tomlPath(dataDir + '/state')}`);
  L.push('');

  L.push('[rpc]');
  L.push(`listen_addr = ${tomlString('127.0.0.1:' + rpcPort)}`);
  L.push(`cookie_dir = ${tomlPath(dataDir)}`);
  // Cookie authentication stays on. The cookie is rewritten on every start,
  // so the app reads it fresh before every call and never logs it.
  L.push('enable_cookie_auth = true');
  L.push(`parallel_cpu_threads = ${cpuThreads}`);
  L.push('');

  L.push('[sync]');
  L.push(`parallel_cpu_threads = ${cpuThreads}`);
  L.push('');

  L.push('[mempool]');
  L.push('# A private network must not wait for the public Zcash chain tip.');
  L.push('# Proof-of-work validation stays enabled above.');
  L.push('debug_enable_at_height = 0');
  L.push('');

  L.push('[health]');
  L.push('# Zebra treats every testnet node as synced unless this is switched on.');
  L.push("# SWARM Node's own sync gate is authoritative; this is defence in depth.");
  const gate = manifest.sync_gate || {};
  const minPeers = Number.isInteger(gate.min_peers) ? gate.min_peers : 1;
  const maxAge = Number.isInteger(gate.max_tip_age_seconds) ? gate.max_tip_age_seconds : 900;
  L.push(`min_connected_peers = ${minPeers}`);
  L.push(`ready_max_tip_age = "${maxAge}s"`);
  L.push(`enforce_on_test_networks = ${opts.enforceHealthGate === true}`);
  L.push('');

  if (opts.metricsPort != null) {
    L.push('[metrics]');
    L.push(`endpoint_addr = ${tomlString('127.0.0.1:' + requirePort(opts.metricsPort, 'metrics port'))}`);
    L.push('');
  }

  L.push('[mining]');
  if (minerAddress) {
    L.push(`miner_address = ${tomlString(minerAddress)}`);
  } else {
    L.push('# miner_address is written only after the node has validated a payout address.');
  }
  L.push(`internal_miner = ${internalMiner}`);
  L.push('');

  L.push('[tracing]');
  L.push('use_color = false');
  L.push('');

  return assertNotUpstream(L.join('\n'));
}

/**
 * Write the generated config as UTF-8 WITHOUT a byte-order mark.
 * PowerShell's `>` writes a BOM and Zebra's TOML parser then fails, so this
 * helper exists to make the correct encoding the only easy path.
 */
function writeConfigFile(fs, filePath, text) {
  if (/^﻿/.test(text)) throw new ConfigError('refusing to write a config that starts with a BOM');
  fs.writeFileSync(filePath, Buffer.from(text, 'utf8'));
  return filePath;
}

module.exports = {
  generateZebraConfig, generateSwarmMainConfig, assertNotUpstream,
  writeConfigFile, ConfigError, RECEIVER_SLOTS, ACTIVATION_ORDER
};
