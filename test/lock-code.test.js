'use strict';

const test = require('node:test');
const assert = require('node:assert');
const L = require('../electron/lock-code');

test('a code is six to twelve digits, and nothing else', () => {
  assert.deepStrictEqual(L.checkShape('123456'), { ok: true, code: '123456' });
  assert.deepStrictEqual(L.checkShape(' 123456 '), { ok: true, code: '123456' });
  assert.strictEqual(L.checkShape('12345').ok, false);
  assert.strictEqual(L.checkShape('1234567890123').ok, false);
  assert.strictEqual(L.checkShape('12345a').ok, false);
  assert.strictEqual(L.checkShape('').ok, false);
  assert.strictEqual(L.checkShape(undefined).ok, false);
});

test('the record holds a salt and a derived key, never the code', () => {
  const { ok, record } = L.createRecord('123456');
  assert.strictEqual(ok, true);
  assert.strictEqual(L.isRecord(record), true);
  assert.ok(record.salt.length > 0);
  assert.ok(record.hash.length > 0);
  assert.ok(!JSON.stringify(record).includes('123456'));
  // Two records for the same code differ, because the salt is random.
  assert.notStrictEqual(L.createRecord('123456').record.hash, record.hash);
});

test('a record is refused if it is not one this module wrote', () => {
  assert.strictEqual(L.isRecord(null), false);
  assert.strictEqual(L.isRecord({}), false);
  assert.strictEqual(L.isRecord({ salt: 'x' }), false);
  assert.strictEqual(L.isRecord('a string'), false);
});

test('the right code matches and the wrong one does not', () => {
  const record = L.createRecord('123456').record;
  assert.strictEqual(L.matches(record, '123456'), true);
  assert.strictEqual(L.matches(record, '123457'), false);
  assert.strictEqual(L.matches(record, ''), false);
  assert.strictEqual(L.matches(record, 123456), false);
});

test('five free tries, then a wait that grows, and a good code clears it', () => {
  let clock = 1_000_000;
  const gate = L.createGate(() => clock);
  const record = L.createRecord('123456').record;

  for (let i = 0; i < L.FREE_ATTEMPTS - 1; i++) {
    const result = gate.verify(record, '000000');
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.waitSeconds, 0);
  }
  const fifth = gate.verify(record, '000000');
  assert.strictEqual(fifth.ok, false);
  assert.strictEqual(fifth.waitSeconds, 1);

  // While the wait is running, even the right code is refused: otherwise the
  // wait would only slow down somebody who keeps guessing wrong.
  const during = gate.verify(record, '123456');
  assert.strictEqual(during.ok, false);
  assert.ok(during.waitSeconds > 0);

  clock += 1000;
  assert.strictEqual(gate.verify(record, '123456').ok, true);
  assert.strictEqual(gate.waitSeconds(), 0);

  // And the count is back to nothing after a success.
  assert.strictEqual(gate.verify(record, '000000').waitSeconds, 0);
});

test('the wait is capped at a minute however many tries are made', () => {
  let clock = 0;
  const gate = L.createGate(() => clock);
  const record = L.createRecord('123456').record;
  for (let i = 0; i < 20; i++) {
    clock += 120_000;
    const result = gate.verify(record, '000000');
    assert.ok(result.waitSeconds <= 60);
  }
});

test('with no record there is nothing to verify, and that is not an error', () => {
  const gate = L.createGate(() => 0);
  assert.deepStrictEqual(gate.verify(null, 'anything'), { ok: true, waitSeconds: 0 });
});
