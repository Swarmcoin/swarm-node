// How big is the swarm, without making a number up.
//
// The owner connected a node, saw "1" on the map page and asked why their node
// was not counted. The map is an OPT-IN list of cities, not a census, so it
// never was a count of the network. This module supplies the one network-wide
// figure that can actually be checked: what the project's own seed server
// publishes about itself at a fixed, allow-listed URL.
//
// Rules this file exists to keep:
//   * exactly one URL, not a base, not a template;
//   * every field validated, and the payload REFUSED if its genesis hash or
//     chain label is not the network this build is for - another network's
//     numbers are worse than no numbers;
//   * nothing is cached to disk. This is a "right now" figure, and a value
//     from last week presented as current would be a lie. The caller is told
//     how old the value is and shows it that way.
//   * if the fetch fails there is no fallback figure here. The UI falls back
//     to the local node's own peer count, labelled as exactly that.
//
// What `peers` means, precisely: the number of peer connections the SEED node
// reports. It is a lower bound on the network and the UI must say so. It is
// not "how many people run SWARM".

'use strict';

const https = require('https');
const NP = require('./network-profile');

// One URL, PER NETWORK. This was a constant naming the testnet's light-wallet
// host, so a SWARM mainnet build asked the testnet server about the main
// chain; the answer was refused (rightly - its genesis is another network's)
// and the app showed no network figures at all. The caller passes the URL its
// profile publishes; see NP.lightWalletUrls.
//
// There is no fixed fallback any more. A URL the caller did not pass, or one
// outside the allow-list, used to become the TESTNET feed whatever network was
// running. It now comes from the chain label of the running network, and when
// that names no SWARM network nothing is fetched at all: see statusUrlFor.
const MAX_BYTES = 64 * 1024;
const TIMEOUT_MS = 10000;
const MIN_REFRESH_MS = 30 * 1000;   // the file itself regenerates every 30s
// Older than this and the figure is reported as stale rather than current.
const STALE_AFTER_MS = 10 * 60 * 1000;

// A count, or nothing. Deliberately strict about the TYPE as well as the
// range: Number(null) is 0 and Number(true) is 1, so a coercing check would
// turn a missing field into a confident "0 nodes". A string "7" is refused for
// the same reason - if the server's type changes, the honest answer is that we
// do not know, not a value we guessed the meaning of.
const int = (v, max) =>
  (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= max ? v : null);

/**
 * Keep only what we will show, and only when it is the right network.
 * Returns {ok, data, error}. Never throws.
 *
 * @param {object} raw     the parsed payload
 * @param {object} expect  {genesisHash, chainLabel} from the embedded manifest
 */
function validate(raw, expect = {}) {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'the status file is not an object' };
  if (raw.schema !== 'swarm-network-status/1') {
    return { ok: false, error: `unknown status schema ${String(raw.schema).slice(0, 40)}` };
  }

  // Refuse another network's numbers outright.
  const gen = String(raw.genesis_hash || '').toLowerCase();
  const want = String(expect.genesisHash || '').toLowerCase();
  if (want && gen !== want) return { ok: false, error: 'the status file is for a different network' };
  const label = String(raw.chain_label || '');
  if (expect.chainLabel && label !== expect.chainLabel) {
    return { ok: false, error: 'the status file is for a different network' };
  }

  const node = raw.node && typeof raw.node === 'object' ? raw.node : {};
  const data = {
    network: typeof raw.network === 'string' ? raw.network.slice(0, 60) : null,
    serverTimeUtc: typeof raw.server_time_utc === 'string' ? raw.server_time_utc.slice(0, 40) : null,
    // The figure the owner asked for. null when the seed does not publish it,
    // which is a fact the UI states rather than papers over.
    seedPeers: int(node.peers, 100000),
    seedHeight: int(node.height, 1e9),
    seedUp: node.up === true,
    note: typeof raw.note === 'string' ? raw.note.slice(0, 400) : null
  };
  return { ok: true, data };
}

