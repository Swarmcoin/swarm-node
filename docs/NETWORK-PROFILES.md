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
initial_swarm_main_peers = ["seed-main.swarm.green:28233"]
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

`initial_swarm_main_peers` is the one key that decides whether a machine can
join the chain at all. Neither upstream peer list is read on `SwarmMain` -- both
name Zcash DNS seeders, and a node that dials only foreign peers never finds
its own network -- and the on-disk peer cache is empty until the node has
already connected to somebody. So without this key a second SwarmMain node has
no way to learn that the first one exists. It is a key of `[network]`, written
**before** the `[network.swarm_main]` sub-table, because TOML would otherwise
read it as part of that sub-table. It is filled from the manifest's
`seed_peers`, so an owner's machine dials `seed-main.swarm.green:28233`. The
seed node itself names nobody, and the key is then omitted entirely rather than
written empty -- which is also what tells Zebra that node is alone on its chain
and may mine at its own tip (`Config::has_no_peer_sources`). The key exists in
zebrad from privacy-zebra `16c6a210f`; an older build rejects it.

`test/mainnet-config-gen.test.js` holds the whole mainnet file still, the same
way it holds the testnet one: `test/fixtures/golden-swarm-mainnet-zebrad.toml`
is a byte-for-byte copy, rendered from
`test/fixtures/swarm-mainnet-rehearsal-manifest.json` -- the vault's
`network/swarm-mainnet/manifest.template.json` with its five ceremony
placeholders filled by disposable values, so the golden has the shape the real
manifest will have, seed peer included.

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

The whole procedure, from the ceremony's five values to a built installer in
one command, is **docs/MAINNET-EMBED.md**, together with the per-profile binary
pins in `build/binary-pins.json` and the rehearsal that exercised all of it.

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

## Which network a build STARTS on

Added 2026-09-26, after `SWARM-Node-0.2.0-mainnet.1` — a build made with
`network_profile=swarm-mainnet`, carrying `network-mainnet.json` and the
SwarmMain `zebrad` — installed on the owner's machine and came up saying
**"SwarmTestnet · engineering testnet"**, with no control anywhere in the app
to change it. Two independent causes:

**1. The packaged app did not know which network it was built for.** The
profile was recorded in `release-manifest.json`, which sits *beside* the
installer and never travels inside it. At start-up the app read
`networkProfile` out of `settings.json`, found `swarm-testnet` — the shipped
default, and the value every earlier install had already written — and
honoured it. There was no machine, fresh or upgraded, on which a mainnet build
could have started on mainnet.

**2. `shell:setNetworkProfile` was unreachable.** The handler existed, was
exposed on the preload bridge and refused an unavailable profile with a
sentence. Nothing in the renderer ever called it. Settings listed the two
networks as read-only rows: "running now" / "available in this build".

### The marker

`electron/net/build-profile.json` records the build's own network, and
`scripts/set-build-profile.mjs` writes it from `SWARM_NETWORK_PROFILE` — the
same input that decides `release_manifest.network_profile` and which `zebrad`
is fetched, so the three cannot disagree. Both workflows run it
(`npm run mainnet:build` does too). The committed value is `swarm-testnet`, so
a developer checkout behaves exactly as before. A missing or unreadable marker
means "the default build"; a marker naming anything that is not one of the two
profiles is refused and logged, and upstream Zcash can never appear there
because the id is looked up in the closed list.

### The rule

`NP.chooseStartProfile(networks, settings, buildProfileId)`:

* a stored `networkProfile` is honoured **only** when
  `networkProfileChosenForBuild` equals this build's network — that is, when
  the person used the Network selector inside a build for this network;
* otherwise the build decides, and the override is logged with what was
  ignored and why, and shown in Settings;
* if the build's own network has no definition, it falls back to whatever the
  build does carry and says so (this is the pre-launch state);
* if nothing is usable it starts nothing, rather than guessing.

So: a mainnet build starts on mainnet, fresh or over a testnet install; a
person who deliberately picks the testnet inside the mainnet app keeps it
across restarts; a testnet build is unchanged.

