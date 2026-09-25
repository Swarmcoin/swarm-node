# Network profiles in SWARM Node

Written 2026-09-25, when SWARM gained a second network.

SWARM Node now knows two networks and picks between them explicitly. The whole
mapping lives in one file, `electron/chain/network-profile.js`, as data:

| profile id | `network = ` in `zebrad.toml` | config section | chain label | P2P / RPC | chain folder |
| --- | --- | --- | --- | --- | --- |
| `swarm-testnet` | `"Testnet"` | `[network.testnet_parameters]` | `swarm-testnet` | 18233 / 18232 | `<userData>/chain` |
| `swarm-mainnet` | `"SwarmMainnet"` | `[network.swarm_main]` | `swarm-mainnet` | 28233 / 28232 | `<userData>/chain-mainnet` |

There is no third entry, and **no path renders `network = "Mainnet"`**. The
module refuses to load if a profile ever maps to one of
`Mainnet / mainnet / main / Regtest / regtest`; `generateZebraConfig` refuses a
manifest naming any of them; and the generated text is scanned one last time
before it is returned (`assertNotUpstream`). Three independent checks, because
the cost of being wrong once is a user mining the Zcash main chain with a SWARM
payout address.

## What each profile renders

**`swarm-testnet` is unchanged, byte for byte.** Zebra takes the whole testnet
definition as configuration data, so the app writes the magic, the genesis
hash, the difficulty limit, the halving interval, the funding streams and every
activation height. Two tests hold this still: `test/renderer-parity.test.js`
compares the network block with `D:/privacy/scripts/swarm/render_config.py`'s
output, and `test/mainnet-config-gen.test.js` compares the **whole** generated
file with `test/fixtures/golden-swarm-testnet-zebrad.toml`.

**`swarm-mainnet` renders almost nothing.** On `SwarmMainnet` the definition is
compiled into the node — magic `SWMN`, the `07ff…` difficulty limit, every
upgrade at height 1, the 8/4/8 split, coinbase maturity 100, V5/V6-only — so
none of it appears in the file and none of it can be changed by editing one.
The configuration supplies exactly what the launch ceremony produces:

```toml
[network]
network = "SwarmMainnet"
listen_addr = "0.0.0.0:28233"
initial_mainnet_peers = []
initial_testnet_peers = []
cache_dir = false

[network.swarm_main]
genesis_hash = "<from the ceremony>"
p2p_port = 28233
rpc_port = 28232

[network.swarm_main.funding_stream_addresses]
core_development = "s3..."
grants_ecosystem = "s3..."
community_reserve = "s3..."
```

Two testnet-only switches are deliberately absent on mainnet:
`debug_enable_at_height`, which exists so a private testnet does not wait for a
public chain tip, and `enforce_on_test_networks`, which is meaningless because
SwarmMain is not a test network and Zebra applies the health gate anyway.

## "Mainnet not launched" is a state, not a missing feature

The mainnet definition is **not bundled**. Its two required inputs — the genesis
hash and the three `s3…` funding destinations — only exist after the launch
ceremony, and there is deliberately no placeholder: a copied or guessed genesis
is exactly how a node silently joins the wrong chain.

So `electron/net/network-mainnet.json` does not exist in this build, and:

* `NP.loadProfiles()` still returns the mainnet profile, with
  `available: false` and a sentence saying SWARM mainnet has not launched;
* the Settings → This build table lists both networks, one "running now" and
  one "not available yet";
* `shell:setNetworkProfile('swarm-mainnet')` is refused with that same reason;
* a settings file that names an unavailable profile falls back to the testnet
  and says so in the log.

At release time the file is produced the same way the testnet one is:

```
node scripts/embed-network.mjs <path to network/swarm-mainnet>
```

The script reads the profile from the manifest's own identity, validates it
(genesis present, not a foreign genesis, three `s3…` destinations, one per
slot) and writes `electron/net/network-mainnet.json`. It refuses anything else.

## Payout addresses

Whether an address is *valid* is still decided only by the node. What the app
decides is which network an address BELONGS to, because the node cannot: a
testnet node happily validates a testnet address while the user has chosen
SWARM mainnet.

| | transparent | unified (internal miner) | refused |
| --- | --- | --- | --- |
| `swarm-testnet` | `tm…` (P2PKH), `t2…` (P2SH) | `swarm1…`, `utest1…` | `s1…`, `s3…`, `swm1…`, `t1…`, `t3…`, `u1…` |
| `swarm-mainnet` | `s1…` (`0x1C28`), `s3…` (`0x1C2D`) | `swm1…` | `tm…`, `t2…`, `swarm1…`, `utest1…`, `t1…`, `t3…`, `u1…` |

The unified rule mirrors the testnet rule exactly: the internal (shielded)
miner takes a unified address on both networks, the standard miner takes a
transparent one on both. ZIP-320 TEX addresses have no reviewed prefix on
either SWARM network, so none is accepted and none is constructed.

An address belonging to the *other SWARM network* is refused **before the node
is asked**, and named as such — that is the mistake a person actually makes,
and calling a good address malformed would be a lie.

