// Photograph the two states the long walk cannot reach.
//
// capture-packaged.mjs walks a FRESH install from the welcome screen to a
// mining node. Two of the things this release fixes are invisible on that
// path, so they are photographed here, from the same packaged build:
//
//   "stray"  a profile carrying the exact leftovers that used to suppress the
//            first-run wizard - a consent flag and a payout address from an
//            earlier build. The wizard must appear anyway. This is the owner's
//            machine, reproduced.
//
//   "done"   a profile that finished setup, with the node STOPPED. This is
//            where "Start mining can not be clicked" happened: the Mining page
//            must offer an enabled button that does the next useful thing, and
//            pasting an address into Settings with no node running must be
//            accepted and explained rather than blamed.
//
//   node scripts/capture-profiles.mjs <unpacked dir> <out dir>
//
// Same rules as the long walk: no window on anybody's desktop
// (SWARM_NODE_HEADLESS=1, never shown, photographed through a screencast), a
// throwaway data folder, the product's folder never touched, nothing left
// running.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocket } from './ws-min.mjs';
import { startShots } from './cdp-shot.mjs';
import { stopApp } from './stop-app.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const unpacked = process.argv[2] || path.join(ROOT, 'release', 'win-unpacked');
const outDir = process.argv[3] || 'C:/Users/o5o-o/swarm-work/ws-e/_review/packaged-profiles';
/**
 * A port nothing is using, asked for at the moment it is needed.
 *
 * Fixed offsets are a guess about the rest of the machine, and the guess was
 * wrong: the second profile died with "bind() returned an error ... Only one
 * usage of each socket address", which the app reports as no debuggable page
 * at all. Ask the operating system instead.
 */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// Windows, Linux and macOS each put it somewhere different; see app-path.mjs.
