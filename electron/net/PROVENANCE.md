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
| SHA-256 | `b6ea39096b99debd64b248789d47c8a3a94afea5541e3a75f896b552ac61c477` |
| Repository | `Swarm-Official/privacy-zebra` |
| Branch | `swarm-ci` |
| Commit | `cb99dd063feaac493f93fdfca3e7d7acad685573` |
| Upstream base | tag **`v6.3.0`** — the official Zcash Foundation release |
| Build | `cargo build --locked --release --package zebrad --bin zebrad --features internal-miner` |
| Toolchain | rustc 1.91.0 (f8297e351, 2025-10-28), x86_64-pc-windows-msvc |
| Workflow run | https://github.com/Swarm-Official/privacy-zebra/actions/runs/35603263833 |
| Built | 2026-09-21T13:26:17Z |

**What the branch changes relative to `v6.3.0`: one file.**

```
added  .github/workflows/swarm-binaries.yml
```

A build workflow. No Rust source, no `Cargo.toml`, no `Cargo.lock`, no
consensus or cryptographic code. The `internal-miner` feature is an upstream
Cargo feature, switched on at build time, not a patch.

---

## `privacy-miner.exe` — the standard mining engine

| | |
| --- | --- |
| SHA-256 | `e6e16810e5f01688a668d80d11be689c278d2df3b3c5d35d25667b668c35123a` |
| Repository | `Swarm-Official/privacy-zebra` |
| Branch | `swarm-tools` |
| Commit | `103184e96b7f5fc5ae3fdeaec6a97a10612d2f0b` |
| Upstream base | **`7c64a8419388dd72664a19a70aed66e84f3e2d5b`** — a later upstream Zebra development commit, **333 commits ahead of `v6.3.0`** |
| Build | `cargo build --locked --release --package zebrad --bin privacy-miner --bin swarm-keytool --features internal-miner` |
| Toolchain | rustc 1.91.0 (f8297e351, 2025-10-28), x86_64-pc-windows-msvc |
| Workflow run | https://github.com/Swarm-Official/privacy-zebra/actions/runs/35626325459 |
| Built | 2026-09-21T16:40:14Z |

**What the branch changes relative to that base: four commits, seven files.**

```
added     zebrad/src/bin/privacy-miner.rs      the miner
added     zebrad/src/bin/swarm-keytool.rs      NOT shipped with this app
added     docs/privacy-miner.md
added     docs/swarm-keytool.md
modified  zebrad/Cargo.toml                    registers the two new binaries
modified  Cargo.lock
added     .github/workflows/swarm-tools.yml    build workflow
```

No existing source file is modified. `privacy-miner.rs` is an RPC client around
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
