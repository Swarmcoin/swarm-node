// Which network this app is being asked to run — as an explicit, closed list.
//
// WHY THIS FILE EXISTS.
// Until now the app ran exactly one network and said so by refusing anything
// whose manifest was not `network_kind = "Testnet"`. SWARM now has a second
// network, its own production chain, and the word for it in the node is
// `SwarmMainnet` — a variant of the node's own Network type that is NOT
// upstream Zcash Mainnet. The danger that comes with the second network is a
// single word: if "mainnet" anywhere in this app were allowed to resolve to
// the node's `Mainnet`, a user pressing "SWARM mainnet" would join the Zcash
// main chain, mine on it with a SWARM payout address the chain cannot pay, and
// be told nothing.
//
// So the mapping lives here, once, as data, and the module refuses to load if
// any profile maps to upstream Zcash:
//
//   swarm-testnet  ->  network = "Testnet"       + [network.testnet_parameters]
//   swarm-mainnet  ->  network = "SwarmMainnet"  + [network.swarm_main]
//
// There is no third entry and there is no path that produces
// `network = "Mainnet"`. See FORBIDDEN_ZEBRA_NETWORKS below and the test
// "no profile can ever select upstream Zcash".
//
// WHAT A PROFILE IS NOT. It is not a network definition. The genesis hash,
// the funding-stream destinations and the seed peers of a network live in that
// network's manifest, which is produced at the launch ceremony and bundled
// with a release. A profile says how to READ such a manifest and what the node
// must be told; it never invents a value that decides which chain is joined.

'use strict';

const fs = require('fs');
const path = require('path');

class ProfileError extends Error {}

/**
 * Values this app must never write as `network = ...`. Two of them are the
 * upstream Zcash main chain under the spellings Zebra accepts; "Regtest" is
 * here because a regtest node mints blocks without proof of work and this app
 * promises it never runs a chain without it.
 */
const FORBIDDEN_ZEBRA_NETWORKS = Object.freeze(['Mainnet', 'mainnet', 'main', 'Regtest', 'regtest']);

// Genesis hashes that are definitely NOT a SWARM production genesis. A build
// whose mainnet manifest carries one of these was mis-assembled, and a node
// started from it would follow somebody else's chain.
const FOREIGN_GENESIS = Object.freeze({
  '00040fe8ec8471911baa1db1266ea15dd06b4a8a5c453883c000b031973dce08': 'the upstream Zcash main chain',
  '05a60a92d99d85997cce3b87616c089f6124d7342af37106edc76126334a2c38': 'the upstream Zcash test chain',
  '045993f5c91ea160c7ebda573dd97b0016816bca68d395bfff202779b88e2a28': 'the SWARM testnet'
});

/**
 * The two SWARM networks.
 *
 * transparent / unified hold the human-readable prefixes a payout address may
 * start with on that network. They are used for the instant offline shape
 * check and for refusing an address that plainly belongs to the other network;
 * whether an address is VALID is still decided only by the node.
 */
