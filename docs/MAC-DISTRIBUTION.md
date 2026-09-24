# macOS direct-download builds

This path builds `0.2.0-testnet.7` from the `codex/node-swarm-prefix` source,
with the native binaries from `vendored-binaries-prefix-1`. It does not upload
to a GitHub release or touch node settings or chain data.

Prerequisites:

- Native arm64 macOS, Node.js 22, Xcode command-line tools and `npm ci`.
- A **Developer ID Application** identity, including its private key, in the
  owner's Keychain. An Apple Development or iOS distribution identity is not
  a substitute. `security find-identity -v -p codesigning` must list it.
- An owner-configured `notarytool` Keychain profile. Run
  `xcrun notarytool store-credentials SWARM-notary` interactively on the Mac;
  enter credentials only in the secure prompt. Set
  `APPLE_KEYCHAIN_PROFILE=SWARM-notary` in the build shell. Never put a key,
  password, recovery phrase or certificate export in Git or build logs.

```sh
npm ci
npm run check
mkdir -p staging
gh release download vendored-binaries-prefix-1 \
  -R Swarm-Official/swarm-node \
  -p zebrad-darwin-arm64 -p privacy-miner-darwin-arm64 -D staging
APPLE_KEYCHAIN_PROFILE=SWARM-notary node scripts/build-mac-distribution.mjs
```

For Intel, download the reviewed `darwin-x64` daemon and miner from the same
release and use `--arch x64`:

```sh
gh release download vendored-binaries-prefix-1 \
  -R Swarm-Official/swarm-node \
  -p zebrad-darwin-x64 -p privacy-miner-darwin-x64 -D staging
APPLE_KEYCHAIN_PROFILE=SWARM-notary node scripts/build-mac-distribution.mjs --arch x64
```

The Intel output is separate at `release-mac-signed-x64/out/`. The build
checks the raw x86_64 Mach-O slices before signing and the signed daemon and
miner hashes sealed into `app.asar`. If Rosetta cannot be installed on the
Apple-silicon build Mac, run the matching source on an Intel CI runner and use
`--skip-smoke` only for the local runtime check. The finished signed app must
still pass Gatekeeper and notarization assessment.

The build script verifies the original assets against the reviewed SHA256
pins, signs staged copies with hardened runtime, and records both the original
and final signed-byte hashes in `electron/net/binaries.json`. It builds the UI,
signs Electron and the outer app, and verifies that the installed daemon/miner
still match the hashes inside `app.asar`. It notarizes and staples the app and
the final DMG, then recreates the ZIP from the stapled app. Its output is
`release-mac-signed/out/` with a DMG, ZIP, `SHA256SUMS` and a release manifest.
The separate output directory is deliberately refused if it already exists.

Before release, install a **fresh browser download** with default Gatekeeper
settings and verify `codesign --verify --deep --strict`, `spctl --assess`, and
`xcrun stapler validate`. Test sync, peer/map updates and an explicitly
started/stopped mining session; check no node or miner remains after normal
exit. Keep the unsigned `release/` packages for local development only. The
Windows/Linux release draft and website are managed separately.
