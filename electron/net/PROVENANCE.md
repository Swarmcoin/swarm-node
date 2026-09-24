# Bundled node and mining engine provenance

The build downloads reviewed binaries and verifies their SHA-256 before
packaging. The application checks the recorded hashes before starting them.
The node and standard miner come from separate upstream revisions.

## `swarm-node-daemon` — the node

Source: `Swarm-Official/privacy-zebra`, branch `codex/swarm-prefix-node`,
commit `c4e0a4b3772ab81c2c73a183d837ac3ce2ea7c05`, based on Zebra `v6.3.0`.
[Native build and compatibility tests](https://github.com/Swarm-Official/privacy-zebra/actions/runs/35938556704).

Build command: `cargo build --locked --release --package zebrad --bin zebrad --features internal-miner`.
Each platform's build manifest records its Rust toolchain and build time.

| Target | Binary SHA-256 | Built at UTC |
| --- | --- | --- |
| `aarch64-apple-darwin` | `61a2333ff660aa55f4351f88654bc4ad9f6041b65b0bf5349cd57d95e25160cb` | 2026-09-24T00:49:42Z |
| `x86_64-pc-windows-msvc` | `a26d4ba503b986f1671ef4fd695476ab181e747c67983d0215cddc4eed0d6bc3` | 2026-09-24T00:57:07Z |
| `x86_64-unknown-linux-gnu` | `f0a809f6aa8671e7b47c1557d4c524293d9c0e7871648812f6383dc37dfd0896` | 2026-09-24T00:49:03Z |
| `x86_64-apple-darwin` | `486cfa2fb459427386705ae7bde05b172e58ae3fa794dd73d36dbd2d31f88748` | 2026-09-24T01:36:55Z |

The reviewed changes relative to the upstream release are:

- SWARM build workflows, build documentation and changelog entries.
- Internal-miner rate reporting in `zebrad/src/components/miner.rs`.
- Vendored `zcash_protocol` 0.10.1 and `zcash_address` 0.13.0, selected through
  the workspace manifest and lockfile. Unified testnet addresses and viewing
  keys encode with `swarm`, `uviewswarm` and `uivkswarm`; decoding also accepts
  their corresponding legacy testnet forms. Encoded receiver bytes retain
  their existing meaning. Transparent, Sapling, TEX, mainnet and regtest
  prefixes retain their existing definitions.
- Mining-address compatibility regression tests in
  `zebra-rpc/src/config/mining.rs`, run for every native target.

Consensus rules, proof verification, key derivation and chain state formats
retain their upstream behavior. The standard miner below retains its existing
source and binary pins.

---

## `privacy-miner.exe` — the standard mining engine

| | |
| --- | --- |
| SHA-256 | `2734b6b5663a82b2046c88e5875e6fa015d9b6ec3eba312d3b89409a8fc34646` |
| Repository | `Swarm-Official/privacy-zebra` |
| Branch | `swarm-tools` |
| Commit | `7f82a03beceaf115ffcdf55ae30ae34c7abb4261` |
| Upstream base | **`7c64a8419388dd72664a19a70aed66e84f3e2d5b`** — a later upstream Zebra development commit, **333 commits ahead of `v6.3.0`** |
| Build | `cargo build --locked --release --package zebrad --bin privacy-miner --bin swarm-keytool --features internal-miner` |
| Toolchain | rustc 1.91.0 (f8297e351, 2025-10-28), x86_64-pc-windows-msvc |
| Workflow run | https://github.com/Swarm-Official/privacy-zebra/actions/runs/35800186092 |
| Built | 2026-09-23T00:09:20Z |

**What the branch changes relative to that base: five commits, eight files.**

```
added     zebrad/src/bin/privacy-miner.rs      the miner
added     zebrad/src/bin/swarm-keytool.rs      NOT shipped with this app
added     docs/privacy-miner.md
added     docs/swarm-keytool.md
modified  zebrad/Cargo.toml                    registers the two new binaries
modified  Cargo.lock
added     .github/workflows/swarm-tools.yml    build workflow
modified  zebrad/src/bin/privacy-miner.rs      the miner reports its own measured rate
```

The last commit adds the rate line, for the same reason the node has one: the
miner printed no rate, so a node app reading its output had nothing to show. It
counts the solver's nonce requests and prints `Mining rate N sol/s (attempts X in
Ys)` every ten seconds while it works. `privacy-miner.rs` is an RPC client around
Zebra's unchanged `proposal_block_from_template`, `Solution::solve`, Equihash
verification, target checks and block serialisation; it adds no cryptographic
primitive and no consensus rule. It is licensed MIT OR Apache-2.0 like the code
it is built from.

`swarm-keytool.exe` is built by the same command and is **deliberately not
bundled**: it creates spending keys, which a miner has no business carrying.
`scripts/make-binaries-manifest.mjs` refuses to package anything matching
`*keytool*`, and so does the build workflow.

---

## The thing worth noticing

The node is built from the reviewed SWARM fork of **`v6.3.0`**. The miner is built
from a tree **333 commits later**. So the miner's copy of Zebra's block-builder
and solver is newer than the node's.

In practice the miner is an RPC client: it asks the node for a block template
over `getblocktemplate`, solves it, and hands the result back through
`submitblock`. The node validates everything it accepts, so the node's rules —
the inherited `v6.3.0` consensus rules — are what decide. A version difference here cannot make the
node accept a block it would otherwise reject.

It is still a difference, and it is recorded here rather than smoothed over.
Aligning the two trees is worth doing before anything resembling a mainnet.

---

Checked against the published build manifests and against
`gh api repos/Swarm-Official/privacy-zebra/compare/...` on 2026-09-22.
