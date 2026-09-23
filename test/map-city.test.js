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

test('once the project has published the same city, it is not drawn twice', () => {
  const mine = C.validateCity({ city: 'dallas', country: 'us', lon: 1, lat: 2 }).city;
  const merged = C.mergePlaces([{ city: 'Dallas', country: 'US', lon: -96.8, lat: 32.78, count: 3 }], mine);
  assert.strictEqual(merged.length, 1);
  assert.strictEqual(merged[0].mine, false);
  assert.strictEqual(merged[0].published, true);
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
