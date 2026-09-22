// Capture every screen of the real app, for review.
//
// It runs the actual Electron app with the actual renderer and engine, walks
// it through each screen and writes a PNG of each one. Nothing in the UI is
// mocked: the numbers are whatever the engine really reports.
//
//   node scripts/capture-screens.mjs [outDir]
//
// Environment:
//   SWARM_SHOT_DIR      where the PNGs go
//   SWARM_NODE_BIN_DIR  where zebrad.exe and privacy-miner.exe live
//   SWARM_SHOT_PORTS    "p2p,rpc" loopback ports for the harness node
//
// THE WINDOW SAYS IT IS A TEST. The owner once found a harness window, took it
// for the product and tried to mine with it. Every window this script opens is
// titled "TEST RUN - do not use", and the script closes it when it is done.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = process.argv[2] || process.env.SWARM_SHOT_DIR || 'C:/Users/o5o-o/swarm-work/ws-e/_review';
fs.mkdirSync(outDir, { recursive: true });

const electron = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
if (!fs.existsSync(electron)) {
  console.error(`electron not found at ${electron}; run npm install first`);
  process.exit(2);
}

console.log(`capturing into ${outDir}`);
const child = spawn(electron, ['.'], {
  cwd: ROOT,
  env: { ...process.env, SWARM_NODE_SHOTS: outDir },
  stdio: 'inherit'
});

const hardStop = setTimeout(() => {
  console.error('capture took too long; stopping the harness');
  try { child.kill(); } catch { /* already gone */ }
}, 15 * 60 * 1000);

child.on('exit', (code) => {
  clearTimeout(hardStop);
  const shots = fs.existsSync(outDir) ? fs.readdirSync(outDir).filter((f) => f.endsWith('.png')) : [];
  console.log(`\n${shots.length} screen(s) captured:`);
  for (const s of shots.sort()) {
    const { size } = fs.statSync(path.join(outDir, s));
    console.log(`  ${s}  ${(size / 1024).toFixed(0)} KB`);
  }
  process.exit(code === 0 && shots.length ? 0 : 1);
});