const PROFILES = [
  {
    id: 'swarm-testnet',
    label: 'SWARM testnet',
    // What goes in `network = ...`. Zebra reads the definition itself from
    // [network.testnet_parameters].
    zebraNetwork: 'Testnet',
    configSection: 'network.testnet_parameters',
    networkName: 'SwarmTestnet',
    manifestKind: 'Testnet',
    chainLabel: 'swarm-testnet',
    // What the node's own getblockchaininfo.chain may say. Zebra reports the
    // BIP-70 name of the network family, so every configured testnet — SWARM's
    // included — reports "test".
    nodeChainValues: ['test', 'swarm-testnet', 'SwarmTestnet'],
    ports: { p2p: 18233, rpc: 18232 },
    // Separate folders, because two chains cannot share a state database and a
    // mainnet node opened on testnet data is a wrong-chain node.
    dataDirName: 'chain',
    dataDirSetting: 'dataDir',
    magic: [83, 87, 82, 77],          // "SWRM"
    production: false,
    transparent: { p2pkh: 'tm', p2sh: 't2', length: 35 },
    unifiedPrefixes: ['swarm1', 'utest1'],
    // Funding-stream destinations Zebra will accept on this network. Zebra
    // asserts "address must be P2SH" and panics on anything else.
    fundingAddressPrefix: 't2',
    coinsHaveValue: false,
    // The project's light-wallet host FOR THIS NETWORK. Two things read it:
    // the independent tip oracle the mining gate consults, and the seed's
    // published status file. Both were hard-coded to the testnet host, so a
    // mainnet build asked the TESTNET server how tall the SWARM main chain
    // was, got nothing it could use, and could not tell a synced node from a
    // node still catching up.
    lightWalletHost: 'lwd.swarm.green'
  },
  {
    id: 'swarm-mainnet',
    label: 'SWARM mainnet',
    // The node's OWN production variant. Not "Mainnet": that is Zcash.
    zebraNetwork: 'SwarmMainnet',
    configSection: 'network.swarm_main',
    networkName: 'SwarmMainnet',
    manifestKind: 'SwarmProduction',
    chainLabel: 'swarm-mainnet',
    // Exactly one accepted answer, and it doubles as the version check on the
    // node: a zebrad without SwarmMain support cannot produce this string.
    nodeChainValues: ['swarm-mainnet'],
    ports: { p2p: 28233, rpc: 28232 },
    dataDirName: 'chain-mainnet',
    dataDirSetting: 'dataDirMainnet',
    // "SWMN". Part of the network definition compiled into the node, never
    // written to the configuration file: an operator cannot change it, so a
    // wrong magic cannot come from this app.
    magic: [83, 87, 77, 78],
    magicConfigurable: false,
    production: true,
    transparent: { p2pkh: 's1', p2sh: 's3', length: 35 },
    // ZIP-320 TEX addresses are refused on SwarmMain: there is no reviewed
    // prefix assignment, so no such address is ever constructed or accepted.
    unifiedPrefixes: ['swm1'],
    fundingAddressPrefix: 's3',
    coinsHaveValue: true,
    lightWalletHost: 'lwd-main.swarm.green'
  }
];

for (const p of PROFILES) {
  if (FORBIDDEN_ZEBRA_NETWORKS.includes(p.zebraNetwork)) {
    throw new ProfileError(`profile ${p.id} maps to ${p.zebraNetwork}, which is not a SWARM network`);
  }
  Object.freeze(p.ports);
  Object.freeze(p.transparent);
  Object.freeze(p.unifiedPrefixes);
  Object.freeze(p.nodeChainValues);
  Object.freeze(p);
}
Object.freeze(PROFILES);

const DEFAULT_PROFILE_ID = 'swarm-testnet';

/** The profile with this id, or null. Never guesses. */
function profileById(id) {
  return PROFILES.find((p) => p.id === String(id || '')) || null;
}

/** The profile with this id, or an error naming what is on offer. */
function requireProfile(id) {
  const p = profileById(id);
  if (!p) {
    throw new ProfileError(
      `unknown network profile ${JSON.stringify(String(id))}; this app runs ${PROFILES.map((x) => x.id).join(' or ')}`
    );
  }
  return p;
}

/**
 * Which profile a network manifest belongs to.
 *
 * The manifest names its own network; this decides nothing on its behalf. A
 * manifest that names upstream Zcash — by kind or by network name — is refused
 * here rather than rendered into a configuration.
 */
