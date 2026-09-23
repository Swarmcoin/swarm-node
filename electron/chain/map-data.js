// The swarm map's data, fetched by the MAIN process.
//
// The renderer has connect-src 'none' and never reaches the network. This
// module fetches two allow-listed URLs — the published list and the live census
// — validates every field before anything is drawn, and keeps the last good copy
// of the published list on disk so the map still shows something honest when the
// machine is offline. The live census is never written to disk.
//
// What this file will NOT do:
//   * fetch anything except the one allow-listed URL;
//   * invent a city, a count or a date;
//   * present stale data as current — the UI is told how old it is.
//
// The same file feeds the map on swarm.green, so the app and the website
// cannot drift apart.

'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');

// Two allow-listed URLs. Not a base, not a pattern, not a template.
const MAP_URL = 'https://swarm.green/data/swarm-map.json';
const LIVE_URL = 'https://lwd.swarm.green/swarm-map-live.json';
const ALLOWED = { [MAP_URL]: true, [LIVE_URL]: true };
const MAX_BYTES = 256 * 1024;
const TIMEOUT_MS = 12000;
const MIN_REFRESH_MS = 10 * 60 * 1000;
const LIVE_STALE_MS = 3 * 60 * 1000;

/**
 * Accept only a shape we can draw, and only coordinates that exist.
 * Returns {ok, data, error}. Never throws.
 */
function validate(raw) {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'the map file is not an object' };
  if (!Array.isArray(raw.nodes)) return { ok: false, error: 'the map file has no node list' };
  if (raw.nodes.length > 5000) return { ok: false, error: 'the map file lists an implausible number of places' };

  const nodes = [];
  for (const n of raw.nodes) {
    if (!n || typeof n !== 'object') continue;
    const lon = Number(n.lon);
    const lat = Number(n.lat);
    const count = Number(n.count);
    if (!Number.isFinite(lon) || lon < -180 || lon > 180) continue;
    if (!Number.isFinite(lat) || lat < -90 || lat > 90) continue;
    if (!Number.isInteger(count) || count < 1 || count > 1000000) continue;
    const city = typeof n.city === 'string' ? n.city.slice(0, 80) : '';
    const country = typeof n.country === 'string' ? n.country.slice(0, 8) : '';
    if (!city) continue;
    if (/[\x00-\x1f]/.test(city + country)) continue;
    nodes.push({ city, country, lon, lat, count });
  }
  if (!nodes.length && raw.nodes.length) return { ok: false, error: 'no usable place in the map file' };

  const updated = typeof raw.updated === 'string' && !Number.isNaN(Date.parse(raw.updated))
    ? raw.updated
    : null;

  return {
    ok: true,
    data: {
      updated,
      source: typeof raw.source === 'string' ? raw.source.slice(0, 200) : null,
      note: typeof raw.note === 'string' ? raw.note.slice(0, 600) : null,
      nodes
    }
  };
}

function validateLive(raw) {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'the live map is not an object' };
  if (raw.live !== true || !Array.isArray(raw.places)) return { ok: false, error: 'the live map is not usable' };
  if (raw.places.length > 5000) return { ok: false, error: 'the live map lists an implausible number of places' };

  const nodes = [];
  for (const p of raw.places) {
    if (!p || typeof p !== 'object') continue;
    const lon = Number(p.lon);
    const lat = Number(p.lat);
    const count = Number(p.count);
    const city = typeof p.city === 'string' ? p.city.slice(0, 80) : '';
    const country = typeof p.country === 'string' ? p.country.slice(0, 8) : '';
    if (!Number.isFinite(lon) || lon < -180 || lon > 180) continue;
    if (!Number.isFinite(lat) || lat < -90 || lat > 90) continue;
    if (!Number.isInteger(count) || count < 1 || count > 1000000) continue;
    if (!city || /[\x00-\x1f]/.test(city + country)) continue;
    nodes.push({ city, country, lon, lat, count });
  }
  if (!nodes.length) return { ok: false, error: 'no usable place in the live map' };

  const generated = Number(raw.generated_unix) || null;
  return {
    ok: true,
    data: {
      nodes,
      updated: typeof raw.updated === 'string' ? raw.updated : null,
      // The seed + its peers, the figure the seed itself publishes. Never
      // recomputed from the places below: a peer whose address the city table
      // cannot place still counts as an online node, so the two can differ.
      nodesOnline: Number.isInteger(raw.nodes_online)
        ? raw.nodes_online : nodes.reduce((acc, n) => acc + n.count, 0),
      ageMs: generated ? Date.now() - generated * 1000 : null,
      source: 'Live: connected to the seed right now',
      note: typeof raw.note === 'string' ? raw.note.slice(0, 600) : null
    }
  };
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    if (!ALLOWED[url]) return reject(new Error('refusing to fetch anything but the swarm map'));
    const req = https.get(url, { timeout: TIMEOUT_MS, headers: { accept: 'application/json' } }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`the map file answered HTTP ${res.statusCode}`));
      }
      let size = 0;
      const chunks = [];
      res.on('data', (c) => {
        size += c.length;
        if (size > MAX_BYTES) { req.destroy(new Error('the map file is too large')); return; }
        chunks.push(c);
      });
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { reject(new Error('the map file is not valid JSON')); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('the map file did not answer in time')));
    req.on('error', (e) => reject(new Error(e.message)));
  });
}

