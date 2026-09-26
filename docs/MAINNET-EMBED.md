# Embedding SWARM mainnet, and building it

Written 2026-09-26, before the launch ceremony, and rehearsed end to end on the
disposable rehearsal network the same day.

This build carries no SWARM mainnet definition. It cannot: the genesis hash and
the three `s3…` funding destinations only exist after the launch ceremony, and
`docs/NETWORK-PROFILES.md` explains at length why no placeholder stands in for
them. What this file describes is the **one step** that turns the ceremony's
output into a mainnet build, so that on the day nobody is inventing a procedure.

Everything below is already written and already tested. The only thing missing
is five numbers.

---

## What the ceremony has to produce

One small JSON file. Nothing else from the ceremony reaches this repository.

```json
{
  "genesis_hash": "<64 lower-case hex characters>",
  "genesis_time_unix": 1790366400,
  "recipients": {
    "core_development":  "s3...",
    "grants_ecosystem":  "s3...",
    "community_reserve": "s3..."
  },
  "genesis_hex_file": "genesis.hex"
}
```

Call it `ceremony.json` and keep it beside the ceremony's `genesis.hex`. It
holds no key material and no secret: three public addresses, a block hash and a
timestamp.

---

## The one command

From the project vault (`D:/privacy`), with `ceremony.json` in hand:

```sh
python scripts/swarm/render_mainnet_manifest.py ceremony.json
cp <ceremony>/genesis.hex network/swarm-mainnet/genesis.hex
```

Then from this repository:

```sh
npm run mainnet:build
```

That is the whole thing. `mainnet:build` is

```
npm run mainnet:embed   # node scripts/embed-network.mjs D:/privacy/network/swarm-mainnet
 && node scripts/set-build-profile.mjs swarm-mainnet   # what network this build IS
 && npm run check        # lint, string sweep, the whole unit suite
 && npm run build:ui
 && electron-builder --publish never
```

`set-build-profile.mjs` writes `electron/net/build-profile.json`, the only
thing inside the packaged app that says which network it was made for. Without
it a mainnet build reads the shipped `swarm-testnet` default out of the user's
settings and starts on the testnet — which is exactly what 0.2.0-mainnet.1 did
on the owner's machine. Both CI workflows run the same script from the same
`SWARM_NETWORK_PROFILE` input that writes the release manifest, so the two
cannot disagree. See "Which network a build STARTS on" in
docs/NETWORK-PROFILES.md.

so the definition is embedded, the build is refused if anything about it is
wrong, and the installer for the host platform is produced — in one command,
in that order, with no step that can be forgotten.

### What each part refuses

`render_mainnet_manifest.py` refuses a genesis that is not 64 lower-case hex
characters, a genesis belonging to upstream Zcash mainnet or testnet or to the
SWARM testnet, a header time in the future (block 1 could never be accepted), a
destination that is not a distinct `s3…` address, and any output in which a
`__PLACEHOLDER__` survived. It also refuses to overwrite an existing
`network/swarm-mainnet/manifest.json` without `--force`.

`scripts/embed-network.mjs` reads the profile out of the manifest's own
identity, refuses upstream Zcash outright, checks the `genesis.hex` against the
`hex_file_sha256` the manifest records, and applies
`NP.validateProfileManifest`, which on a production profile requires the
genesis hash and one `s3…` destination for each of the three slots. It writes
`electron/net/network-mainnet.json` and nothing else.

`npm run check` then runs the whole suite against the embedded definition.

---

## The binaries a mainnet build runs

A mainnet build must not run the testnet `zebrad`: that binary has no
`Network::SwarmMain`, rejects a `[network.swarm_main]` section while
deserialising its configuration, and cannot report chain `swarm-mainnet`. The
pins are therefore per profile, in `build/binary-pins.json`:

| profile | release | layout |
| --- | --- | --- |
| `swarm-testnet` | `vendored-binaries-prefix-1` in **this** repository | one asset per binary |
| `swarm-mainnet` | `vendored-binaries-mainnet-1` in the **public** `Swarm-Official/privacy-zebra` | one archive per platform |

Locally:

```sh
npm run binaries:mainnet -- --platform win-x64     # or linux-x64, darwin-arm64, darwin-x64
```

`scripts/fetch-pinned-binaries.mjs` downloads, checks the archive's SHA-256,
extracts only `zebrad` and `privacy-miner`, checks each of those against its own
pinned SHA-256, and refuses to place anything whose name contains `keytool` —
`swarm-keytool` creates spending keys and must never travel inside a miner. The
release is a transport; the hashes in `build/binary-pins.json` are the trust
anchor, and an overridden `--tag` does not override a hash.

In CI, both workflows take a `network_profile` input:

```sh
gh workflow run build-windows.yml -R Swarm-Official/swarm-node \
  --ref <branch> -f network_profile=swarm-mainnet
gh workflow run build-unix.yml -R Swarm-Official/swarm-node \
  --ref <branch> -f network_profile=swarm-mainnet -f platforms=all
```

A CI mainnet build needs `electron/net/network-mainnet.json` to be **committed**
on that branch, because CI does not have the vault. So the release order is:
render → embed → commit that one file → dispatch.

---

## Rehearsal: what was actually run

On 2026-09-26, with the disposable rehearsal values from
`D:/privacy/network/swarm-rehearsal-main/manifest.json` — a real SwarmMain
genesis and three real `s3…` addresses, all throwaway:

* `render_mainnet_manifest.py` produced a manifest whose `hex_file_sha256`
  matched the rehearsal's recorded `6b9ed4c6…` exactly;
* `embed-network.mjs` wrote `electron/net/network-mainnet.json`;
* `NP.loadProfiles()` then reported **`swarm-mainnet available=true`** — the
  first time that has been true in any build;
* `generateZebraConfig` rendered `network = "SwarmMainnet"`, the
  `[network.swarm_main]` section with that genesis and `p2p_port`/`rpc_port`
  28233/28232, `initial_swarm_main_peers = ["seed-main.swarm.green:28233"]`, and
  the three `funding_stream_addresses`;
* `npm run check` passed: lint, string sweep, **251 unit tests, 0 failures**;
* `scripts/fetch-pinned-binaries.mjs` fetched and verified the real mainnet
  `zebrad.exe` and `privacy-miner.exe` from `vendored-binaries-mainnet-1`, and
  the testnet pair from `vendored-binaries-prefix-1`, both against their pins.

The rehearsal definition was then deleted. **It is not committed**, and it must
never be: its genesis and its keys are disposable, and a build carrying them
would be a build pointing at a chain that does not exist.

---

## What is still not proven

The mainnet profile's node checks — that zebrad accepts `[network.swarm_main]`
and reports `getblockchaininfo.chain == "swarm-mainnet"` — have still only been
exercised against mocked RPC responses. The binaries that can answer them now
exist (`vendored-binaries-mainnet-1`), so this is the next thing to test, and it
is a separate piece of work from embedding.
