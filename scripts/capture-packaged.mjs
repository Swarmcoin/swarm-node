// Photograph the PACKAGED build — the exact .exe a person would install.
//
// The packaged app cannot be asked to walk its own screens: the review hook
// that does that was written after the package was built, and adding it would
// mean photographing a different binary from the one being reviewed. So this
// drives the real thing from outside, over the DevTools protocol, by clicking
// the same buttons a person clicks.
//
//   node scripts/capture-packaged.mjs <unpacked dir> <out dir>
//
// It runs with a THROWAWAY data directory, so the real install's folder is
// never touched, and it deletes that directory when it is done. The window is
// titled "TEST RUN" by the app itself when SWARM_NODE_TEST_RUN=1.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { WebSocket } from './ws-min.mjs';

const unpacked = process.argv[2] || 'C:/Users/o5o-o/swarm-work/artifacts/swarm-node-0.2.0-testnet.1/unpacked';
const outDir = process.argv[3] || 'C:/Users/o5o-o/swarm-work/ws-e/_review/0.2.0-testnet.1';
const dataDir = process.env.SWARM_HARNESS_DIR || path.join('C:/Users/o5o-o/swarm-work/ws-e/_harness', String(Date.now()));
const PORT = Number(process.env.SWARM_CDP_PORT) || 9333;

const exe = path.join(unpacked, 'SWARM Node.exe');
if (!fs.existsSync(exe)) { console.error(`not found: ${exe}`); process.exit(2); }
fs.mkdirSync(outDir, { recursive: true });
fs.mkdirSync(dataDir, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log(`app      : ${exe}`);
console.log(`data dir : ${dataDir}   (throwaway, deleted afterwards)`);
console.log(`out      : ${outDir}\n`);

const child = spawn(exe, [`--remote-debugging-port=${PORT}`], {
  env: {
    ...process.env,
    // Builds from 0.2.0-testnet.2 onwards honour this and keep entirely out
    // of the product's folder. Older packages ignore it and use
    // %APPDATA%\green.swarm.node; do not run this against one while anybody
    // is using the app.
    SWARM_NODE_DATA_DIR: dataDir,
    SWARM_NODE_TEST_RUN: '1'
  },
  stdio: ['ignore', 'pipe', 'pipe']
});
child.stdout.on('data', (d) => process.stdout.write(`  app: ${d}`));
child.stderr.on('data', (d) => process.stdout.write(`  app: ${d}`));

function httpJson(p) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: PORT, path: p, headers: { Host: `127.0.0.1:${PORT}` } }, (res) => {
      const c = [];
      res.on('data', (x) => c.push(x));
      res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(c).toString())); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

async function waitForTarget(timeoutMs = 90000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const list = await httpJson('/json/list');
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) { console.log(`  target: ${page.webSocketDebuggerUrl}`); return page; }
      console.log(`  /json/list has ${list.length} target(s): ${list.map((t) => t.type).join(', ')}`);
    } catch { /* not listening yet */ }
    await sleep(500);
  }
  throw new Error('the app never opened a debuggable page');
}

let cleanedUp = false;
async function cleanup(code) {
  if (cleanedUp) return;
  cleanedUp = true;
  try { child.kill(); } catch { /* already gone */ }
  await sleep(2500);
  // Leave nothing running and nothing on disk.
  try { fs.rmSync(dataDir, { recursive: true, force: true }); console.log(`\nremoved the throwaway data dir ${dataDir}`); }
  catch (e) { console.error(`could not remove ${dataDir}: ${e.message}`); }

  // The product's own folder is NEVER deleted here. An earlier version of this
  // script removed it when a build ignored the override, which was fine while
  // nobody used the app and became dangerous the moment the owner did: a
  // harness must not delete a folder it does not own. It warns instead, and
  // the override below is what keeps runs out of that folder in the first
  // place.
  const productDir = path.join(os.homedir(), 'AppData', 'Roaming', 'green.swarm.node');
  if (fs.existsSync(productDir)) {
    console.error(`
WARNING: ${productDir} exists. If THIS run created it, the build ignored`);
    console.error('  SWARM_NODE_DATA_DIR. Check it by hand — nothing here will delete it.');
  }

  const shots = fs.readdirSync(outDir).filter((f) => f.endsWith('.png'));
  console.log(`${shots.length} screen(s) captured:`);
  for (const s of shots.sort()) console.log(`  ${s}  ${(fs.statSync(path.join(outDir, s)).size / 1024).toFixed(0)} KB`);
  process.exit(code);
}
process.on('SIGINT', () => cleanup(1));

