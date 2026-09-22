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
// WHAT WENT WRONG, 2026-09-22. The owner pasted a good unified address from a
// synced SWARM Wallet and was told "The node does not recognise that address
// on this network." The address was fine; the node never answered. Only three
// transport error codes were mapped to "the node is not answering" - every
// other failure (a rejected cookie, a timeout, a method the node does not
// implement, a non-JSON reply) fell through to a sentence that ASSERTS the
// node rejected the address. It is only ever true to say the node said no
// when the node actually said no.
//
// So this file now distinguishes three outcomes, not two:
//   confirmed     the node answered and accepted it;
//   refused       the node answered and rejected it  -> blame the address;
//   unconfirmed   the node did not answer at all     -> blame nothing, say
//                 what happened, and let a well-formed address be used.
//
// No key, seed, passphrase or private material exists anywhere in this app.
// A payout address is a public identifier; it is the only thing stored.

'use strict';

const { inspect } = require('./address-format');

const MAX_LEN = 512;

/**
 * Error codes that mean "the node did not answer", as opposed to "the node
 * answered no". This is a deny-list turned inside out on purpose: ANY error
 * is treated as "no answer" unless the node produced a real verdict, because
 * the cost of being wrong the other way is telling someone their good address
 * is bad. `AUTH` (a stale cookie against another node on the same port) and
 * `TIMEOUT` are in here because both of those really happened.
 */
const NO_ANSWER = new Set(['NO_COOKIE', 'NET', 'ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'TIMEOUT', 'AUTH', 'PARSE']);

/** A short, true description of why the node could not answer. */
function whyNoAnswer(code) {
  if (code === 'NO_COOKIE' || code === 'ECONNREFUSED' || code === 'NET') return 'your node is not running';
  if (code === 'TIMEOUT') return 'your node did not answer in time';
  if (code === 'AUTH') return 'something else is using your node’s control port';
  if (code === 'PARSE') return 'your node gave an answer this app could not read';
  return 'your node did not answer';
}

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
    return { ok: false, address, kind: null, modes: [], detail: '', confirmed: false, error: 'That does not look like a SWARM address. Copy it from the SWARM Wallet.' };
  }

  /** Did the node produce a verdict, or did the call simply fail? */
  const ask = async (fn) => {
    try {
      return { answered: true, value: await fn() };
    } catch (e) {
      const code = e && e.code;
      // Anything that is not an explicit "no" from the node counts as no
      // answer, including RPC-level numeric codes such as method-not-found.
      return { answered: false, noAnswer: NO_ANSWER.has(code) || typeof code === 'number' || code == null, code };
    }
  };

  // 1. Transparent first: it is the cheapest call and the common case.
  const t = await ask(() => rpc.validateAddress(address));
  if (t.answered && t.value && t.value.isvalid === true) {
    return {
      ok: true,
      address,
      kind: 'transparent',
      modes: ['standard'],
      confirmed: true,
      detail: 'Transparent address. Rewards paid to it are visible on the explorer.'
    };
  }

  // 2. Shielded / unified.
  const z = await ask(() => rpc.zValidateAddress(address));
  if (z.answered && z.value && z.value.isvalid === true) {
    const type = String(z.value.address_type || z.value.type || '').toLowerCase();
    if (type === 'unified') {
      let receivers = null;
      try { receivers = await rpc.zListUnifiedReceivers(address); } catch { /* optional detail */ }
      const kinds = receivers && typeof receivers === 'object' ? Object.keys(receivers) : [];
      return {
        ok: true,
        address,
        kind: 'unified',
        modes: ['shielded'],
        confirmed: true,
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
      confirmed: true,
      detail: 'Shielded (Sapling) address. Neither mining mode can pay to it: the standard miner needs a transparent address and Zebra’s internal miner needs a unified address.'
    };
  }

  // 3. Neither call produced a verdict. The node is not in a position to
  //    judge, so neither is this app: fall back to the shape of the string,
  //    accept it if it is well formed, and say plainly what is missing.
  if (!t.answered || !z.answered) {
    const why = whyNoAnswer(t.answered ? z.code : t.code);
    const shape = inspect(address);
    if (shape.looksValid) {
      return {
        ok: true,
        address,
        kind: shape.kind,
        modes: shape.mode ? [shape.mode] : [],
        confirmed: false,
        detail: `${shape.label}. ${shape.detail}`,
        note: `Saved, but not checked yet: ${why}. Start the node to confirm the address.`
      };
    }
    return {
      ok: false,
      address,
      kind: null,
      modes: [],
      confirmed: false,
      detail: '',
      error: `${shape.hint || 'That does not look like a SWARM address.'} It could not be checked either, because ${why}.`
    };
  }

  // 4. The node answered, twice, and said no. Only now is it true to say so.
  return {
    ok: false,
    address,
    kind: null,
    modes: [],
    confirmed: false,
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

module.exports = { validateWithNode, plausible, modesForKind, MAX_LEN, NO_ANSWER };
