// A first look at a pasted address, offline.
//
// WHY THIS EXISTS — defect N-3, 2026-09-22.
// The payout step used to do nothing until the node answered, so the owner saw
// a spinner ("checking with your node…") and a red error ("the node is not
// answering yet") at the same time, with Continue greyed out and no way
// forward. Two contradictory states and a dead end.
//
// The step now answers instantly from the shape of the string, and the node's
// verdict arrives afterwards as a confirmation. This does NOT make the app an
// address parser: it recognises the human-readable prefix and the alphabet,
// which is what tells a person "you pasted a receive address, not a block
// hash". Whether the address is VALID — checksum, network, encoding — is still
// decided only by the node, and mining never starts on a format guess.
//
// TWO NETWORKS, 2026-09-25. The prefixes are no longer constants in this file:
// they come from the selected network profile, because the same string is a
// good address on one SWARM network and a wrong-network address on the other.
// SWARM's prefixes are disjoint in both directions —
//
//   SWARM testnet   tm… (P2PKH)  t2… (P2SH)   swarm1… / utest1… (unified)
//   SWARM mainnet   s1… (P2PKH)  s3… (P2SH)   swm1…             (unified)
//   upstream Zcash  t1… t3… u1…                                 (never ours)
//
// — so the OTHER SWARM network's address is named as such rather than called
// malformed, which is the mistake a person actually makes. ZIP-320 TEX
// addresses have no reviewed prefix on SWARM, so there is none to accept here.

'use strict';

const { requireProfile, DEFAULT_PROFILE_ID, classifyPrefix, profileById } = require('./network-profile');

// Base58: no zero, capital O, capital I or lower-case l.
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]+$/;
// Bech32: lower case, and 1, b, i and o are not data characters.
const BECH32_DATA = /^[023456789acdefghjklmnpqrstuvwxyz]+$/;
const MIN_UNIFIED_LENGTH = 60;

const KINDS = {
  transparent: {
    kind: 'transparent',
    mode: 'standard',
    label: 'Transparent address',
    detail: 'Rewards paid to it are visible on the explorer. It works with standard mining, which uses as many processor cores as you choose.'
  },
  unified: {
    kind: 'unified',
    mode: 'shielded',
    label: 'Unified address',
    detail: 'Rewards paid to it are private. It works with shielded mining, which runs inside the node and uses as many processor cores as you choose.'
  }
};

/** "tm…, swarm1… or utest1…" — how to name this network's addresses. */
function prefixList(p) {
  const all = [p.transparent.p2pkh, ...p.unifiedPrefixes].map((x) => `${x}…`);
  return all.length > 1 ? `${all.slice(0, -1).join(', ')} or ${all[all.length - 1]}` : all[0];
}

/**
 * @param {string} raw
 * @param {string} [profileId]  which SWARM network the app is running
 * @returns {{
 *   looksValid: boolean, kind: 'transparent'|'unified'|null,
 *   mode: 'standard'|'shielded'|null, label: string|null,
 *   detail: string|null, hint: string|null
 * }}
 */
function inspect(raw, profileId = DEFAULT_PROFILE_ID) {
  const p = profileById(profileId) || requireProfile(DEFAULT_PROFILE_ID);
  const s = String(raw == null ? '' : raw).trim();
  const no = (hint) => ({ looksValid: false, kind: null, mode: null, label: null, detail: null, hint });

  if (!s) return no(null);
  if (/\s/.test(s)) return no('That has a space in it. Copy the whole address with nothing around it.');

  const seen = classifyPrefix(p, s);

  // 1. A transparent address for THIS network.
  if (seen.kind === 'transparent') {
    if (!BASE58.test(s)) return no('A transparent address never contains 0, O, I or l. Check the copy.');
    if (s.length !== p.transparent.length) {
      return no(`A transparent address is ${p.transparent.length} characters; this one is ${s.length}.`);
    }
    return { looksValid: true, ...KINDS.transparent, hint: null };
  }

  // 2. A unified address for THIS network.
  if (seen.kind === 'unified') {
    if (s !== s.toLowerCase()) return no('A unified address is all lower case. Check the copy.');
    const prefix = p.unifiedPrefixes.find((u) => s.slice(0, u.length).toLowerCase() === u);
    const data = s.slice(prefix.length);
    if (!data) return no('That unified address is cut short.');
    if (!BECH32_DATA.test(data)) return no('A unified address never contains 1, b, i or o after the prefix. Check the copy.');
    if (s.length < MIN_UNIFIED_LENGTH) return no(`That unified address looks cut short (${s.length} characters).`);
    return { looksValid: true, ...KINDS.unified, hint: null };
  }

  // 3. The OTHER SWARM network. Named, because it is the real mistake: the
  //    person has a good address, from a wallet set to the wrong network.
  if (seen.wrongNetwork && seen.wrongNetwork !== 'upstream') {
    const other = profileById(seen.wrongNetwork);
    return no(
      `That is a ${other.label} address. This app is running the ${p.label}, ` +
      `so its addresses start ${prefixList(p)}.`
    );
  }

  // 4. Upstream Zcash. u1… is the one people paste most, so it says so.
  if (/^u1/i.test(s)) {
    return p.production
      ? no(`That is an upstream Zcash unified address, not a SWARM one. A ${p.label} address starts ${prefixList(p)}.`)
      : no('That is a mainnet unified address. SWARM is a testnet, so its addresses start swarm1… or utest1….');
  }
  if (seen.wrongNetwork === 'upstream' || /^t[0-9a-zA-Z]/.test(s)) {
    return no(`That looks like an address for a different network. A ${p.label} address starts ${prefixList(p)}.`);
  }
  if (/^z/i.test(s)) {
    return no(`That is a shielded Sapling address. Neither mining mode can pay to one; use a ${prefixList(p)} address.`);
  }

  return no('That does not look like a SWARM address. Copy a receive address from the SWARM Wallet.');
}

module.exports = { inspect, KINDS, prefixList, MIN_UNIFIED_LENGTH };
