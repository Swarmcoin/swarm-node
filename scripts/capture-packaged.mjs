// Photograph the PACKAGED build — the exact app a person would install.
//
// It drives the real thing from outside over the DevTools protocol, clicking
// the buttons a person clicks.
//
//   node scripts/capture-packaged.mjs <unpacked dir> <out dir>
//
// Rules, each of them learned the hard way:
//
//   * WAIT FOR THE DOM, NEVER A TIMER. Timers produced three byte-identical
//     files named after three different screens, because the walk moved on
//     before the window had drawn the state it was about to photograph. Every
//     step now waits for the text it expects, then for two animation frames.
//   * NAME FILES AFTER WHAT THEY SHOW. Each file carries both the state the
//     walk believes it captured and the page title the DOM actually reports,
//     so a mismatch is visible in the file listing instead of hidden in it.
//   * NEVER THE PRODUCT'S DATA FOLDER. A throwaway directory through
//     SWARM_NODE_DATA_DIR, deleted afterwards. The product's folder is never
//     read, written or removed.
//   * THE WINDOW SAYS IT IS A TEST. SWARM_NODE_TEST_RUN=1 puts a red
//     "TEST RUN — DO NOT USE" banner above every screen. Parking it off-screen
//     was tried and makes capture impossible: a window with no compositor
//     surface produces no frame at all.
//   * LEAVE NOTHING RUNNING.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocket } from './ws-min.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const unpacked = process.argv[2] || path.join(ROOT, 'release', 'win-unpacked');
const outDir = process.argv[3] || 'C:/Users/o5o-o/swarm-work/ws-e/_review/packaged';
const dataDir = process.env.SWARM_HARNESS_DIR
  || path.join('C:/Users/o5o-o/swarm-work/ws-e/_harness', String(Date.now()));
const PORT = Number(process.env.SWARM_CDP_PORT) || 9333;

const exe = path.join(unpacked, 'SWARM Node.exe');
if (!fs.existsSync(exe)) { console.error(`not found: ${exe}`); process.exit(2); }
fs.mkdirSync(outDir, { recursive: true });
fs.mkdirSync(dataDir, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const duplicates = [];

console.log(`app      : ${exe}`);
console.log(`data dir : ${dataDir}   (throwaway, deleted afterwards)`);
console.log(`out      : ${outDir}\n`);

const child = spawn(exe, [`--remote-debugging-port=${PORT}`], {
  env: { ...process.env, SWARM_NODE_DATA_DIR: dataDir, SWARM_NODE_TEST_RUN: '1' },
  stdio: ['ignore', 'pipe', 'pipe']
});
child.stdout.on('data', (d) => process.stdout.write(`  app: ${d}`));
child.stderr.on('data', (d) => process.stdout.write(`  app: ${d}`));

function httpJson(p) {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { host: '127.0.0.1', port: PORT, path: p, headers: { Host: `127.0.0.1:${PORT}` }, timeout: 4000 },
      (res) => {
        const c = [];
        res.on('data', (x) => c.push(x));
        res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(c).toString())); } catch (e) { reject(e); } });
      }
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

let cleanedUp = false;
async function cleanup(code) {
  if (cleanedUp) return;
  cleanedUp = true;
  try {
    if (process.platform === 'win32' && child.pid) execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else child.kill();
  } catch { /* already gone */ }
  await sleep(3000);
  for (let i = 0; i < 5; i += 1) {
    try { fs.rmSync(dataDir, { recursive: true, force: true }); break; }
    catch { await sleep(1500); }
  }
  console.log(fs.existsSync(dataDir) ? `\ncould not remove ${dataDir}` : `\nremoved the throwaway data dir ${dataDir}`);

  // The product's own folder is NEVER deleted here: this harness does not own
  // it, and somebody may be using the app right now.
  const productDir = path.join(os.homedir(), 'AppData', 'Roaming', 'green.swarm.node');
  if (fs.existsSync(productDir)) {
    console.log(`(the product folder ${productDir} exists and was left alone)`);
  }

  const shots = fs.existsSync(outDir) ? fs.readdirSync(outDir).filter((f) => f.endsWith('.png')) : [];
  console.log(`\n${shots.length} screen(s) captured:`);
  for (const s of shots.sort()) console.log(`  ${s}  ${(fs.statSync(path.join(outDir, s)).size / 1024).toFixed(0)} KB`);
  process.exit(code);
}
process.on('SIGINT', () => cleanup(1));

