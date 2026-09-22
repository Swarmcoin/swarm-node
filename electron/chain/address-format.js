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
// What is checked here:
//   tm… / t2…  Base58Check transparent addresses, 35 characters, no 0OIl
//   utest1…    Bech32m unified addresses, lower case, no 1bio
// Anything else is "not a SWARM address", which is a shape statement, not a
// validity one, and the message says so.

'use strict';

// Base58: no zero, capital O, capital I or lower-case l.
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]+$/;
// Bech32: lower case, and 1, b, i and o are not data characters.
const BECH32_DATA = /^[023456789acdefghjklmnpqrstuvwxyz]+$/;

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
    detail: 'Rewards paid to it are private. It works with shielded mining, which runs on one core inside the node.'
  }
};

/**
 * @param {string} raw
 * @returns {{
 *   looksValid: boolean, kind: 'transparent'|'unified'|null,
 *   mode: 'standard'|'shielded'|null, label: string|null,
 *   detail: string|null, hint: string|null
 * }}
 */
function inspect(raw) {
  const s = String(raw == null ? '' : raw).trim();
  const no = (hint) => ({ looksValid: false, kind: null, mode: null, label: null, detail: null, hint });

  if (!s) return no(null);
  if (/\s/.test(s)) return no('That has a space in it. Copy the whole address with nothing around it.');

  // Transparent: tm… on testnet, t2… for a script address.
  if (/^t[m2]/.test(s)) {
    if (!BASE58.test(s)) return no('A transparent address never contains 0, O, I or l. Check the copy.');
    if (s.length !== 35) return no(`A transparent address is 35 characters; this one is ${s.length}.`);
    return { looksValid: true, ...KINDS.transparent, hint: null };
  }
  // Other transparent prefixes exist on other networks and are a common mistake.
  if (/^t[1-9a-zA-Z]/.test(s)) {
    return no('That looks like an address for a different network. A SWARM testnet address starts tm… or utest1….');
  }

  // Unified: utest1 on testnet.
  if (/^utest1/i.test(s)) {
    if (s !== s.toLowerCase()) return no('A unified address is all lower case. Check the copy.');
    const data = s.slice(6);
    if (!data) return no('That unified address is cut short.');
    if (!BECH32_DATA.test(data)) return no('A unified address never contains 1, b, i or o after the prefix. Check the copy.');
    if (s.length < 60) return no(`That unified address looks cut short (${s.length} characters).`);
    return { looksValid: true, ...KINDS.unified, hint: null };
  }
  if (/^u1/i.test(s)) {
    return no('That is a mainnet unified address. SWARM is a testnet, so its addresses start utest1….');
  }
  if (/^z/i.test(s)) {
    return no('That is a shielded Sapling address. Neither mining mode can pay to one; use a tm… or utest1… address.');
  }

  return no('That does not look like a SWARM address. Copy a receive address from the SWARM Wallet.');
}

module.exports = { inspect, KINDS };