function profileForManifest(manifest) {
  const id = (manifest && manifest.identity) || {};
  const kind = String(id.network_kind || '');
  const name = String(id.network_name || '');
  if (FORBIDDEN_ZEBRA_NETWORKS.includes(kind) || FORBIDDEN_ZEBRA_NETWORKS.includes(name)) {
    throw new ProfileError(
      `this manifest names ${JSON.stringify(kind || name)}, which is upstream Zcash; SWARM Node never runs it`
    );
  }
  const found = PROFILES.find((p) => p.manifestKind === kind && p.networkName === name);
  if (!found) {
    throw new ProfileError(
      `no SWARM network profile matches identity.network_kind=${JSON.stringify(kind)} ` +
      `identity.network_name=${JSON.stringify(name)}`
    );
  }
  return found;
}

/**
 * The same question, but tolerant of a build carrying a throwaway or rehearsal
 * testnet definition whose network_name is its own. Upstream Zcash is still
 * refused: only a network that calls itself a Testnet falls back.
 */
function profileForManifestOrKind(manifest) {
  try {
    return profileForManifest(manifest);
  } catch (e) {
    const kind = String(((manifest || {}).identity || {}).network_kind || '');
    if (FORBIDDEN_ZEBRA_NETWORKS.includes(kind)) throw e;
    if (kind === 'Testnet') return profileById(DEFAULT_PROFILE_ID);
    throw e;
  }
}

// --------------------------------------------------------------- addresses

/**
 * What a pasted string looks like on a given network, offline.
 *
 * Returns one of:
 *   {kind:'transparent'|'unified', mode:'standard'|'shielded'}   plausible here
 *   {kind:null, wrongNetwork:'swarm-testnet'|'swarm-mainnet'|'upstream'}  belongs elsewhere
 *   {kind:null}                                                   not an address
 *
 * It never says "valid": prefixes and alphabets are all it looks at.
 */
function classifyPrefix(profile, raw) {
  const s = String(raw == null ? '' : raw).trim();
  const p = requireProfile(profile.id || profile);
  const mine = profileById(p.id);

  const startsWith = (prefix) => s.slice(0, prefix.length).toLowerCase() === prefix.toLowerCase();

  if (startsWith(mine.transparent.p2pkh) || startsWith(mine.transparent.p2sh)) {
    return { kind: 'transparent', mode: 'standard', wrongNetwork: null };
  }
  for (const u of mine.unifiedPrefixes) {
    if (startsWith(u)) return { kind: 'unified', mode: 'shielded', wrongNetwork: null };
  }
  // Does it belong to the OTHER SWARM network? That is the mistake worth
  // naming, because both look like "a SWARM address" to the person holding it.
  for (const other of PROFILES) {
    if (other.id === mine.id) continue;
    if (startsWith(other.transparent.p2pkh) || startsWith(other.transparent.p2sh)) {
      return { kind: null, mode: null, wrongNetwork: other.id };
    }
    for (const u of other.unifiedPrefixes) {
      if (startsWith(u)) return { kind: null, mode: null, wrongNetwork: other.id };
    }
  }
  // Upstream Zcash: t1/t3 transparent, u1 unified, zs/zc shielded.
  if (/^(t1|t3|u1)/i.test(s)) return { kind: null, mode: null, wrongNetwork: 'upstream' };
  return { kind: null, mode: null, wrongNetwork: null };
}

/**
 * The https addresses this network's own seed server answers on.
 *
 * They must follow the network. A mainnet node measured against the testnet's
 * lightwalletd is not measured at all: the app shows no network height, and
 * the mining gate never sees the tip it is supposed to compare against.
 */
function lightWalletUrls(profile) {
  const p = requireProfile(profile.id || profile);
  return {
    host: p.lightWalletHost,
    tipOracleUrl: `https://${p.lightWalletHost}:443`,
    statusUrl: `https://${p.lightWalletHost}/status.json`,
    // The live census the Swarm map draws: the seed's current peers, grouped
    // by city. It follows the network for the same reason the status file
    // does. As a constant naming the testnet host, a MAINNET build drew the
    // TESTNET seed's census - one dot, "1 node online, Dallas" - while the
    // owner's mainnet node sat connected to the mainnet seed, counted in the
    // mainnet file and never read.
    liveMapUrl: `https://${p.lightWalletHost}/swarm-map-live.json`
  };
}