const hardStop = setTimeout(() => { console.error('\nHARD DEADLINE'); cleanup(1); }, 20 * 60 * 1000);
hardStop.unref?.();

let cdp;
try {
  const until = Date.now() + 90000;
  let page = null;
  while (Date.now() < until && !page) {
    try {
      const list = await httpJson('/json/list');
      page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl) || null;
    } catch { /* not up yet */ }
    if (!page) await sleep(500);
  }
  if (!page) throw new Error('the app never opened a debuggable page');
  console.log(`  target: ${page.webSocketDebuggerUrl}`);

  cdp = new WebSocket(page.webSocketDebuggerUrl);
  await cdp.open(15000);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  const evaluate = async (expression) => {
    const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
    return r.result.value;
  };

  const seen = new Map();
  const shotRaw = async (name) => {
    try { await cdp.send('Page.bringToFront'); } catch { /* not fatal */ }
    await sleep(400);
    const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const buf = Buffer.from(r.data, 'base64');
    const md5 = crypto.createHash('md5').update(buf).digest('hex');
    fs.writeFileSync(path.join(outDir, `${name}.png`), buf);
    if (seen.has(md5)) {
      console.log(`  ${name}.png  *** IDENTICAL to ${seen.get(md5)} ***`);
      duplicates.push(`${name} == ${seen.get(md5)}`);
    } else {
      seen.set(md5, name);
      console.log(`  ${name}.png  (${(buf.length / 1024).toFixed(0)} KB, md5 ${md5.slice(0, 8)})`);
    }
  };

  /** Wait for the DOM to say it, then for the paint to catch up. */
  const waitFor = async (pattern, ms, what) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      let hit = false;
      try { hit = await evaluate(`${pattern}.test(document.body.innerText || '')`); } catch { /* mid-navigation */ }
      if (hit) {
        try { await evaluate('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))'); } catch { /* fine */ }
        await sleep(800);
        return true;
      }
      await sleep(600);
    }
    console.log(`  (gave up waiting for ${what})`);
    return false;
  };

  /** What the app itself calls the screen that is showing. */
  const pageName = async () => {
    let t = '';
    try {
      t = await evaluate(`(() => {
        const h = document.querySelector('.topbar h1') || document.querySelector('h1');
        return (h && h.textContent || '').trim();
      })()`);
    } catch { /* fall through */ }
    return String(t || 'screen').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'screen';
  };

  let n = 0;
  const step = async (state) => {
    n += 1;
    await shotRaw(`${String(n).padStart(2, '0')}-${state}--shows-${await pageName()}`);
  };

  const click = async (text) => evaluate(`(() => {
    const wanted = ${JSON.stringify(text)}.toLowerCase();
    const hit = [...document.querySelectorAll('button')]
      .find((e) => (e.textContent || '').toLowerCase().includes(wanted) && !e.disabled);
    if (!hit) return false;
    hit.click();
    return true;
  })()`);

  const type = async (text) => evaluate(`(() => {
    const input = document.querySelector('input[type=text]');
    if (!input) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(text)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);

  const tab = async (label) => {
    const ok = await evaluate(`(() => {
      const hit = [...document.querySelectorAll('.nav-item')]
        .find((e) => (e.textContent || '').trim().toLowerCase().startsWith(${JSON.stringify(label.toLowerCase())}));
      if (!hit) return false;
      hit.click();
      return true;
    })()`);
    if (!ok) { console.log(`  (no tab "${label}")`); return false; }
    await sleep(1200);
    try { await evaluate('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))'); } catch { /* fine */ }
    await sleep(800);
    return true;
  };

  console.log('\nwalking the app:');
  await waitFor('/Run a piece of the swarm/i', 30000, 'the welcome screen');
  await step('welcome');

  await click('get started');
  await waitFor('/Exactly what will run/i', 15000, 'the consent screen');
  await step('consent');

  await evaluate(`(() => {
    const boxes = [...document.querySelectorAll('.consent-list input[type=checkbox]')];
    boxes.forEach((b) => { if (!b.checked) b.click(); });
    return boxes.length;
  })()`);
  await sleep(1000);
  await step('consent-all-ticked');

  await click('i agree');
  await waitFor('/Where should your honey go/i', 15000, 'the payout screen');
  await step('payout-empty');

  await type('u1thisisamainnetaddressnotatestnetone0234567');
  await waitFor('/mainnet unified address/i', 10000, 'the offline format complaint');
  await step('payout-format-rejected-offline');

  // The project's baseline-miner address, not Zebra's default test one.
  //
  // An earlier capture mined 12 blocks to tmJymvcUCn1ctbghvTJpXBwHiMEB8P6wxNV
  // — Zebra's documented default, whose key nobody holds — so 60 SWM went
  // somewhere nobody can spend and the server agent saw an unattributable
  // "third miner". A harness that mines on the live chain pays the project.
  const PAYOUT = process.env.SWARM_HARNESS_PAYOUT || 't2Li46A4YNFqRDvdKA212w7DtsLkbGMG2xU';
  await type(PAYOUT);
  await waitFor('/Looks right/i', 10000, 'the offline format verdict');
  await step('payout-format-ok-node-not-asked-yet');

  if (await click('start node')) console.log('  started the node from the payout step');
  await waitFor('/Waiting for your node to double-check/i', 40000, 'the node check to begin');
  await step('payout-waiting-for-node');

  console.log(`  node confirmed the address: ${await waitFor('/checked by your node/i', 180000, 'the node to confirm the address')}`);
  await step('payout-confirmed-by-node');

  await click('continue');
  await waitFor('/Can this computer run a node/i', 20000, 'the machine check');
  await waitFor('/Processor/i', 30000, 'the machine check results');
  await step('machine-check');

  await click('go to my node');
  await waitFor('/This machine/i', 20000, 'the dashboard');

  // The guided tour starts by itself at the end of the wizard, so this is
  // where a new user meets it. Five steps, each moving the app to the page it
  // describes; photograph every one of them.
  const inTour = await waitFor('/Step 1 of 5/i', 15000, 'the guided tour to open');
  console.log(`  guided tour opened by itself: ${inTour}`);
  if (inTour) {
    for (let i = 1; i <= 5; i += 1) {
      await sleep(900);
      await step(`tour-step-${i}-of-5`);
      if (i < 5) {
        if (!(await click('next'))) { console.log('  (the tour has no Next button)'); break; }
        await waitFor(`/Step ${i + 1} of 5/i`, 10000, `tour step ${i + 1}`);
      }
    }
    if (await click('start using swarm node')) console.log('  finished the tour');
    await sleep(1200);
    // The tour leaves the app on the last page it described.
    await tab('mining');
  }
  await step('mining-before-start');

  // A REAL height in the gate line, not a dash.
  console.log(`  gate line has live numbers: ${await waitFor('/your node:\\s*#\\d/', 300000, 'the gate line to show a real height')}`);
  await step('mining-gate-with-live-numbers');

  const ready = await waitFor('/Ready when you are/i', 300000, 'the gate to open');
  console.log(`  mining allowed: ${ready}`);
  if (ready && (await click('start mining'))) {
    await waitFor('/Stop mining/i', 40000, 'mining to start');
    await sleep(5000);
    await step('mining-after-start');
  } else {
    await step('mining-still-held-back');
  }

  if (await tab('node')) await step('node-page-folder-and-pids');
  if (await tab('honey')) await step('honey');
  if (await tab('swarm map')) { await waitFor('/NODE|LOADING|NO DATA/i', 30000, 'the map'); await sleep(3500); await step('swarm-map'); }
  if (await tab('settings')) {
    await step('settings');
    await evaluate("(document.querySelector('.content') || {}).scrollTop = 99999");
    await sleep(1500);
    await step('settings-about-and-official-channels');
  }
  if (await tab('log')) { await sleep(3000); await step('log'); }
  if (await tab('mining')) { await sleep(6000); await step('mining-at-the-end'); }
  if (await tab('honey')) { await sleep(3000); await step('honey-at-the-end'); }

  if (duplicates.length) {
    console.error(`\n${duplicates.length} screenshot(s) are identical to another:`);
    for (const d of duplicates) console.error(`  ${d}`);
    await cleanup(1);
  }
  console.log('\ndone — every screenshot is distinct');
  await cleanup(0);
} catch (e) {
  console.error(`\ncapture failed: ${e.message}`);
  if (e.stack) console.error(e.stack.split('\n').slice(0, 3).join('\n'));
  await cleanup(1);
}