// Which URLs this module may ever fetch. The allow-list stays - the page has
// connect-src 'none' and this is the one outbound request the main process
// makes on the renderer's behalf - but it now holds one entry per SWARM
// network instead of one entry, full stop.
const ALLOWED_STATUS_URLS = Object.freeze(
  NP.PROFILES.map((p) => NP.lightWalletUrls(p).statusUrl)
);

/**
 * The status file this network publishes, or null.
 *
 * The chain label comes from the embedded definition of the running network,
 * so it decides: a URL that belongs to the OTHER network is never used, and a
 * mainnet node cannot be pointed at the testnet feed by a missing or stale
 * argument. Without a chain label, only an allow-listed URL is accepted.
 *
 * @param {object} expect {statusUrl, chainLabel}
 * @returns {string|null}
 */
function statusUrlFor(expect = {}) {
  const own = NP.PROFILES.find((p) => p.chainLabel === expect.chainLabel) || null;
  const ownUrl = own ? NP.lightWalletUrls(own).statusUrl : null;
  if (ALLOWED_STATUS_URLS.includes(expect.statusUrl) && (!ownUrl || expect.statusUrl === ownUrl)) {
    return expect.statusUrl;
  }
  return ownUrl;
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    if (!ALLOWED_STATUS_URLS.includes(url)) {
      return reject(new Error('refusing to fetch anything but the network status'));
    }
    const req = https.get(url, { timeout: TIMEOUT_MS, headers: { accept: 'application/json' } }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`the status file answered HTTP ${res.statusCode}`));
      }
      let size = 0;
      const chunks = [];
      res.on('data', (c) => {
        size += c.length;
        if (size > MAX_BYTES) { req.destroy(new Error('the status file is too large')); return; }
        chunks.push(c);
      });
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { reject(new Error('the status file is not valid JSON')); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('the status file did not answer in time')));
    req.on('error', (e) => reject(new Error(e.message)));
  });
}

class NetworkStatus {
  /**
   * @param {object} expect {genesisHash, chainLabel, statusUrl}
   *   genesisHash / chainLabel come from the embedded manifest and are what
   *   another network's numbers are refused by; statusUrl comes from the
   *   running profile, because the seed that publishes them is a different
   *   machine on each network.
   */
  constructor(expect = {}) {
    this.expect = expect;
    // null when neither the URL nor the chain label names a SWARM network;
    // get() then reports that instead of fetching anything.
    this.url = statusUrlFor(expect);
    this.value = null;        // last accepted payload
    this.fetchedAt = 0;
    this.error = null;
    this.inFlight = null;
  }

  /** @param {boolean} force ignore the refresh interval */
  async get({ force = false } = {}) {
    const now = Date.now();
    if (!this.url) {
      return {
        ok: false, data: null, fetchedAt: null, ageMs: null, stale: false,
        error: 'this build names no SWARM network status file', source: null
      };
    }
    if ((force || now - this.fetchedAt > MIN_REFRESH_MS) && !this.inFlight) {
      this.inFlight = fetchJson(this.url)
        .then((raw) => {
          const v = validate(raw, this.expect);
          if (!v.ok) throw new Error(v.error);
          this.value = v.data;
          this.fetchedAt = Date.now();
          this.error = null;
        })
        .catch((e) => { this.error = e.message; })
        .finally(() => { this.inFlight = null; });
    }
    // A refresh returns its new result, not the previous poll's peer count.
    if (this.inFlight) await this.inFlight;

    const ageMs = this.value ? Date.now() - this.fetchedAt : null;
    return {
      ok: !!this.value,
      data: this.value,
      fetchedAt: this.value ? this.fetchedAt : null,
      ageMs,
      stale: ageMs != null && ageMs > STALE_AFTER_MS,
      error: this.error,
      source: this.url
    };
  }
}

module.exports = { NetworkStatus, validate, statusUrlFor, ALLOWED_STATUS_URLS, STALE_AFTER_MS };