/** How to describe this network's payout addresses in one phrase. */
function addressHint(profile) {
  const p = requireProfile(profile.id || profile);
  return `${p.transparent.p2pkh}… or ${p.unifiedPrefixes[0]}…`;
}

// ------------------------------------------------------------- chain check

/**
 * Is the node the app is talking to on the network the app selected?
 *
 * `reported` is getblockchaininfo.chain. Three answers, deliberately:
 *   ok:true              the node named this network;
 *   ok:false             the node named a different one — never mine;
 *   ok:null (unknown)    the node said nothing we can read. Unknown is not a
 *                        failure: an old field name or a missing field must not
 *                        stop a testnet that works today. It IS a failure on a
 *                        production profile, where the string is the only proof
 *                        the node even understands SwarmMain.
 */
function checkNodeChain(profile, reported, opts = {}) {
  const p = requireProfile(profile.id || profile);
  // A build may carry a manifest with its own chain label (a throwaway or
  // rehearsal network on the testnet profile). That label is accepted too;
  // the profile's own list is never narrowed by it.
  const accept = p.nodeChainValues.concat(
    [opts.expected, ...(opts.accept || [])].filter((x) => typeof x === 'string' && x.length)
  );
  const expected = opts.expected || p.chainLabel;
  const got = reported == null ? null : String(reported).trim();
  if (!got) {
    if (p.production) {
      return {
        ok: false,
        expected,
        got: null,
        error: `This node does not say which chain it is on. ${p.label} needs a node that reports ` +
               `"${expected}"; an older SWARM node cannot, so it must not be used for ${p.label}.`
      };
    }
    return { ok: null, expected, got: null, error: null };
  }
  if (accept.some((v) => v.toLowerCase() === got.toLowerCase())) {
    return { ok: true, expected, got, error: null };
  }
  const other = PROFILES.find((x) => x.id !== p.id && x.nodeChainValues.some((v) => v.toLowerCase() === got.toLowerCase()));
  const where = /^main$/i.test(got) ? 'the upstream Zcash main chain' : (other ? other.label : `"${got}"`);
  return {
    ok: false,
    expected,
    got,
    error: `This node is on ${where}, not ${p.label}. Mining was not started: a block found on ` +
           'the wrong chain pays nothing and the payout address does not exist there.'
  };
}

/** Same question for the genesis block the node holds. */
function checkNodeGenesis(expectedHash, reported) {
  const want = String(expectedHash || '').toLowerCase();
  const got = reported == null ? null : String(reported).toLowerCase();
  if (!want) return { ok: null, expected: null, got, error: null };
  if (!got) return { ok: null, expected: want, got: null, error: null };
  if (got === want) return { ok: true, expected: want, got, error: null };
  const foreign = FOREIGN_GENESIS[got];
  return {
    ok: false,
    expected: want,
    got,
    error: `This node's block 0 is ${got.slice(0, 16)}…${foreign ? `, which is ${foreign}` : ''}, ` +
           `not the ${want.slice(0, 16)}… this build expects. That data folder belongs to another network.`
  };
}

// ---------------------------------------------------------------- manifests

/**
 * Load the network manifest a profile needs.
 *
 * The testnet manifest ships in every build. The mainnet one does NOT: its
 * two required values — the genesis hash and the three funding-stream
 * destinations — only exist after the launch ceremony, and there is
 * deliberately no placeholder, because a placeholder genesis is how a node
 * silently joins the wrong chain. Until the file is bundled, the profile is
 * visible and unselectable, with a reason a person can read.
 *
 * @returns {{id, label, available, manifest, file, reason}}
 */
