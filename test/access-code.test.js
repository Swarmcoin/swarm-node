'use strict';

// The closed-start access code (electron/chain/access-code.js).
//
// One pasted string carries this machine's tunnel key. These tests hold the
// parser to the format the operator tool writes (the vector in fixtures/ was
// produced by scripts/swarm/closed/make_access_code.py in the project
// repository), and to the promise that nothing but the machine name ever
// leaves the parser in a form the window or a log could show.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const AC = require('../electron/chain/access-code');
const VECTOR = require('./fixtures/access-code-vector.json');

const key = () => crypto.randomBytes(32).toString('base64');
const payload = (over = {}) => ({
  v: 1, n: 'alienware', k: key(), a: '10.88.0.3', s: key(), e: '64.95.11.180:51820', p: '10.88.0.1:28233', ...over
});

test('the operator tool and the app agree, byte for byte', () => {
  const r = AC.parse(VECTOR.code);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.payload.name, VECTOR.payload.n);
  assert.equal(r.payload.privateKey, VECTOR.payload.k);
  assert.equal(r.payload.serverPublicKey, VECTOR.payload.s);
  assert.equal(r.payload.tunnelAddress, '10.88.0.250');
  assert.equal(r.payload.endpointHost, '203.0.113.7');
  assert.equal(r.payload.endpointPort, 51820);
  assert.equal(r.payload.nodeHost, '10.88.0.1');
  assert.equal(r.payload.nodePort, 28233);
  // And encoding the same payload in the app produces the tool's string.
  assert.equal(AC.encode(VECTOR.payload), VECTOR.code);
});

test('a valid code round-trips, and whitespace from a wrapped paste is ignored', () => {
  const p = payload();
  const code = AC.encode(p);
  assert.ok(code.startsWith('SWARMKEY1.'));
  const wrapped = `  ${code.slice(0, 25)}\r\n${code.slice(25, 80)}\n  ${code.slice(80)}\n`;
  const r = AC.parse(wrapped);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.code, code);
  assert.equal(r.payload.privateKey, p.k);
});

test('a bad checksum is a typo, and says so', () => {
  const code = AC.encode(payload());
  const last = code.slice(-1);
  const r = AC.parse(code.slice(0, -1) + (last === '0' ? '1' : '0'));
  assert.equal(r.ok, false);
  assert.match(r.error, /typo/);
  // One changed character in the body is caught the same way.
  const [pre, body, sum] = code.split('.');
  const i = Math.floor(body.length / 2);
  const swapped = body.slice(0, i) + (body[i] === 'A' ? 'B' : 'A') + body.slice(i + 1);
  const r2 = AC.parse(`${pre}.${swapped}.${sum}`);
  assert.equal(r2.ok, false);
  assert.match(r2.error, /typo/);
});

test('the wrong prefix, or no prefix, is refused', () => {
  const code = AC.encode(payload());
  for (const bad of [code.replace('SWARMKEY1.', 'SWARMKEY2.'), code.replace('SWARMKEY1.', ''), 'hello', '']) {
    const r = AC.parse(bad);
    assert.equal(r.ok, false, bad.slice(0, 20));
  }
  assert.match(AC.parse(code.replace('SWARMKEY1.', 'SWARMKEY2.')).error, /SWARMKEY1/);
  assert.equal(AC.parse(null).ok, false);
  assert.equal(AC.parse('x'.repeat(5000)).ok, false);
});

test('wrong lengths are refused: keys must be 32 bytes, and the code must be whole', () => {
  for (const over of [
    { k: crypto.randomBytes(31).toString('base64') },
    { k: crypto.randomBytes(33).toString('base64') },
    { s: crypto.randomBytes(16).toString('base64') },
    { k: 'not-a-key' }
  ]) {
    assert.throws(() => AC.encode(payload(over)), AC.AccessCodeError, JSON.stringify(Object.keys(over)));
  }
  const code = AC.encode(payload());
  assert.equal(AC.parse(code.slice(0, code.lastIndexOf('.'))).ok, false, 'no checksum');
  assert.equal(AC.parse(code.slice(0, 30) + '.' + code.split('.')[2]).ok, false, 'truncated body');
});

test('every field is checked strictly', () => {
  const bad = [
    { a: '10.88.0' }, { a: '10.88.0.300' }, { a: '0.0.0.0' }, { a: '127.0.0.1' }, { a: '010.88.0.3' }, { a: '10.88.0.3/32' },
    { p: '10.88.0.1' }, { p: '10.88.0.1:0' }, { p: '10.88.0.1:65536' }, { p: 'node.example:28233' }, { p: '10.88.0.3:28233' },
    { e: '64.95.11.180' }, { e: '64.95.11.180:99999' }, { e: 'bad_host:51820' }, { e: '[::1]:51820' },
    { n: '' }, { n: ' lead' }, { n: 'x'.repeat(41) }, { n: 'semi;colon' },
    { v: 2 }, { v: '1' }
  ];
  for (const over of bad) {
    assert.throws(() => AC.encode(payload(over)), AC.AccessCodeError, JSON.stringify(over));
  }
  assert.doesNotThrow(() => AC.encode(payload({ e: 'wg.swarm.green:51820' })));
});

test('a field too many or too few is refused even with a correct checksum', () => {
  const p = payload();
  for (const mutate of [(d) => { d.x = 1; }, (d) => { delete d.p; }]) {
    const d = { ...p };
    mutate(d);
    const body = Buffer.from(JSON.stringify(d), 'utf8').toString('base64url');
    const r = AC.parse(`SWARMKEY1.${body}.${AC.checksum(body)}`);
    assert.equal(r.ok, false);
    assert.match(r.error, /fields/);
  }
});

test('describe() names the machine and never carries the key or the code', () => {
  const p = payload();
  const code = AC.encode(p);
  const d = AC.describe(AC.parse(code).payload);
  assert.deepEqual(Object.keys(d).sort(), ['machine', 'node', 'server', 'tunnelAddress']);
  const text = JSON.stringify(d);
  assert.ok(!text.includes(p.k));
  assert.ok(!text.includes(code.split('.')[1].slice(0, 16)));
});

test('a parse error never echoes what was pasted', () => {
  const p = payload();
  const code = AC.encode(p);
  for (const bad of [code.slice(0, -1) + 'z', code.replace('SWARMKEY1.', 'X.'), code + '.extra']) {
    const r = AC.parse(bad);
    assert.equal(r.ok, false);
    assert.ok(!r.error.includes(p.k));
    assert.ok(!r.error.includes(code.split('.')[1].slice(0, 12)));
  }
});
