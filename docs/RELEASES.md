# Releasing, and the update channel that is deliberately switched off

## Why auto-update was removed rather than disabled

The earlier SWARM Node — the owner's AI-compute app, version 0.1.x — ships with
`electron-updater` pointed at the public `brs-holding/swarm-downloads` GitHub
release feed, with `autoDownload` and `autoInstallOnAppQuit` both on. Every one
of those installs checks that feed on launch.

Publishing this app there would therefore reach into machines whose owners
agreed to run AI compute jobs and turn the program into a cryptocurrency miner,
silently, on the next restart. That is exactly the thing the app's own consent
screen promises will not happen.

So this build:

* has a different `appId` (`green.swarm.node`, not `network.swarm.node`), which
  gives it its own Windows uninstall entry;
* uses its own user-data folder (`%APPDATA%\green.swarm.node`), so the two
  cannot share settings, consent state or a payout address;
* installs into its own directory (`build/installer.nsh`), so it cannot
  overwrite the other app's files;
* has `electron-updater` removed from `package.json` entirely, and the
  `swarm-downloads` publish target removed from the electron-builder config;
* is refused by `npm run lint` if any of those come back.

## Turning a release channel back on, later

When the project wants automatic updates for SWARM Node, the work is:

1. **Create a separate release repository.** Never `swarm-downloads`. Something
   like `brs-holding/swarm-node-releases`, used by nothing else.
2. **Add the publish target** to `package.json` under `build`:

   ```json
   "publish": [
     { "provider": "github", "owner": "brs-holding", "repo": "swarm-node-releases", "releaseType": "release" }
   ]
   ```

3. **Add the dependency back**: `npm install electron-updater`.
4. **Wire it in `electron/main.js`**, and — this is the part that matters —
   keep it honest: ask before downloading, show what version is coming, and
   never install an update that changes what the app does without showing the
   consent screen again.
5. **Update `scripts/lint.mjs`**, which currently fails the build if
   `electron-updater` or `swarm-downloads` appears anywhere. Remove only the
   `electron-updater` rule. **Leave the `swarm-downloads` rule in place for
   ever**: that feed belongs to the other app, and this one must never publish
   to it.
6. **Sign the builds first.** Unsigned auto-updates are a worse idea than
   unsigned manual downloads, because nobody is watching when they install.

## Publishing this version by hand

CI produces, as the `swarm-node-windows-x64` artifact:

```
SWARM-Node-<version>-win-x64.exe     NSIS installer
SWARM-Node-<version>-win-x64.zip     portable
SHA256SUMS                           checksums of both
release-manifest.json                version, git sha, build time, file sizes
                                     and hashes, and the hashes of the bundled
                                     zebrad and privacy-miner
```

Nothing is published automatically. After the audit, publishing is one command:

```sh
gh release create v0.2.0-testnet.1 \
  SWARM-Node-0.2.0-testnet.1-win-x64.exe \
  SWARM-Node-0.2.0-testnet.1-win-x64.zip \
  SHA256SUMS release-manifest.json \
  -R brs-holding/swarm-node \
  --title "SWARM Node 0.2.0-testnet.1" \
  --notes-file RELEASE-NOTES.md \
  --prerelease
```

`--prerelease` is deliberate: this is a testnet build.

## Code signing

The builds are unsigned, so Windows SmartScreen warns and some antivirus
products will flag a program that contains a miner. `RELEASE-NOTES.md` explains
this to users in plain language and tells them how to check the SHA-256 of what
they downloaded against `SHA256SUMS`.

A signing certificate is an owner purchase. An EV certificate also carries
SmartScreen reputation immediately, where an OV certificate has to build it up.
Until then, the checksum file is the thing that actually proves a download is
the file that was built, and it is worth more than a signature nobody checks.

## Linux and macOS

Not built yet. The node binary exists for both from the same privacy-zebra run,
and the shielded (one-core) mining mode would work unchanged, because the
graceful stop on those platforms is a plain SIGINT and
`electron/chain/spawn-console.js` already takes that path. Standard multi-core
mining needs a `privacy-miner` built for that platform; where it is missing the
app already hides the mode rather than offering something it cannot do.
