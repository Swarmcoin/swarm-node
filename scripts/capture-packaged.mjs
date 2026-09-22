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
import crypto from 'node:crypto';
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

const duplicates = [];
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

  // An occluded or background window stops painting, and captureScreenshot
  // then returns the LAST frame it drew. That is how a previous run produced
  // five byte-identical files covering five different screens. Bringing the
  // target to the front forces a fresh frame; the window is parked off-screen
  // by the app itself when SWARM_NODE_TEST_RUN=1, so nothing appears on the
  // desktop. Every image is hashed, and a repeat is reported rather than
  // quietly written.
  const seen = new Map();
  const shot = async (name) => {
    try { await cdp.send('Page.bringToFront'); } catch { /* not fatal */ }
    await sleep(600);
    const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const buf = Buffer.from(r.data, 'base64');
    const md5 = crypto.createHash('md5').update(buf).digest('hex');
    const file = path.join(outDir, `${name}.png`);
    fs.writeFileSync(file, buf);
    if (seen.has(md5)) {
      console.log(`  captured ${name}.png  *** IDENTICAL to ${seen.get(md5)} — the window did not repaint ***`);
      duplicates.push(`${name} == ${seen.get(md5)}`);
    } else {
      seen.set(md5, name);
      console.log(`  captured ${name}.png  (${(buf.length / 1024).toFixed(0)} KB, md5 ${md5.slice(0, 8)})`);
    }
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

  /** Put text in the first text box the way a person would. */
  const type = async (text) => evaluate(`
    (() => {
      const input = document.querySelector('input[type=text]');
      if (!input) return false;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, ${JSON.stringify(text)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()
  `);

  /** Wait until the page says something, or give up. */
  const waitForText = async (pattern, ms) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      const hit = await evaluate(`${pattern}.test(document.body.innerText || '')`);
      if (hit) return true;
      await sleep(1500);
    }
    return false;
  };

  /** Click a tab in the rail. */
  const tab = async (label, file, wait = 3500) => {
    const ok = await evaluate(`
      (() => {
        const hit = [...document.querySelectorAll('.nav-item')]
          .find((e) => (e.textContent || '').trim().toLowerCase().startsWith(${JSON.stringify(label.toLowerCase())}));
        if (!hit) return false;
        hit.click();
        return true;
      })()
    `);
    if (!ok) { console.log(`  (no tab "${label}")`); return false; }
    await sleep(wait);
    await shot(file);
    return true;
  };

  console.log('walking the app:');
  await shot('01-welcome');

  await clickText('get started');
  await sleep(1200);
  await shot('02-consent');

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

  // A wrong address, so the offline format check is on the record.
  await type('u1thisisamainnetaddressnotatestnetone0234567');
  await sleep(1400);
  await shot('05-payout-format-invalid');

  // And a right one, accepted instantly on shape alone.
  await type('tmJymvcUCn1ctbghvTJpXBwHiMEB8P6wxNV');
  await sleep(1600);
  await shot('06-payout-format-valid-node-not-asked');

  // Start the node from the step itself and let it confirm by itself.
  if (await clickText('start node')) console.log('  started the node from the payout step');
  await sleep(4000);
  await shot('07-payout-node-starting');
  console.log(`  node confirmed the address: ${await waitForText('/checked by your node/i', 120000)}`);
  await sleep(5000);   // the paint lags the DOM; 07 and 08 came out identical without this
  await shot('08-payout-confirmed-by-node');

  if (!(await clickText('continue'))) console.log('  (Continue was disabled)');
  await sleep(3000);
  await shot('09-machine-check');

  if (!(await clickText('go to my node'))) console.log('  (could not leave the machine check)');
  await sleep(8000);
  await shot('10-mining-before-start');

  await tab('node', '11-node-folder-and-pids');
  await tab('honey', '12-honey');
  await tab('swarm map', '13-swarm-map', 12000);
  if (await tab('settings', '14-settings')) {
    await evaluate("(document.querySelector('.content') || {}).scrollTop = 99999");
    await sleep(1000);
    await shot('15-settings-about-and-channels');
  }
  await tab('log', '16-log');

  // Mining with real numbers, and Start if the gate lets us. Either way the
  // screen is the evidence.
  await tab('mining', '17-mining-gate-numbers', 5000);
  console.log(`  mining ready: ${await waitForText('/Ready when you are/i', 45000)}`);
  if (await clickText('start mining')) {
    await sleep(10000);
    await shot('18-mining-after-start');
  } else {
    console.log('  (Start mining was disabled; the held-back screen is the evidence)');
    await shot('18-mining-still-held-back');
  }
  await tab('node', '19-node-while-running', 4000);


  console.log('\ndone');
  await cleanup(0);
} catch (e) {
  console.error(`\ncapture failed: ${e.message}`);
  await cleanup(1);
}
