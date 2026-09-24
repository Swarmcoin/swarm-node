'use strict';

// The map draws whatever this validator lets through, so the validator is the
// place a fabricated city or an out-of-range coordinate has to be stopped.

const test = require('node:test');
const assert = require('node:assert');
const { MapData, validate, validateLive, MAP_URL } = require('../electron/chain/map-data');

const LIVE = {
  updated: '2026-09-21T17:23:00Z',
  source: 'Operated by the SWARM project',
  note: 'Not a census of the network.',
  nodes: [{ city: 'Dallas', country: 'US', lon: -96.8, lat: 32.78, count: 1 }]
};

test('the live file is accepted as it stands', () => {
  const v = validate(LIVE);
  assert.strictEqual(v.ok, true);
  assert.strictEqual(v.data.nodes.length, 1);
  assert.deepStrictEqual(v.data.nodes[0], { city: 'Dallas', country: 'US', lon: -96.8, lat: 32.78, count: 1 });
  assert.strictEqual(v.data.updated, '2026-09-21T17:23:00Z');
});

test('only one URL is ever fetched', () => {
  assert.strictEqual(MAP_URL, 'https://swarm.green/data/swarm-map.json');
});

test('impossible coordinates are dropped, not drawn somewhere wrong', () => {
  const v = validate({ nodes: [
    { city: 'Nowhere', lon: 900, lat: 0, count: 1 },
    { city: 'Nowhere2', lon: 0, lat: -91, count: 1 },
    { city: 'Real', lon: 13.4, lat: 52.5, count: 2 }
  ] });
  assert.strictEqual(v.ok, true);
  assert.deepStrictEqual(v.data.nodes.map((n) => n.city), ['Real']);
});

test('a count that is not a sane whole number is dropped', () => {
  const v = validate({ nodes: [
    { city: 'A', lon: 0, lat: 0, count: 0 },
    { city: 'B', lon: 0, lat: 0, count: -3 },
    { city: 'C', lon: 0, lat: 0, count: 1.5 },
    { city: 'D', lon: 0, lat: 0, count: 2 }
  ] });
  assert.deepStrictEqual(v.data.nodes.map((n) => n.city), ['D']);
});

test('a nameless place is dropped rather than drawn as a blank hotspot', () => {
  const v = validate({ nodes: [{ lon: 0, lat: 0, count: 5 }, { city: 'Real', lon: 1, lat: 1, count: 1 }] });
  assert.deepStrictEqual(v.data.nodes.map((n) => n.city), ['Real']);
});

test('control characters in a place name are refused', () => {
  const v = validate({ nodes: [{ city: 'Ok\u0007', lon: 0, lat: 0, count: 1 }, { city: 'Fine', lon: 1, lat: 1, count: 1 }] });
  assert.deepStrictEqual(v.data.nodes.map((n) => n.city), ['Fine']);
});

test('a malformed file is refused outright', () => {
  assert.strictEqual(validate(null).ok, false);
  assert.strictEqual(validate({}).ok, false);
  assert.strictEqual(validate({ nodes: 'lots' }).ok, false);
  assert.strictEqual(validate({ nodes: new Array(5001).fill({ city: 'x', lon: 0, lat: 0, count: 1 }) }).ok, false);
});

test('an empty but well-formed file is fine: the map simply has nothing on it', () => {
  const v = validate({ updated: '2026-09-21T00:00:00Z', nodes: [] });
  assert.strictEqual(v.ok, true);
  assert.strictEqual(v.data.nodes.length, 0);
});

test('a bad date becomes null rather than a wrong "updated" claim', () => {
  assert.strictEqual(validate({ updated: 'whenever', nodes: [] }).data.updated, null);
});

function census(generated = Date.now() / 1000) {
  return validateLive({ live: true, generated_unix: generated, nodes_online: 3,
    places: [{ city: 'Dallas', country: 'US', lon: -96.8, lat: 32.78, count: 1 },
      { city: 'Santo Domingo', country: 'DO', lon: -69.94, lat: 18.46, count: 2 }] });
}

test('first map response waits for the live census instead of returning only the static seed', async () => {
  const map = new MapData('unused-test-cache');
  map.cached = { data: validate(LIVE).data, fetchedAt: Date.now() };
  map.liveInFlight = new Promise((resolve) => setTimeout(() => {
    map.live = census().data;
    map.liveFetchedAt = Date.now();
    resolve();
  }, 10));
  const result = await map.get();
  assert.equal(result.data.live.nodesOnline, 3);
  assert.equal(result.data.nodes.length, 2);
});

test('a recently fetched but old census is stale according to its generation time', async () => {
  const map = new MapData('unused-test-cache');
  map.cached = { data: validate(LIVE).data, fetchedAt: Date.now() };
  map.live = census((Date.now() - 240000) / 1000).data;
  map.liveFetchedAt = Date.now();
  const result = await map.get();
  assert.equal(result.data.live.stale, true);
  assert.ok(result.data.live.ageMs >= 240000);
});

test('a census without a credible timestamp cannot be labelled live', () => {
  for (const value of [undefined, null, 'invalid', -1, (Date.now() + 120000) / 1000]) {
    assert.equal(census(value === undefined ? NaN : value).ok, false);
  }
});
