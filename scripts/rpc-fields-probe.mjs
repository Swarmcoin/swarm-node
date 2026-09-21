// What does this Zebra actually tell us about where the chain is?
//
// The sync gate needs an honest "am I behind the network" signal. Zebra's
// estimatedheight is a wall-clock extrapolation and is useless on a young
// chain (proved on 2026-09-21: a fresh node reported ~1994 blocks missing).
// This probe dumps the fields that might carry a PEER-derived answer, against
// whatever node is already running, so the gate can be built on a real field
// instead of a guess.
//
//   node scripts/rpc-fields-probe.mjs <rpc-port> <cookie-dir>

import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { ZebraRpc } = require(path.join(ROOT, 'electron/chain/rpc.js'));

const port = Number(process.argv[2]);
const dir = process.argv[3];
if (!port || !dir) { console.error('usage: rpc-fields-probe.mjs <rpc-port> <cookie-dir>'); process.exit(2); }

const rpc = new ZebraRpc({ host: '127.0.0.1', port, cookieDir: dir });

async function show(label, fn) {
  try {
    const r = await fn();
    console.log(`\n--- ${label} ---`);
    console.log(JSON.stringify(r, null, 2).slice(0, 2500));
  } catch (e) {
    console.log(`\n--- ${label} --- ERROR ${e.message}`);
  }
}

await show('getblockchaininfo', () => rpc.getBlockchainInfo());
await show('getpeerinfo', () => rpc.getPeerInfo());
await show('getmininginfo', () => rpc.getMiningInfo());
await show('getinfo', () => rpc.getInfo());
await show('getnetworksolps', () => rpc.getNetworkSolps());
