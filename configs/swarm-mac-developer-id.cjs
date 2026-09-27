"use strict";

// Used only by scripts/build-mac-distribution.mjs. The ordinary build in
// package.json remains the unsigned development baseline for other platforms.
const { developerIdIdentity } = require("../scripts/mac-distribution-identity.cjs");
const base = require("../package.json").build;
const arch = process.env.SWARM_MAC_ARCH || "arm64";
if (!["arm64", "x64"].includes(arch)) throw new Error(`Unsupported SWARM_MAC_ARCH: ${arch}`);

module.exports = {
  ...base,
  directories: { ...base.directories, output: arch === "x64" ? "release-mac-signed-x64" : "release-mac-signed" },
  afterSign: "./scripts/verify-mac-signed-app.cjs",
  mac: {
    ...base.mac,
    target: [{ target: "dmg", arch: [arch] }, { target: "zip", arch: [arch] }],
    // electron-builder selects the Developer ID certificate type itself and
    // rejects the "Developer ID Application:" prefix in an explicit identity.
    identity: developerIdIdentity().replace(/^Developer ID Application:\s*/, ""),
    hardenedRuntime: true,
    gatekeeperAssess: true,
    entitlements: "./configs/entitlements.mac.plist",
    entitlementsInherit: "./configs/entitlements.mac.plist",
    // These executables are signed before packaging, then their exact signed
    // bytes are hashed into app.asar. Re-signing would invalidate that hash.
    signIgnore: ["/Contents/Resources/bin/swarm-(?:node-daemon|miner)$"],
    // electron-builder notarizes and staples the app before building the DMG.
    // The distribution script separately notarizes and staples the final DMG.
    notarize: true,
  },
};
