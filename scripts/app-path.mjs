// Where the packaged app's executable actually is, on each platform.
//
// The three harnesses take "the unpacked build" as an argument, and what that
// means differs:
//
//   Windows   release/win-unpacked/SWARM Node.exe
//   Linux     release/linux-unpacked/swarm-node        (electron-builder names
//             it after `name` in package.json, not productName)
//   macOS     release/mac-arm64/SWARM Node.app/Contents/MacOS/SWARM Node
//
// A harness that guesses wrongly reports "no packaged app at ..." and the
// reason is a path, which tells nobody anything. This resolves all three, and
// accepts being handed either the folder above the .app, the .app itself, or
// the MacOS directory inside it.

import fs from 'node:fs';
import path from 'node:path';

/**
 * @param {string} dir  whatever the caller was given
 * @returns {string|null} the executable to spawn, or null with a reason on stderr
 */
export function resolveAppExe(dir) {
  const tries = [];

  if (process.platform === 'win32') {
    tries.push(path.join(dir, 'SWARM Node.exe'));
  } else if (process.platform === 'darwin') {
    // Handed the MacOS directory itself.
    tries.push(path.join(dir, 'SWARM Node'));
    // Handed the .app bundle.
    tries.push(path.join(dir, 'Contents', 'MacOS', 'SWARM Node'));
    // Handed the folder that contains the .app.
    tries.push(path.join(dir, 'SWARM Node.app', 'Contents', 'MacOS', 'SWARM Node'));
    // Or a folder containing exactly one .app of some other name.
    try {
      for (const entry of fs.readdirSync(dir)) {
        if (entry.endsWith('.app')) tries.push(path.join(dir, entry, 'Contents', 'MacOS', entry.replace(/\.app$/, '')));
      }
    } catch { /* not a directory */ }
  } else {
    tries.push(path.join(dir, 'swarm-node'));
    tries.push(path.join(dir, 'SWARM Node'));
  }

  for (const candidate of tries) {
    if (fs.existsSync(candidate)) return candidate;
  }
  console.error(`no packaged app under ${dir}. Looked for:`);
  for (const t of tries) console.error(`  ${t}`);
  return null;
}