let cdp;
try {
  const page = await waitForTarget();
  cdp = new WebSocket(page.webSocketDebuggerUrl);
  await cdp.open(15000);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  /** Run a snippet in the page and return its value. */
  const evaluate = async (expression) => {
    const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception || {}).description);
    return r.result.value;
  };

  const shot = async (name) => {
    const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(outDir, `${name}.png`);
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    console.log(`  captured ${name}.png`);
  };

  /** Click the first element whose visible text matches. */
  const clickText = async (text, tag = 'button') => evaluate(`
    (() => {
      const wanted = ${JSON.stringify(text)}.toLowerCase();
      const els = [...document.querySelectorAll(${JSON.stringify(tag)})];
      const hit = els.find((e) => (e.textContent || '').toLowerCase().includes(wanted) && !e.disabled);
      if (!hit) return false;
      hit.click();
      return true;
    })()
  `);

  await sleep(6000);   // let the first render and the engine's first tick land

  console.log('walking the app:');
  await shot('01-welcome');

  await clickText('get started');
  await sleep(1200);
  await shot('02-consent');

  // Tick every consent box, then show the enabled state before agreeing.
  await evaluate(`
    (() => {
      const boxes = [...document.querySelectorAll('.consent-list input[type=checkbox]')];
      boxes.forEach((b) => { if (!b.checked) b.click(); });
      return boxes.length;
    })()
  `);
  await sleep(700);
  await shot('03-consent-ticked');

  await clickText('i agree');
  await sleep(2500);
  await shot('04-payout-empty');

  // Type an address the way a person would, then let the node check it.
  await evaluate(`
    (() => {
      const input = document.querySelector('input[type=text]');
      if (!input) return false;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, 'tmJymvcUCn1ctbghvTJpXBwHiMEB8P6wxNV');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()
  `);
  await sleep(800);
  await shot('05-payout-typed');

  // No button here any more: the node checks by itself. Photograph the wait,
  // then the confirmation when it lands.
  await sleep(2500);
  await shot('06-payout-waiting-for-node');
  const confirmedBy = Date.now() + 90000;
  while (Date.now() < confirmedBy) {
    const ok = await evaluate("/checked by your node/i.test(document.body.innerText || '')");
    if (ok) break;
    await sleep(2000);
  }
  await shot('07-payout-confirmed-by-node');

  if (!(await clickText('continue'))) console.log('  (Continue was disabled)');
  await sleep(3000);
  await shot('08-machine-check');

  if (!(await clickText('go to my node'))) console.log('  (could not leave the machine check)');
  await sleep(6000);
  await shot('09-mining');

  // The other tabs are nav buttons in the rail.
  const tab = async (label, file, wait = 3000) => {
    const ok = await evaluate(`
      (() => {
        const hit = [...document.querySelectorAll('.nav-item')]
          .find((e) => (e.textContent || '').trim().toLowerCase().startsWith(${JSON.stringify(label.toLowerCase())}));
        if (!hit) return false;
        hit.click();
        return true;
      })()
    `);
    if (!ok) { console.log(`  (no tab "${label}" in this build)`); return false; }
    await sleep(wait);
    await shot(file);
    return true;
  };

  await tab('node', '10-node');
  await tab('honey', '11-honey');
  await tab('swarm map', '12-swarm-map', 9000);
  if (await tab('settings', '13-settings', 3000)) {
    // The About block is at the bottom of Settings.
    await evaluate("(document.querySelector('.content') || {}).scrollTop = 99999");
    await sleep(900);
    await shot('14-settings-about');
  }
  await tab('log', '15-log');
  // Back to Mining for the held-back state with both heights on screen.
  await tab('mining', '16-mining-gate-detail', 4000);

  console.log('\ndone');
  await cleanup(0);
} catch (e) {
  console.error(`\ncapture failed: ${e.message}`);
  await cleanup(1);
}