function loadProfileManifest(profile, netDir) {
  const p = requireProfile(profile.id || profile);
  const file = path.join(netDir, p.id === DEFAULT_PROFILE_ID ? 'network.json' : `network-${p.id.replace(/^swarm-/, '')}.json`);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return {
      id: p.id,
      label: p.label,
      available: false,
      manifest: null,
      file,
      reason: p.production
        ? 'SWARM mainnet has not launched. This build carries no mainnet network definition, ' +
          'and SWARM Node will not invent one: a node started with a guessed genesis block ' +
          'joins whichever chain happens to accept it.'
        : `no network definition at ${file}`
    };
  }
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch (e) {
    return { id: p.id, label: p.label, available: false, manifest: null, file, reason: `${file} is not valid JSON: ${e.message}` };
  }
  try {
    validateProfileManifest(p, manifest);
  } catch (e) {
    return { id: p.id, label: p.label, available: false, manifest: null, file, reason: e.message };
  }
  manifest._profile = p.id;
  return { id: p.id, label: p.label, available: true, manifest, file, reason: null };
}

const SWARM_SLOTS = Object.freeze(['core_development', 'grants_ecosystem', 'community_reserve']);
// The mapping from the upstream receiver slot a manifest records to the SWARM
// configuration key. Fixed here so a manifest cannot move an allocation.
const SLOT_FROM_UPSTREAM = Object.freeze({
  ECC: 'core_development',
  MajorGrants: 'grants_ecosystem',
  ZcashFoundation: 'community_reserve'
});

function swarmSlot(recipient) {
  if (recipient && SWARM_SLOTS.includes(recipient.swarm_slot)) return recipient.swarm_slot;
  const upstream = recipient && (recipient.receiver != null ? recipient.receiver : recipient.upstream_slot);
  return SLOT_FROM_UPSTREAM[upstream] || null;
}

/**
 * Everything a profile's manifest must contain before this app will start a
 * node from it. Refusing here, at load, is the point: an incomplete production
 * definition must not reach a running node.
 */
function validateProfileManifest(profile, manifest) {
  const p = requireProfile(profile.id || profile);
  const id = (manifest && manifest.identity) || {};
  if (id.network_kind !== p.manifestKind || id.network_name !== p.networkName) {
    throw new ProfileError(
      `this definition is for ${JSON.stringify(id.network_name || id.network_kind || 'an unnamed network')}, not ${p.label}`
    );
  }
  if (id.light_wallet_chain_label && id.light_wallet_chain_label !== p.chainLabel) {
    throw new ProfileError(`chain label ${JSON.stringify(id.light_wallet_chain_label)} is not ${p.chainLabel}`);
  }
  const genesis = String(((manifest && manifest.genesis) || {}).hash || '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(genesis)) {
    throw new ProfileError(
      `${p.label} has no genesis hash in its definition. A node with the wrong genesis joins the wrong chain, ` +
      'so this build will not start one.'
    );
  }
  if (p.production && FOREIGN_GENESIS[genesis]) {
    throw new ProfileError(`the ${p.label} definition carries the genesis of ${FOREIGN_GENESIS[genesis]}`);
  }
  if (p.production) {
    const recipients = ((manifest.economics || {}).recipients) || [];
    const seen = new Set();
    for (const r of recipients) {
      const slot = swarmSlot(r);
      if (!slot) throw new ProfileError(`funding-stream recipient ${JSON.stringify(r.label)} names no known slot`);
      if (seen.has(slot)) throw new ProfileError(`two funding-stream recipients claim the ${slot} slot`);
      seen.add(slot);
      if (typeof r.address !== 'string' || !new RegExp(`^${p.fundingAddressPrefix}[1-9A-HJ-NP-Za-km-z]{20,}$`).test(r.address)) {
        throw new ProfileError(
          `the ${slot} destination must be a ${p.label} pay-to-script-hash address starting ` +
          `"${p.fundingAddressPrefix}"; got ${JSON.stringify(String(r.address || ''))}`
        );
      }
    }
    for (const slot of SWARM_SLOTS) {
      if (!seen.has(slot)) throw new ProfileError(`${p.label} has no ${slot} funding-stream destination`);
    }
  }
  return manifest;
}

