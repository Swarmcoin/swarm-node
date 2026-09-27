# macOS direct-download build

This path signs and notarizes `0.2.0-mainnet.5` for Apple silicon and Intel.
It fetches the reviewed mainnet daemon and miner from
`vendored-binaries-mainnet-2`, verifies their hashes against
`build/binary-pins.json`, and does not touch node settings or chain data.

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
APPLE_KEYCHAIN_PROFILE=SWARM-notary node scripts/build-mac-distribution.mjs
```

For Intel, use the same clean source checkout and pass `--arch x64`:

```sh
APPLE_KEYCHAIN_PROFILE=SWARM-notary node scripts/build-mac-distribution.mjs --arch x64
```

The build script verifies the original assets against the reviewed SHA256
pins, signs staged copies with hardened runtime, and records both the original
and final signed-byte hashes in `electron/net/binaries.json`. It builds the UI,
signs Electron and the outer app, and verifies that the installed daemon/miner
still match the hashes inside `app.asar`. It notarizes and staples the app and
the final DMG, then recreates the ZIP from the stapled app. Its output is
`release-mac-signed/out/` with a DMG, ZIP, `SHA256SUMS` and a release manifest.
Intel output is written to `release-mac-signed-x64/out/`. The separate output
directory is deliberately refused if it already exists. When building both
architectures in one checkout, restore the generated `electron/net/binaries.json`
and `electron/net/build-profile.json` to the reviewed commit between builds.

Before release, install a **fresh browser download** with default Gatekeeper
settings and verify `codesign --verify --deep --strict`, `spctl --assess`, and
`xcrun stapler validate`. Test sync, peer/map updates and an explicitly
started/stopped mining session; check no node or miner remains after normal
exit. Keep the unsigned `release/` packages for local development only. The
Windows/Linux release draft and website are managed separately.