class MapData {
  /** @param {string} cacheFile where the last good copy is kept */
  constructor(cacheFile) {
    this.cacheFile = cacheFile;
    this.lastFetchAt = 0;
    this.inFlight = null;
    this.error = null;
    this.cached = this.readCache();
    this.live = null;        // the live census, never written to disk
    this.liveFetchedAt = 0;
    this.liveInFlight = null;
  }

  readCache() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.cacheFile, 'utf8'));
      const v = validate(parsed.data);
      if (!v.ok) return null;
      return { data: v.data, fetchedAt: Number(parsed.fetchedAt) || null };
    } catch {
      return null;
    }
  }

  writeCache(data) {
    try {
      fs.mkdirSync(path.dirname(this.cacheFile), { recursive: true });
      fs.writeFileSync(this.cacheFile, JSON.stringify({ fetchedAt: Date.now(), data }, null, 2));
    } catch { /* a read-only profile must not break the map */ }
  }

  /**
   * The map's data plus an honest account of where it came from.
   * @param {boolean} force ignore the refresh interval
   */
  async get({ force = false } = {}) {
    const now = Date.now();
    const stale = !this.cached || now - (this.cached.fetchedAt || 0) > MIN_REFRESH_MS;
    if ((force || stale) && !this.inFlight) {
      this.lastFetchAt = now;
      this.inFlight = fetchJson(MAP_URL)
        .then((raw) => {
          const v = validate(raw);
          if (!v.ok) throw new Error(v.error);
          this.cached = { data: v.data, fetchedAt: Date.now() };
          this.writeCache(v.data);
          this.error = null;
        })
        .catch((e) => { this.error = e.message; })
        .finally(() => { this.inFlight = null; });
    }
    // The live census is read separately and never persisted: a saved copy of
    // "connected right now" would be a lie the next time the app is offline.
    const liveDue = force || !this.live || now - (this.liveFetchedAt || 0) > 30 * 1000;
    if (liveDue && !this.liveInFlight) {
      this.liveInFlight = fetchJson(LIVE_URL)
        .then((raw) => {
          const v = validateLive(raw);
          if (!v.ok) throw new Error(v.error);
          this.live = v.data;
          this.liveFetchedAt = Date.now();
        })
        .catch(() => { this.live = null; })
        .finally(() => { this.liveInFlight = null; });
    }
    if (this.inFlight && !this.cached) await this.inFlight;

    const live = this.live
      ? Object.assign({}, this.live, { stale: this.live.ageMs != null && this.live.ageMs > LIVE_STALE_MS })
      : null;

    return {
      ok: !!(live || this.cached),
      data: live
        ? { nodes: live.nodes, updated: live.updated, source: live.source, note: live.note, live }
        : (this.cached ? this.cached.data : null),
      fetchedAt: live ? this.liveFetchedAt : (this.cached ? this.cached.fetchedAt : null),
      offline: !live && !!this.error,
      error: this.error,
      source: live ? LIVE_URL : MAP_URL
    };
  }
}

module.exports = { MapData, validate, validateLive, MAP_URL, LIVE_URL };
