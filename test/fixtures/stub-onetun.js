// A stand-in for onetun, for test/tunnel.test.js. It prints what onetun prints
// (pretty_env_logger lines on stderr) and behaves according to STUB_MODE. It
// never opens a network socket.
//
// It also writes what it was given to STUB_REPORT, so the test can check that
// the key arrived through the environment and NOT on the command line.

'use strict';

const fs = require('fs');

const args = process.argv.slice(2);
const mode = process.env.STUB_MODE || 'ok';
const report = process.env.STUB_REPORT;
if (report) {
  fs.appendFileSync(report, JSON.stringify({ args, hasKey: typeof process.env.ONETUN_PRIVATE_KEY === 'string', key: process.env.ONETUN_PRIVATE_KEY }) + '\n');
}

const say = (level, target, msg) => process.stderr.write(` ${new Date().toISOString()} ${level} ${target} > ${msg}\n`);
const fwd = args[0] || '';

if (mode === 'config-error') {
  process.stderr.write('Error: Configuration has errors\n\nCaused by:\n    Invalid private key\n');
  process.exit(1);
}

say('INFO', 'onetun::tunnel', `Tunneling TCP [${fwd.split(':').slice(0, 2).join(':')}]->[10.88.0.1:28233] (via [64.95.11.180:51820] as peer 10.88.0.3)`);
if (mode === 'bind-fail' && /:28243:/.test(fwd)) {
  say('ERROR', 'onetun', `Port-forward failed for [${fwd}] : Failed to listen on TCP proxy server`);
}
if (mode !== 'no-handshake') {
  setTimeout(() => say('DEBUG', 'boringtun::noise', 'New session session=1'), 50);
} else {
  setTimeout(() => say('WARN', 'boringtun::noise::timers', 'HANDSHAKE(REKEY_TIMEOUT)'), 50);
}
if (mode === 'exit-soon') setTimeout(() => process.exit(3), 400);
setInterval(() => {}, 1000);
