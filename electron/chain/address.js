// Payout address handling.
//
// THIS APP NEVER PARSES AN ADDRESS. Base58Check, Bech32m, unified-address
// encoding, network prefixes and checksums are all consensus-adjacent code,
// and there is already a correct implementation running on this machine: the
// node. So every address the user pastes is handed to the local node and the
// node's own answer decides.
//
//   tm… / t2…   -> validateaddress            -> transparent
//   utest…      -> z_validateaddress          -> unified / sapling
//                  z_listunifiedreceivers     -> what a unified address holds
//
// The only thing done locally is a cheap shape check to keep obviously
// impossible input out of the RPC, and it never decides validity.
//
// No key, seed, passphrase or private material exists anywhere in this app.
// A payout address is a public identifier; it is the only thing stored.

'use strict';

const MAX_LEN = 512;

/** Cheap pre-filter. Says "worth asking the node", never "valid". */
function plausible(addr) {
  if (typeof addr !== 'string') return false;
  const s = addr.trim();
  if (s.length < 20 || s.length > MAX_LEN) return false;
  return /^[0-9A-Za-z]+$/.test(s);
}

/**
 * Ask the node what this address is.
 *
 * @param {import('./rpc').ZebraRpc} rpc
 * @param {string} raw
 * @returns {Promise<{
 *   ok:boolean, address:string, kind:'transparent'|'unified'|'sapling'|null,
 *   modes:string[], detail:string, error?:string
 * }>}
 */
async function validateWithNode(rpc, raw) {
  const address = String(raw == null ? '' : raw).trim();
  if (!plausible(address)) {
    return { ok: false, address, kind: null, modes: [], detail: '', error: 'That does not look like a SWARM address. Copy it from the SWARM Wallet.' };
  }

  // 1. Transparent first: it is the cheapest call and the common case.
  try {
    const t = await rpc.validateAddress(address);
    if (t && t.isvalid === true) {
      return {
        ok: true,
        address,
        kind: 'transparent',
        modes: ['standard'],
        detail: 'Transparent address. Rewards paid to it are visible on the explorer.'
      };
    }
  } catch (e) {
    // A node that is not up yet is a different failure from an invalid address.
    if (e.code === 'NO_COOKIE' || e.code === 'NET' || e.code === 'ECONNREFUSED') {
      return { ok: false, address, kind: null, modes: [], detail: '', error: 'The node is not answering yet. Start the node, then check the address.' };
    }
  }

  // 2. Shielded / unified.
  let z = null;
  try {
    z = await rpc.zValidateAddress(address);
  } catch (e) {
    if (e.code === 'NO_COOKIE' || e.code === 'NET') {
      return { ok: false, address, kind: null, modes: [], detail: '', error: 'The node is not answering yet. Start the node, then check the address.' };
    }
  }

  if (z && z.isvalid === true) {
    const type = String(z.address_type || z.type || '').toLowerCase();
    if (type === 'unified') {
      let receivers = null;
      try { receivers = await rpc.zListUnifiedReceivers(address); } catch { /* optional detail */ }
      const kinds = receivers && typeof receivers === 'object' ? Object.keys(receivers) : [];
      return {
        ok: true,
        address,
        kind: 'unified',
        modes: ['shielded'],
        detail: kinds.length
          ? `Unified address holding ${kinds.join(', ')} receiver(s). Shielded mining pays into it directly.`
          : 'Unified address. Shielded mining pays into it directly.'
      };
    }
    return {
      ok: true,
      address,
      kind: 'sapling',
      modes: [],
      detail: 'Shielded (Sapling) address. Neither mining mode can pay to it: the standard miner needs a transparent address and Zebra’s internal miner needs a unified address.'
    };
  }

  return {
    ok: false,
    address,
    kind: null,
    modes: [],
    detail: '',
    error: 'The node does not recognise that address on this network. Check you copied it from a SWARM Wallet set to the same network.'
  };
}

/** Which mining mode a validated address kind allows. */
function modesForKind(kind) {
  if (kind === 'transparent') return ['standard'];
  if (kind === 'unified') return ['shielded'];
  return [];
}

module.exports = { validateWithNode, plausible, modesForKind, MAX_LEN };
