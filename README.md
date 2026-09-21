# SWARM Node

The desktop app for running a full node of the SWARM test network and mining
with one click. Electron + React, Windows first.

It is a repurposing of the owner's earlier MIT-licensed "SWARM Node" app, which
was built for an unrelated AI-compute product. The first commit in this
repository is that app, unchanged, so every change since is a reviewable diff.

For people who want to *use* it, read [RELEASE-NOTES.md](RELEASE-NOTES.md).
This file is for people working on it.

## What it is made of

```
electron/
  main.js            window, IPC surface, security posture, shutdown
  preload.js         the only thing the renderer can reach
  ipc-validate.js    every IPC argument, validated before the engine sees it
  config-store.js    persisted settings: consent, payout ADDRESS, preferences
  net/
    network.json     THE definition of which chain this build joins
    binaries.json    SHA-256 of the binaries this build may run
  chain/
    engine.js        owns everything, pushes one state object per second
    zebrad.js        the node process
    miner.js         N privacy-miner processes, one core each
    spawn-console.js starting console children so they can be stopped again
    graceful-stop.js Ctrl-C, Ctrl-C again, and only then a hard kill
    config-gen.js    the zebrad TOML
    rpc.js           loopback JSON-RPC with fresh cookie auth
    sync-gate.js     when mining is allowed
    rewards.js       what a found block actually paid
    address.js       address validation, delegated to the node
    hardware.js      the local machine check
    binaries.js      hash verification
  resources/         the two PowerShell helpers (see below)
src/                 the React UI
test/                unit tests
scripts/             build, lint and the integration checks
```

## Pointing a build at another network

`electron/net/network.json` is the only file that decides. Regenerate it from
the canonical manifest:

```sh
node scripts/embed-network.mjs D:/privacy/network/swarm-testnet
```

It copies the manifest verbatim and adds the genesis bytes, the sync-gate
thresholds and the official links, so `diff` against the canonical file shows
exactly what a build carries. It refuses to run if the genesis hash is missing,
the `genesis.hex` checksum disagrees with the manifest, the network is not a
Testnet, or a funding-stream recipient is not a P2SH address.

`test/renderer-parity.test.js` then checks that the `[network.testnet_parameters]`
block this app generates is **byte for byte** what `scripts/swarm/render_config.py`
generates for the seed server. A node that disagrees about any of those values
is not slightly wrong, it is on a different chain.

## Three Windows facts this app is built around

All three were measured on a real machine, and all three are non-obvious enough
to be worth writing down.

**1. zebrad only stops on a console Ctrl-C.** It listens with
`tokio::signal::ctrl_c` and has no SIGTERM equivalent and no service control
handler. Node's `child.kill()` is `TerminateProcess`, which is a hard kill that
leaves the RocksDB state to be recovered; `taskkill` without `/F` does nothing
to a console app with no window. So stopping goes through
`electron/resources/swarm-stop.ps1`, which attaches to the child's console and
generates the event.

**2. Ctrl-C handling is inherited.** It is a per-process flag, set at creation.
A parent that called `SetConsoleCtrlHandler(NULL, TRUE)` passes "ignore Ctrl-C"
down the entire tree, and the node then cannot be stopped gracefully by anyone.
Measured: 0 of 3 clean stops when launched from an MSYS2 bash, 3 of 3 from a
normal console, same code. `electron/resources/swarm-start.ps1` therefore
re-enables it explicitly before starting the child, so behaviour no longer
depends on what launched the app. Measured after the fix: **12 of 12 graceful
stops, 668–857 ms, no hard kills, no orphaned processes.**

**3. Zebra cannot tell you how high the chain is.** `getpeerinfo` carries no
peer height, and `getblockchaininfo.estimatedheight` only *looks* like the
answer: `zebra-chain/src/chain_tip.rs` extrapolates it from this node's own tip
block time and the target spacing, so it is tip age in different units. On a
chain created minutes ago with a genesis timestamped 1.7 days earlier it
reported ~1994 blocks missing, which would have blocked a healthy node from
mining for ever. The sync gate therefore uses what is actually observed: peer
count, tip age, and whether blocks are still arriving in a burst.

## Working on it

```sh
npm install
npm run lint         # parses everything, and fails on what must not come back
npm test             # 59 unit checks
npm start            # build the renderer and run the app

# needs a real zebrad.exe; set SWARM_NODE_BIN_DIR if it is not in resources/bin
node scripts/stop-cycles.mjs 12 --wait-rpc      # graceful-stop reliability
node scripts/integration-headless.mjs           # full engine run, throwaway net
node scripts/live-network-check.mjs             # what a new machine experiences
```

`npm run lint` is a repo guard rather than a style checker. It fails on
`api.swarm.green`, `ethers`, `electron-updater`, the `swarm-downloads` release
feed, `nodeIntegration`, a disabled sandbox, a shell string passed to `exec`,
an invented `swm1…` address, mining-pool vocabulary, `MH/s`, or a per-day
earnings estimate — and it checks that every IPC channel the preload calls has
a handler.

`scripts/integration-headless.mjs` runs the engine against a throwaway network
and refuses to start unless that network really is throwaway: its own name and
magic, no seed peers, and loopback ports outside every block in use on this
machine.

## Rules this app keeps

* No consensus or cryptographic code. Addresses are validated by asking the
  node; block validity is the node's business.
* No key, seed, passphrase or password exists anywhere in it. The only thing
  stored about a person is a payout address, which is public.
* Nothing runs hidden. Closing the window stops the node and the miners, and
  waits for them.
* No invented numbers. Anything unknown is "—", never zero and never an estimate.
* The renderer reaches nothing directly: `contextIsolation`, no
  `nodeIntegration`, `sandbox`, a CSP with no remote origin at all, navigation
  blocked, every IPC argument validated in the main process, and every child
  process spawned with an argument array.

## Releases

CI builds the installer, the portable zip, `SHA256SUMS` and
`release-manifest.json` and uploads them as workflow artifacts. It does **not**
publish a GitHub Release, and auto-update is removed rather than disabled —
see [docs/RELEASES.md](docs/RELEASES.md) for the switch a future release
channel would need.

Licence: MIT, inherited from the app this one started as.
