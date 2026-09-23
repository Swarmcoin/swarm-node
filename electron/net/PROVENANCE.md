# Where the two bundled programs come from

SWARM Node runs two third-party executables. Neither is built here: both are
built in `Swarm-Official/privacy-zebra` by GitHub Actions, downloaded by this
app's build workflow, and refused at run time unless their SHA-256 matches
`binaries.json`.

They come from **two different upstream trees**. That is stated first because
an earlier version of this note said both were "official Zebra 6.3.0 source
with no source changes", which is true of one and not the other.

---

## `zebrad.exe` — the node

| | |
| --- | --- |
| SHA-256 | `8741ceee52a26f5a0390773188c0bd2961111b379973ecde881ab820b5076161` |
| Repository | `Swarm-Official/privacy-zebra` |
| Branch | `swarm-ci` |
| Commit | `95ccc1564b200d26609b203800f51509fbeec467` |
| Upstream base | tag **`v6.3.0`** — the official Zcash Foundation release |
| Build | `cargo build --locked --release --package zebrad --bin zebrad --features internal-miner` |
| Toolchain | rustc 1.91.0 (f8297e351, 2025-10-28), x86_64-pc-windows-msvc |
| Workflow run | https://github.com/Swarm-Official/privacy-zebra/actions/runs/35800107349 |
| Built | 2026-09-23T00:08:50Z |

**What the branch changes relative to `v6.3.0`: one file added, one file changed.**

```
added     .github/workflows/swarm-binaries.yml        a build workflow (CI only)
modified  zebrad/src/components/miner.rs              the mining component
```

The change to `miner.rs` is not consensus code and cannot alter which blocks are
produced, accepted or stored. The solver asks for its next nonce through the
miner's own cancellation closure, so the component counts those calls — one call
is one Equihash attempt — and logs the rate it measured, in the shape the
standalone miner uses:

```
internal miner rate: 1234 sol/s (attempts 12345 in 10.0s)
```

It exists because the node reported no rate anywhere at all, so a node app had
nothing honest to show for a machine mining with the internal miner. Before this
commit the branch added only the workflow. No `Cargo.toml`, no `Cargo.lock`, no
consensus, cryptographic, state or RPC code.

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

The node is built from the official **`v6.3.0`** release. The miner is built
from a tree **333 commits later**. So the miner's copy of Zebra's block-builder
and solver is newer than the node's.

In practice the miner is an RPC client: it asks the node for a block template
over `getblocktemplate`, solves it, and hands the result back through
`submitblock`. The node validates everything it accepts, so the node's rules —
the `v6.3.0` ones — are what decide. A version difference here cannot make the
node accept a block it would otherwise reject.

It is still a difference, and it is recorded here rather than smoothed over.
Aligning the two trees is worth doing before anything resembling a mainnet.

---

Checked against the published build manifests and against
`gh api repos/Swarm-Official/privacy-zebra/compare/...` on 2026-09-22.