### A definition is not enough to RUN a network

Both definitions ship in every build, but a build ships **one pair of
binaries**, and they are not interchangeable: the testnet `zebrad` has no
`Network::SwarmMain` in it, rejects `[network.swarm_main]` while deserialising
its configuration, and can never report chain `swarm-mainnet`. So a production
profile is selectable only when the node binary this build actually packaged
records that network in its provenance (`electron/net/binaries.json`, written
from the verified bytes). In a testnet build **SWARM Mainnet is greyed with
that reason**, rather than being a button that stops the node. The check runs
in packaged builds only, because a developer checkout may carry either pair.

### The payout address follows the network

`NP.payoutBelongsTo` is checked at start-up and on every switch. The owner's
machine held a testnet `swarm1…` unified address; SWARM mainnet has never
heard of it and cannot pay it, so it is cleared and the reason is shown in
Settings rather than left as a field nobody emptied.

### What the app now shows

| where | what |
| --- | --- |
| the band across the top | `SwarmMainnet · SWARM mainnet · chain swarm-mainnet · genesis 01c34428…` on a production profile, and the testnet warning only on the testnet |
| the header bar | the chain label, at all times, with the full genesis on hover |
| Mining | `network: swarm-mainnet`, `genesis: 01c34428…`, `payouts to: s1… / swm1…`, and the same chain label inside the held-back row |
| Node → Network | the profile label, the chain label, the genesis and what the node itself reports |
| Settings → Network | the selector, "Running now", the chain, the full genesis, the ports, the address prefixes, and which network the build was made for |

The selector is a `<select>` labelled **Network** with the options **SWARM
Mainnet** and **SWARM Testnet**. A network this build cannot run is shown
disabled with its reason in words. Choosing one asks first — it names the
chain, the genesis, the port and the fact that a foreign payout address will
be removed — then saves the choice and restarts the application, because the
engine, the chain folder and both ports are built around one profile at
start-up. `shell:restartApp` performs the same stop-everything the window's
close button does.

`state.network.isTestnet` used to be `manifest.identity.is_testnet !== false`,
and no manifest carries an `is_testnet` key, so it was always true: a SWARM
mainnet build described itself as a testnet. It is `profile.production !==
true` now, and the first-run wizard's "the coins have no value" wording — which
was consent text — follows the profile too.

`test/start-profile.test.js` and `test/network-selector.test.js` hold all of
this still, including the two things a value test cannot catch: that the
control exists in the Settings page, and that something calls the handler.

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
| `electron/main.js` | `loadNetworks`, `chooseProfile` (now `NP.chooseStartProfile`), `shell:setNetworkProfile`, `shell:restartApp` | selection, override and fallback; an unavailable profile cannot be chosen |
| `electron/net/build-profile.json` | `"profile": "swarm-testnet"` | which network this build is FOR; validated against the closed list on load |
| `electron/net/network.json` | `SwarmTestnet`, `Testnet`, three `t2…` recipients | the testnet definition, unchanged |
| `src/App.jsx`, `src/dashboard.jsx`, `src/setup.jsx` | address prefixes in the wording | now rendered from `state.network.transparentHint` / `unifiedHint`, so the text follows the profile |
| `scripts/embed-network.mjs` | the `Testnet`-only gate | replaced by the profile check; writes the file that profile's loader reads |
| `scripts/capture-packaged.mjs`, `capture-profiles.mjs`, `smoke-renderer.mjs`, `integration-headless.mjs`, `live-network-check.mjs` | `tm…`, `t2…`, `swarm1…`, `u1…` literals, `network=` in a log line | testnet harness fixtures and one log format string; none selects a network |
| `test/*.test.js`, `test/fixtures/*` | every prefix, `Mainnet`, `network = "Testnet"` | test vectors and the assertions that upstream Zcash is refused |

Nothing outside `network-profile.js` decides what a network is, and nothing
anywhere maps the word "mainnet" to upstream Zcash.
