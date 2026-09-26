'use strict';

const test = require('node:test');
const assert = require('node:assert');
const C = require('../electron/map-city');

const good = { city: 'Dallas', country: 'us', lon: -96.8, lat: 32.78 };

test('a city is accepted with its coordinates and normalised', () => {
  const r = C.validateCity(good);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.city, { city: 'Dallas', country: 'US', lon: -96.8, lat: 32.78 });
});

test('coordinates are rounded to about a kilometre, never finer', () => {
  const r = C.validateCity({ city: 'Warsaw', country: 'PL', lon: 21.0111111, lat: 52.2299999 });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.city.lon, 21.01);
  assert.strictEqual(r.city.lat, 52.23);
});

test('a city without a name is refused, and so is nonsense', () => {
  assert.strictEqual(C.validateCity({ city: '   ', country: 'US', lon: 0, lat: 0 }).ok, false);
  assert.strictEqual(C.validateCity(null).ok, false);
  assert.strictEqual(C.validateCity({ city: 'A\u0000B', country: 'US', lon: 0, lat: 0 }).ok, false);
});

test('coordinates outside the world are refused', () => {
  assert.strictEqual(C.validateCity({ ...good, lon: 181 }).ok, false);
  assert.strictEqual(C.validateCity({ ...good, lat: -91 }).ok, false);
  assert.strictEqual(C.validateCity({ ...good, lon: 'east' }).ok, false);
  assert.strictEqual(C.validateCity({ ...good, lat: NaN }).ok, false);
});

test('names longer than the store allows are refused', () => {
  assert.strictEqual(C.validateCity({ ...good, city: 'x'.repeat(81) }).ok, false);
  assert.strictEqual(C.validateCity({ ...good, country: 'TOOLONGCODE' }).ok, false);
});

test('the map shows the published places, marked as published', () => {
  const merged = C.mergePlaces([{ city: 'Dallas', country: 'US', lon: -96.8, lat: 32.78, count: 1 }], null);
  assert.strictEqual(merged.length, 1);
  assert.deepStrictEqual([merged[0].mine, merged[0].published], [false, true]);
});

test("the operator's own city is added, marked as theirs and not published", () => {
  const mine = C.validateCity({ city: 'Warsaw', country: 'PL', lon: 21.01, lat: 52.23 }).city;
  const merged = C.mergePlaces([{ city: 'Dallas', country: 'US', lon: -96.8, lat: 32.78, count: 1 }], mine);
  assert.strictEqual(merged.length, 2);
  const mineEntry = merged.find((p) => p.mine);
  assert.ok(mineEntry, 'their city should be on the map');
  assert.strictEqual(mineEntry.city, 'Warsaw');
  assert.strictEqual(mineEntry.published, false);
  assert.strictEqual(mineEntry.count, 1);
});

// Not drawn twice, and not silently un-marked either. The live census names
// the operator's own city as soon as their node connects to the seed, which is
// precisely when "that dot is you" became true - and the old rule chose that
// moment to drop their marker.
test('once the file names the same city, it is marked as theirs, not drawn twice', () => {
  const mine = C.validateCity({ city: 'dallas', country: 'us', lon: 1, lat: 2 }).city;
  const merged = C.mergePlaces([{ city: 'Dallas', country: 'US', lon: -96.8, lat: 32.78, count: 3 }], mine);
  assert.strictEqual(merged.length, 1);
  assert.strictEqual(merged[0].mine, true, 'the place the operator is in is marked as theirs');
  // Still the file's place, with the file's count and the file's coordinates:
  // `mine` says where the operator is, it does not take the entry over.
  assert.strictEqual(merged[0].published, true);
  assert.strictEqual(merged[0].count, 3);
  assert.strictEqual(merged[0].lon, -96.8);
  assert.strictEqual(merged[0].city, 'Dallas');
});

test('marking the operator’s city never changes the swarm’s own totals', () => {
  const file = [
    { city: 'Dallas', country: 'US', lon: -96.8, lat: 32.78, count: 1 },
    { city: 'Santo Domingo', country: 'DO', lon: -69.94, lat: 18.46, count: 1 }
  ];
  const mine = C.validateCity({ city: 'Santo Domingo', country: 'DO', lon: -69.94, lat: 18.46 }).city;
  const merged = C.mergePlaces(file, mine);
  const fromFile = merged.filter((n) => n.published !== false);
  assert.strictEqual(fromFile.length, 2, 'both published cities still count');
  assert.strictEqual(fromFile.reduce((a, n) => a + n.count, 0), 2);
  assert.strictEqual(merged.filter((n) => n.mine).length, 1, 'exactly one marker is theirs');
});

test('with no published file at all, the operator still sees their own city', () => {
  const merged = C.mergePlaces(null, C.validateCity(good).city);
  assert.strictEqual(merged.length, 1);
  assert.strictEqual(merged[0].mine, true);
});

test('the request line names the place and its coordinates, and says city level', () => {
  const line = C.publishRequest(C.validateCity(good).city);
  assert.match(line, /Dallas, US/);
  assert.match(line, /-96\.8, 32\.78/);
  assert.match(line, /City level only/);
});

test('there is no request line without a city', () => {
  assert.strictEqual(C.publishRequest(null), '');
  assert.strictEqual(C.publishRequest({}), '');
});
