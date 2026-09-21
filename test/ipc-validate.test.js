'use strict';

const test = require('node:test');
const assert = require('node:assert');
const V = require('../electron/ipc-validate');

test('booleans must actually be booleans', () => {
  assert.strictEqual(V.bool(true), true);
  assert.strictEqual(V.bool(false), false);
  for (const bad of ['true', 1, 0, null, undefined, {}, []]) {
    assert.throws(() => V.bool(bad), /must be true or false/);
  }
});

test('integers reject strings, floats and the usual nonsense', () => {
  assert.strictEqual(V.int(4, { min: 1, max: 8 }), 4);
  for (const bad of ['4', 4.5, NaN, Infinity, null, [4]]) {
    assert.throws(() => V.int(bad, { min: 1, max: 8 }));
  }
  assert.throws(() => V.int(0, { min: 1, max: 8 }), /at least 1/);
  assert.throws(() => V.int(9, { min: 1, max: 8 }), /at most 8/);
});

test('text rejects control characters and over-long input', () => {
  assert.strictEqual(V.text('  hello  '), 'hello');
  assert.throws(() => V.text('a\u0000b'), /control characters/);
  assert.throws(() => V.text('a\nb'), /control characters/);
  assert.throws(() => V.text('x'.repeat(513)), /too long/);
  assert.throws(() => V.text(42), /must be text/);
});

test('a payout address is letters and digits only — no path, no shell, no argument injection', () => {
  const ok = 'tmJymvcUCn1ctbghvTJpXBwHiMEB8P6wxNV';
  assert.strictEqual(V.payoutAddress(' ' + ok + ' '), ok);
  for (const bad of [
    '--payout=evil',
    'tm123; calc.exe',
    'tm123 & del',
    '../../etc/passwd',
    'C:\\Windows\\System32',
    'tm123`whoami`',
    'tm123$(id)',
    'tm123|nc',
    'tm-with-dash-00000000000000000000'
  ]) {
    assert.throws(() => V.payoutAddress(bad), /letters and digits only|control characters|too long|too short/, `must reject ${bad}`);
  }
  assert.throws(() => V.payoutAddress('short'), /too short/);
});

test('mining mode is one of exactly two values', () => {
  assert.strictEqual(V.miningMode('standard'), 'standard');
  assert.strictEqual(V.miningMode('shielded'), 'shielded');
  assert.throws(() => V.miningMode('gpu'), /must be one of/);
  assert.throws(() => V.miningMode('STANDARD'), /must be one of/);
});

test('a data folder must be absolute, local, and outside the Windows directories', () => {
  if (process.platform === 'win32') {
    assert.strictEqual(V.dataDir('D:\\SWARM\\chain'), 'D:\\SWARM\\chain');
    assert.strictEqual(V.dataDir('C:/Users/me/SWARM'), 'C:/Users/me/SWARM');
    assert.throws(() => V.dataDir('chain'), /local drive/);
    assert.throws(() => V.dataDir('C:\\Windows\\System32'), /belongs to Windows/);
    assert.throws(() => V.dataDir('C:\\Program Files\\x'), /belongs to Windows/);
    assert.throws(() => V.dataDir('\\\\server\\share'), /belongs to Windows|local drive/);
  }
  assert.throws(() => V.dataDir('D:\\a\\..\\..\\Windows'), /may not contain/);
  assert.throws(() => V.dataDir('ab'), /too short/);
});

test('only the app\u2019s own https links can be opened in the browser', () => {
  const hosts = ['swarm.green', 'explore.swarm.green', 'github.com'];
  assert.strictEqual(V.externalUrl('https://swarm.green/', hosts), 'https://swarm.green/');
  assert.throws(() => V.externalUrl('http://swarm.green/', hosts), /Only https/);
  assert.throws(() => V.externalUrl('file:///C:/Windows/System32/cmd.exe', hosts), /Only https/);
  assert.throws(() => V.externalUrl('javascript:alert(1)', hosts), /Only https/);
  assert.throws(() => V.externalUrl('https://evil.example/', hosts), /not one of/);
});

test('log limits are clamped to a sane range', () => {
  assert.strictEqual(V.logLimit(undefined), 300);
  assert.strictEqual(V.logLimit(null), 300);
  assert.strictEqual(V.logLimit(50), 50);
  assert.throws(() => V.logLimit(0));
  assert.throws(() => V.logLimit(100000));
  assert.throws(() => V.logLimit('300'));
});

test('oneOf is exact', () => {
  assert.strictEqual(V.oneOf('a', ['a', 'b']), 'a');
  assert.throws(() => V.oneOf('c', ['a', 'b']), /must be one of/);
});