Vectors under test (`test/network-profile.test.js`):
`s1MCkDhVejM4RqDyRR1rEJkudd26FVWipPD`,
`s3Mtm9Ez6HFNovPfrY7WpjPGZmYNxztrxbb`,
`t2DGVURG5tAyXXSkj85JV5xbvTobYv7H99n`,
`t2Li46A4YNFqRDvdKA212w7DtsLkbGMG2xU`.

## Wrong-chain detection, and which zebrad is required

The app already refused to trust a node holding another network's genesis
block. The quieter failure is a node that is perfectly healthy and simply on a
different network, so the engine now also compares **what the node says about
itself**:

* every tick, `refreshChain()` reads `getblockchaininfo.chain` and calls
  `applyChainCheck()`;
* `startMining()` calls `chainMismatch()` first and returns
  `{ ok: false, reason: 'WRONG_CHAIN' }` on a mismatch, so no hash is ever
  computed on the wrong chain;
* the verdict reaches the UI as `state.node.chainCheck`.

Three outcomes, and the middle one matters:

| node says | `swarm-testnet` | `swarm-mainnet` |
| --- | --- | --- |
| `test` (Zebra's BIP-70 family name for every configured testnet) | ok | **refused** |
| `swarm-mainnet` | refused | ok |
| `main` | **refused** — upstream Zcash | **refused** |
| nothing / unreadable | unknown, does not block | **refused** |

### The zebrad this profile needs

`swarm-mainnet` requires a **zebrad built with `Network::SwarmMain`** — the
build now being produced from the mainnet-integration worktree. The app does
not read a version string, because a version number can be wrong; it uses the
behaviour that only such a build can produce:

1. the node must accept a `[network.swarm_main]` section and
   `network = "SwarmMainnet"`. An older zebrad rejects both while
   deserialising its configuration and exits before opening a database, which
   surfaces as a start failure with the node's own reason;
2. the node's `getblockchaininfo.chain` must equal **`swarm-mainnet`**. An
   older zebrad cannot produce that string, so on the production profile a
   missing or different value is a refusal, not an "unknown" — see
   `checkNodeChain()` and the test "an old zebrad cannot pass the mainnet check
   by staying silent".

Both rules are in place and tested against mocked RPC responses. **Neither has
been exercised against a real SwarmMain binary yet**: no zebrad with
`Network::SwarmMain` existed on this machine when this was written, and the
profile doc itself records that a SwarmMain node can be constructed and
validated but cannot yet sync a chain (the network-free serialisation entry
points are still pinned to the upstream domain registry). Until that lands and
a binary exists, `swarm-mainnet` is an unselectable profile whose renderer and
checks are unit-tested only.

## Disposition of every "mainnet"-shaped hit in the app

Searched for `Mainnet`, `mainnet`, `network =`, `testnet`, `t1…`, `t3…`,
`tm…`, `t2…`, `swarm1…`, `u1…` across `electron/`, `src/`, `scripts/` and
`test/`.

| where | what | disposition |
| --- | --- | --- |
| `electron/chain/network-profile.js` | `FORBIDDEN_ZEBRA_NETWORKS`, `'SwarmMainnet'`, `dataDirMainnet`, the `Mainnet` comments | **the guard itself.** `Mainnet` appears only in the refusal list and in prose explaining it |
| `electron/chain/config-gen.js` | `network = "Testnet"`, `network = ${profile.zebraNetwork}`, `assertNotUpstream` | the only two places a network is selected; both go through the profile, and the output is re-checked |
| `electron/chain/engine.js` | `SwarmMainnet` in comments, `applyChainCheck` | the wrong-chain check; no network name is chosen here |
| `electron/chain/address-format.js`, `address.js` | `tm/t2/s1/s3/swarm1/utest1/swm1/u1/t1/t3` prefixes | all read from the profile; the literals left are the upstream forms being *refused* |
| `electron/chain/network-status.js` | `raw.network` | a field of the seed's status file, refused unless its chain label and genesis match this build |
| `electron/config-store.js` | `networkProfile`, `dataDirMainnet` | the stored choice and the mainnet chain folder |
| `electron/main.js` | `loadNetworks`, `chooseProfile`, `shell:setNetworkProfile` | selection and fallback; an unavailable profile cannot be chosen |
| `electron/net/network.json` | `SwarmTestnet`, `Testnet`, three `t2…` recipients | the testnet definition, unchanged |
| `src/App.jsx`, `src/dashboard.jsx`, `src/setup.jsx` | address prefixes in the wording | now rendered from `state.network.transparentHint` / `unifiedHint`, so the text follows the profile |
| `scripts/embed-network.mjs` | the `Testnet`-only gate | replaced by the profile check; writes the file that profile's loader reads |
| `scripts/capture-packaged.mjs`, `capture-profiles.mjs`, `smoke-renderer.mjs`, `integration-headless.mjs`, `live-network-check.mjs` | `tm…`, `t2…`, `swarm1…`, `u1…` literals, `network=` in a log line | testnet harness fixtures and one log format string; none selects a network |
| `test/*.test.js`, `test/fixtures/*` | every prefix, `Mainnet`, `network = "Testnet"` | test vectors and the assertions that upstream Zcash is refused |

Nothing outside `network-profile.js` decides what a network is, and nothing
anywhere maps the word "mainnet" to upstream Zcash.