/**
 * Every profile this build knows, each with its definition if it has one.
 * The unavailable ones are still returned, so the app can SHOW that mainnet
 * exists and say why it cannot be chosen yet.
 */
function loadProfiles(netDir) {
  return PROFILES.map((p) => loadProfileManifest(p, netDir));
}

/**
 * Can the node program this build bundles actually run this network?
 *
 * A build ships ONE pair of binaries, and they are not interchangeable. The
 * testnet `zebrad` (privacy-zebra codex/swarm-prefix-node) has no
 * `Network::SwarmMain` in it at all: it rejects a `[network.swarm_main]`
 * section while deserialising its configuration and can never report chain
 * `swarm-mainnet`. Offering "SWARM Mainnet" in a testnet build would be a
 * button that stops the node.
 *
 * The answer comes from the provenance the build recorded for the binary it
 * actually packaged (electron/net/binaries.json, written by
 * scripts/make-binaries-manifest.mjs from the verified bytes), never from the
 * file name and never from the version string.
 *
 * @param {object} profile
 * @param {object} nodeEntry  baseline.zebrad from binaries.json, or null
 * @returns {{ok:boolean, reason:string|null}}
 */
function nodeBinarySupports(profile, nodeEntry) {
  const p = requireProfile(profile.id || profile);
  if (!p.production) return { ok: true, reason: null };
  if (nodeEntry && String(nodeEntry.network || '') === p.networkName) return { ok: true, reason: null };
  return {
    ok: false,
    reason:
      `This build bundles the SWARM testnet node program, which has no ${p.networkName} network in it: ` +
      'it refuses the configuration this profile writes and can never report chain ' +
      `${p.chainLabel}. Install the ${p.label} build of SWARM Node to run it.`
  };
}

// ------------------------------------------------------- which one to start

/**
 * Which network THIS BUILD is for, read from electron/net/build-profile.json.
 *
 * A build carries every definition it has and the user picks one in the app.
 * Which network it was MADE for used to be recorded only in
 * release-manifest.json, which sits beside the installer and never travels
 * inside it — so the packaged app could not tell a mainnet build from a
 * testnet one, and 0.2.0-mainnet.1 came up on the testnet.
 *
 * A missing or unreadable marker is not a failure: it means "the default
 * build", which is the testnet. It can never name a network this app does not
 * know, because the id is looked up in the closed list above.
 */
function loadBuildProfile(netDir) {
  const file = path.join(netDir, 'build-profile.json');
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const p = profileById(raw && raw.profile);
    if (p) return { id: p.id, source: file };
    return { id: DEFAULT_PROFILE_ID, source: null, error: `${file} names ${JSON.stringify(String((raw || {}).profile || ''))}, which is not a SWARM network profile` };
  } catch {
    return { id: DEFAULT_PROFILE_ID, source: null, error: null };
  }
}

/**
 * Which profile this launch runs, and why.
 *
 * THE RULE, and the defect it fixes. The app used to honour the stored
 * `networkProfile` unconditionally. Every install stores `swarm-testnet` —
 * it is the shipped default — so a mainnet build installed on a machine that
 * had ever run the testnet app (or a fresh one, for that matter) started on
 * the testnet, called itself "SwarmTestnet · engineering testnet", and offered
 * nothing to change it.
 *
 * A stored choice is now only honoured when the person made it IN A BUILD FOR
 * THIS NETWORK — `networkProfileChosenForBuild` records which build's selector
 * they used. That single key separates "this user deliberately chose the
 * testnet inside the mainnet app" (honoured, forever) from "this settings file
 * has carried swarm-testnet since an earlier install" (overridden, and the
 * override is logged).
 *
 * @param {Array} networks   loadProfiles() output
 * @param {object} settings  the stored settings
 * @param {string} buildProfileId  which network this build is for
 * @returns {{entry, chosen:string, reason:string|null, override:object|null, fellBack:string|null}}
 */
