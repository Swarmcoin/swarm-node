// Shut a harness-launched app down properly, and leave nothing behind.
//
// WHY THIS EXISTS. The capture harness killed the packaged app with
// `taskkill /T`, which ends the Electron process tree. The node and the miner
// are NOT in that tree: they are started through a detached console launcher
// so that a real Ctrl-C can be delivered to them. So force-killing the app
// orphaned them, and a verification run left four of the owner's cores mining
// on a chain nobody was watching. "Leave nothing running" is the first rule
// this harness claims to keep, and it was not keeping it.
//
// The order here matters:
//   1. ask the app to close, which runs the product's own shutdown - the same
//      graceful Ctrl-C path a person gets when they close the window;
//   2. only if that does not finish, force the process tree;
//   3. then sweep for any node or miner still holding THIS RUN's data folder,
//      identified by its command line, and end those.
//
// Step 3 is deliberately narrow. It matches on the throwaway directory this
// run created, so it can never touch a node the owner is running themselves.

import { execFileSync } from 'node:child_process';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Is that process id still alive? */
function alive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

function killTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(pid, 'SIGKILL');
  } catch { /* already gone */ }
}

/**
 * Process ids whose command line mentions `needle`. Windows only; returns []
 * elsewhere, where the detached-console problem does not arise.
 */
function pidsMentioning(needle) {
  if (process.platform !== 'win32') return [];
  try {
    const out = execFileSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine -like '*" +
      String(needle).replace(/'/g, "''") + "*' } | ForEach-Object { $_.ProcessId }"
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 20000 });
    return out.split(/\r?\n/).map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0);
  } catch {
    return [];
  }
}

/**
 * @param {object} child   the spawned app process
 * @param {object} cdp     an open DevTools connection, or null
 * @param {string} dataDir the throwaway folder this run used
 * @returns {Promise<{graceful: boolean, swept: number[]}>}
 */
export async function stopApp(child, cdp, dataDir) {
  let graceful = false;

  // 1. The product's own shutdown. Browser.close makes Electron close the
  //    window, which is what runs stopAll() and stops the node with a real
  //    Ctrl-C rather than orphaning it.
  if (cdp) {
    try {
      cdp.send('Browser.close').catch(() => {});
      const until = Date.now() + 30000;
      while (Date.now() < until) {
        if (!alive(child?.pid)) { graceful = true; break; }
        await sleep(400);
      }
    } catch { /* fall through to the hammer */ }
  }

  // 2. The hammer, only if asking did not work.
  if (!graceful) {
    killTree(child?.pid);
    await sleep(2500);
  }

  // 3. Anything still holding THIS run's folder. Narrow on purpose: the
  //    owner's own node must never be caught by this.
  const swept = [];
  if (dataDir) {
    for (const pid of pidsMentioning(dataDir)) {
      if (pid === process.pid || pid === child?.pid) continue;
      killTree(pid);
      swept.push(pid);
    }
  }
  if (swept.length) console.log(`  swept ${swept.length} orphaned process(es) that were still using this run's folder: ${swept.join(', ')}`);
  await sleep(1500);
  return { graceful, swept };
}

export { alive, killTree, pidsMentioning };