const exe = resolveAppExe(unpacked);
if (!exe) process.exit(2);
fs.mkdirSync(outDir, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const problems = [];
const seen = new Map();

// The leftovers, exactly as an abandoned run of an earlier build leaves them.
const STRAY = {
  schema: 1,
  consented: true,
  consentedAt: '2026-09-21T10:00:00.000Z',
  payoutAddress: 't2Li46A4YNFqRDvdKA212w7DtsLkbGMG2xU',
  payoutKind: 'transparent',
  payoutDetail: 'Transparent address. Rewards paid to it are visible on the explorer.',
  setupStep: 'dashboard'
};
const DONE = {
  ...STRAY,
  setupCompletedVersion: '0.2.0-testnet.2',
  setupCompletedAt: '2026-09-21T10:05:00.000Z',
  tourSeenVersion: '0.2.0-testnet.2'
};

function httpJson(port, p) {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { host: '127.0.0.1', port, path: p, headers: { Host: `127.0.0.1:${port}` }, timeout: 4000 },
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

function kill(child) {
  if (!child || !child.pid) return;
  try {
    if (process.platform === 'win32') execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(child.pid, 'SIGKILL');
  } catch { /* already gone */ }
}

/**
 * Run the packaged app against a seeded profile and let `walk` drive it.
 * @param {string} name      profile name, used in file names
 * @param {object|null} seed settings.json to write before launching
 * @param {function} walk    async (tools) => void
 */
async function withProfile(name, seed, walk) {
  const port = await freePort();
  console.log(`\n=== profile "${name}" ===`);
  const dataDir = path.join(os.tmpdir(), `swarm-node-shots-${name}-${Date.now()}`);
  fs.mkdirSync(dataDir, { recursive: true });
  if (seed) fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify(seed, null, 2));

  const child = spawn(exe, [`--remote-debugging-port=${port}`], {
    env: { ...process.env, SWARM_NODE_DATA_DIR: dataDir, SWARM_NODE_TEST_RUN: '1', SWARM_NODE_HEADLESS: '1' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const appOut = [];
  child.stdout.on('data', (d) => appOut.push(String(d)));
  child.stderr.on('data', (d) => appOut.push(String(d)));

  let cdp = null;
  try {
    const until = Date.now() + 60000;
    let page = null;
    while (Date.now() < until && !page) {
      try {
        const list = await httpJson(port, '/json/list');
        page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl) || null;
      } catch { /* not up yet */ }
      if (!page) await sleep(500);
    }
    if (!page) {
      // Say WHY, rather than leaving a bare "never opened". The app prints its
      // data folder and any start-up refusal to stdout.
      console.error(`  --- the app's own output, profile "${name}" ---`);
      for (const l of appOut.join('').split('\n').filter(Boolean).slice(-20)) console.error(`    ${l}`);
      throw new Error(`the app never opened a debuggable page on port ${port}`);
    }

    cdp = new WebSocket(page.webSocketDebuggerUrl);
    await cdp.open(15000);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    const shots = await startShots(cdp);

    const evaluate = async (expression) => {
      const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
      return r.result.value;
    };

    const waitFor = async (pattern, ms, what) => {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        let hit = false;
        try { hit = await evaluate(`${pattern}.test(document.body.innerText || '')`); } catch { /* mid-render */ }
        if (hit) { await sleep(700); return true; }
        await sleep(400);
      }
      console.log(`  (gave up waiting for ${what})`);
      return false;
    };

    let n = 0;
    const step = async (label) => {
      n += 1;
      // Picture first, then text, so the two describe the same instant.
      const buf = await shots.take();
      let text = '';
      try { text = await evaluate("(document.body.innerText || '').replace(/\\s+/g, ' ').trim()"); } catch { /* mid-render */ }
      const file = `${name}-${String(n).padStart(2, '0')}-${label}.png`;
      fs.writeFileSync(path.join(outDir, file), buf);
      const md5 = crypto.createHash('md5').update(buf).digest('hex');
      const prior = seen.get(md5);
      if (prior) {
        const same = prior.at === text;
        console.log(`  ${file}  *** IDENTICAL to ${prior.name} ***${same ? ' (same screen)' : ''}`);
        if (!same) problems.push(`${file} == ${prior.name}, but the page had changed`);
      } else {
        seen.set(md5, { name: file, at: text });
        console.log(`  ${file}  (${(buf.length / 1024).toFixed(0)} KB, md5 ${md5.slice(0, 8)})`);
      }
    };

    const click = async (text) => evaluate(`(() => {
      const wanted = ${JSON.stringify(text)}.toLowerCase();
      const hit = [...document.querySelectorAll('button')]
        .find((e) => (e.textContent || '').toLowerCase().includes(wanted) && !e.disabled);
      if (!hit) return false;
      hit.click();
      return true;
    })()`);

    const tab = async (label) => evaluate(`(() => {
      const hit = [...document.querySelectorAll('.nav-item')]
        .find((e) => (e.textContent || '').trim().toLowerCase().startsWith(${JSON.stringify(label.toLowerCase())}));
      if (!hit) return false;
      hit.click();
      return true;
    })()`);

    const windowLine = (appOut.join('').split('\n').find((l) => l.includes('[window]')) || '(not printed)').trim();
    console.log(`  ${windowLine}`);
    if (!/headless=true isVisible=false/.test(windowLine)) {
      problems.push(`profile "${name}": the window was NOT hidden (${windowLine})`);
    }

    await walk({ step, click, tab, evaluate, waitFor, sleep });
    await shots.stop();
  } finally {
    // Ask the app to close first, so the node it started is stopped by the
    // product's own shutdown rather than orphaned. See stop-app.mjs.
    await stopApp(child, cdp, dataDir);
    try { cdp?.close?.(); } catch { /* closing a dead socket is fine */ }
    // Electron takes a moment to release its debugging port. Starting the
    // next profile too soon left the next launch with no debuggable page.
    await sleep(4000);
    for (let i = 0; i < 4; i += 1) {
      try { fs.rmSync(dataDir, { recursive: true, force: true }); break; } catch { await sleep(1200); }
    }
  }
}

console.log(`app : ${exe}`);
console.log(`out : ${outDir}`);

try {
  // ---- stray: the wizard must still run -------------------------------
  await withProfile('stray', STRAY, async ({ step, waitFor }) => {
    const wizard = await waitFor('/Run a piece of the swarm/i', 30000, 'the welcome screen');
    if (!wizard) problems.push('profile "stray": the first-run wizard did NOT appear');
    await step('wizard-runs-despite-leftover-consent-and-address');
  });

  // ---- done: setup finished, node stopped ------------------------------
  await withProfile('done', DONE, async ({ step, click, tab, evaluate, waitFor, sleep: nap }) => {
    await waitFor('/This machine/i', 30000, 'the dashboard');
    await step('mining-node-stopped-primary-button-enabled');

    // The one click. With no node running the primary starts the node.
    const label = await evaluate(`(() => {
      const b = document.querySelector('.card.glow .btn.big');
      return b ? JSON.stringify({ label: (b.innerText || '').trim(), disabled: !!b.disabled }) : 'null';
    })()`);
    console.log(`  primary button: ${label}`);
    if (/"disabled":true/.test(String(label))) problems.push('profile "done": the primary button was disabled');

    if (await click('start your node')) {
      await waitFor('/starting|Start mining|catching up|peers/i', 30000, 'the node to come up');
      await nap(3000);
      await step('mining-one-click-started-the-node');
    } else {
      problems.push('profile "done": "Start your node" could not be clicked');
    }

    // The map, with the seed figure and the opt-in line.
    if (await tab('swarm map')) {
      await waitFor('/NODE|LOADING|NO DATA/i', 30000, 'the map');
      await nap(3000);
      await step('swarm-map-seed-peers-and-opt-in-line');
    }
    if (await tab('log')) { await nap(2500); await step('log-lines-tagged-node-miner-app'); }
    if (await tab('settings')) { await nap(1200); await step('settings-show-me-around'); }
  });

  // ---- done, node never started: the address is accepted, not blamed ---
  await withProfile('address', { ...DONE, payoutAddress: '', payoutKind: null, payoutDetail: '' },
    async ({ step, tab, evaluate, waitFor, sleep: nap }) => {
      await waitFor('/This machine/i', 30000, 'the dashboard');
      await tab('settings');
      await nap(900);
      // Paste the owner's own address - a real, public testnet receive address
      // from the SWARM Wallet - with the node stopped. This is the exact case
      // that produced "The node does not recognise that address".
      const typed = await evaluate(`(() => {
        const input = document.querySelector('input[type=text]');
        if (!input) return false;
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(input, 'utest1ve9q2phl7hgu95nxg96d75v5hltu7wh4u2kpcz0t7dm2x7x8tns7hecem8m67e9uzruj2py7tu0s4sa5m59qcgw7936n3su40s9hrefr');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()`);
      if (!typed) problems.push('profile "address": no address field on the Settings page');
      await nap(600);
      await step('settings-address-pasted-node-stopped');

      const saved = await evaluate(`(() => {
        const b = [...document.querySelectorAll('button')].find((e) => /^save$/i.test((e.textContent || '').trim()) && !e.disabled);
        if (!b) return false;
        b.click();
        return true;
      })()`);
      if (!saved) problems.push('profile "address": Save was not available');
      await waitFor('/not checked yet|Start the node to confirm/i', 15000, 'the honest not-confirmed notice');
      await nap(700);
      await step('settings-address-accepted-not-confirmed-yet');

      const blamed = await evaluate("/does not recognise that address/i.test(document.body.innerText || '')");
      if (blamed) problems.push('profile "address": a valid address was blamed while the node was stopped');
    });

  const files = fs.readdirSync(outDir).filter((f) => f.endsWith('.png')).sort();
  console.log(`\n${files.length} screen(s) captured:`);
  for (const f of files) console.log(`  ${f}  ${(fs.statSync(path.join(outDir, f)).size / 1024).toFixed(0)} KB`);

  if (problems.length) {
    console.error(`\n${problems.length} problem(s):`);
    for (const p of problems) console.error(`  ${p}`);
    process.exit(1);
  }
  console.log('\nall profile checks passed');
  process.exit(0);
} catch (e) {
  console.error(`\nfailed: ${e && e.stack ? e.stack : e}`);
  process.exit(1);
}