function chooseStartProfile(networks, settings, buildProfileId) {
  const build = profileById(buildProfileId) ? buildProfileId : DEFAULT_PROFILE_ID;
  const stored = (settings && settings.networkProfile) || null;
  const storedFor = (settings && settings.networkProfileChosenForBuild) || null;

  // A stored selection counts only if it was made inside a build for this
  // same network. Anything else is a leftover and the build decides.
  const userChose = profileById(stored) && storedFor === build;
  let wanted = userChose ? stored : build;
  let override = null;
  if (!userChose && profileById(stored) && stored !== build) {
    override = {
      stored,
      build,
      reason:
        `this is a ${build} build; the stored selection ${stored} was not made in a ${build} build ` +
        '(it is the shipped default, or it came from an earlier install), so the build decides'
    };
  }

  const entry = networks.find((n) => n.id === wanted);
  if (entry && entry.available) {
    return { entry, chosen: entry.id, reason: null, override, fellBack: null };
  }
  // The wanted network has no definition in this build. Fall back to whatever
  // this build DOES carry, preferring the build's own network, then the
  // default. Never guess a definition; never start a network twice.
  const fellBack = entry ? entry.reason : `this build has no profile ${wanted}`;
  const candidates = [build, DEFAULT_PROFILE_ID, ...PROFILES.map((p) => p.id)];
  for (const id of candidates) {
    if (id === wanted) continue;
    const alt = networks.find((n) => n.id === id);
    if (alt && alt.available) return { entry: alt, chosen: alt.id, reason: fellBack, override, fellBack };
  }
  return { entry: null, chosen: null, reason: fellBack, override, fellBack };
}

/**
 * Does this payout address still belong to the network being switched to?
 *
 * The owner's machine held a testnet unified address (`swarm1…`) from the
 * earlier install. On SWARM mainnet that address does not exist and cannot be
 * paid, so carrying it across silently is worse than having none: the node
 * would be asked to mine to an address the chain cannot credit. Answering here
 * means main.js clears it and the app asks for a new one.
 */
function payoutBelongsTo(profileId, address) {
  const p = requireProfile(profileId);
  const raw = String(address == null ? '' : address).trim();
  if (!raw) return { ok: true, empty: true, reason: null };
  const shape = classifyPrefix(p, raw);
  if (shape.kind) return { ok: true, empty: false, reason: null };
  const other = shape.wrongNetwork === 'upstream' ? 'upstream Zcash' : (profileById(shape.wrongNetwork) || {}).label;
  return {
    ok: false,
    empty: false,
    reason: other
      ? `that payout address belongs to ${other}, not ${p.label}`
      : `that payout address is not a ${p.label} address`
  };
}

/** The directory a profile keeps its chain in. Never shared between profiles. */
function dataDirFor(profile, settings, userDataDir) {
  const p = requireProfile(profile.id || profile);
  const chosen = settings && settings[p.dataDirSetting];
  if (typeof chosen === 'string' && chosen.length) return chosen;
  return path.join(userDataDir, p.dataDirName);
}

module.exports = {
  PROFILES,
  DEFAULT_PROFILE_ID,
  FORBIDDEN_ZEBRA_NETWORKS,
  FOREIGN_GENESIS,
  SWARM_SLOTS,
  SLOT_FROM_UPSTREAM,
  ProfileError,
  profileById,
  requireProfile,
  profileForManifest,
  profileForManifestOrKind,
  classifyPrefix,
  addressHint,
  lightWalletUrls,
  checkNodeChain,
  checkNodeGenesis,
  loadProfileManifest,
  validateProfileManifest,
  loadProfiles,
  nodeBinarySupports,
  loadBuildProfile,
  chooseStartProfile,
  payoutBelongsTo,
  dataDirFor,
  swarmSlot
};
