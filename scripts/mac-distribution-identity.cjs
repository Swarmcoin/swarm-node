"use strict";

const { execFileSync } = require("node:child_process");

function developerIdIdentity() {
  const output = execFileSync("security", ["find-identity", "-v", "-p", "codesigning"], { encoding: "utf8" });
  const names = [...output.matchAll(/"(Developer ID Application:[^"]+)"/g)].map((match) => match[1]);
  const requested = process.env.SWARM_MAC_SIGN_IDENTITY;
  if (requested && !names.includes(requested)) {
    throw new Error("SWARM_MAC_SIGN_IDENTITY must exactly match an installed Developer ID Application identity with its private key");
  }
  if (!requested && names.length !== 1) {
    throw new Error(`Expected one Developer ID Application identity in Keychain; found ${names.length}. Set SWARM_MAC_SIGN_IDENTITY if more than one is installed.`);
  }
  return requested || names[0];
}

module.exports = { developerIdIdentity };
