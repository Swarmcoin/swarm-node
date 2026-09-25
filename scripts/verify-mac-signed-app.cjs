"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync, spawnSync } = require("node:child_process");
const asar = require("@electron/asar");

module.exports = async function verifyMacSignedApp(context) {
  if (context.electronPlatformName !== "darwin") throw new Error("Expected a macOS build");
  const app = path.join(context.appOutDir, "SWARM Node.app");
  const archive = path.join(app, "Contents/Resources/app.asar");
  const manifest = JSON.parse(asar.extractFile(archive, "electron/net/binaries.json").toString());
  const expected = manifest.platforms?.["darwin-arm64"];
  if (!expected?.zebrad || !expected?.miner) throw new Error("No signed arm64 binary hashes in app.asar");
  for (const kind of ["zebrad", "miner"]) {
    const entry = expected[kind];
    const file = path.join(app, "Contents/Resources/bin", entry.file);
    const hash = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    if (hash !== entry.sha256) throw new Error(`${kind} changed after its hash was sealed in app.asar`);
    execFileSync("codesign", ["--verify", "--strict", "--verbose=2", file], { stdio: "inherit" });
    const display = spawnSync("codesign", ["-dv", "--verbose=4", file], { encoding: "utf8" });
    if (display.status !== 0) throw new Error(`Cannot inspect ${kind} signature: ${display.stderr}`);
    const details = display.stderr;
    if (!/Authority=Developer ID Application:/.test(details)) throw new Error(`${kind} lacks a Developer ID Application signature`);
    console.log(`${kind}: signed-byte SHA256 ${hash} matches app.asar`);
  }
  execFileSync("codesign", ["--verify", "--deep", "--strict", "--verbose=2", app], { stdio: "inherit" });
  const outer = spawnSync("codesign", ["-dv", "--verbose=4", app], { encoding: "utf8" });
  if (outer.status !== 0 || !/Authority=Developer ID Application:/.test(outer.stderr)) {
    throw new Error("Outer app lacks a Developer ID Application signature");
  }
};
