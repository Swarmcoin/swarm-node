// What the big button on the Mining page does, right now.
//
// The owner installed 0.2.0-testnet.2 and found "Start mining" greyed out with
// nothing to click and no explanation on that screen. A disabled button is a
// dead end: it tells the user they are wrong without telling them what to do.
//
// The rule this file enforces: there is ALWAYS one enabled primary action, it
// always moves the user forward, and it always carries a one-line reason. When
// mining genuinely cannot start yet - the node is still catching up - the
// action is to arm it, so the machine starts by itself the moment it is
// allowed, and the button says so instead of pretending to be broken.
//
// Pure: it is given the state snapshot and returns a description. It performs
// nothing and imports nothing, which is what makes it testable.

'use strict';

/** The action ids the renderer must handle. Anything else is a bug. */
const ACTIONS = ['stop', 'start', 'arm', 'disarm', 'start-node', 'set-address', 'fix-binary', 'override',
  'stop-foreign-node', 'choose-folder', 'start-everything'];

/**
 * @param {object} state the engine snapshot (getState)
 * @returns {{
 *   id: string, label: string, tone: 'primary'|'danger',
 *   why: string, progress: {done:number,total:number,label:string}|null,
 *   alternative: {id:string,label:string,why:string}|null
 * }}
 */
function nextAction(state) {
  const s = state || {};
  const m = s.mining || {};
  const n = s.node || {};
  const g = s.gate || {};
  const p = s.payout || {};

  // Already mining: the only sensible primary is to stop.
  if (m.on) {
    return act('stop', '■  Stop mining', 'danger',
      m.mode === 'shielded'
        ? 'The node is mining to your shielded address.'
        : `${m.workers || 0} core${m.workers === 1 ? '' : 's'} are working for you.`);
  }

  // N-9. ONE PRESS. The user asked to mine and the app is working on it:
  // starting the node, letting it catch up, waiting for the gate. There is no
  // second button to find and no decision to make - the same button now stops
  // it again, and the line underneath says where it has got to.
  if (m.wanted) {
    return act('stop', '■  Stop mining', 'danger',
      workingOn(n, g), syncProgress(n, g));
  }

  // No address: nothing can be paid to anybody. This is the one case where
  // the primary leaves the page, because the answer is not on it.
  if (!p.address) {
    return act('set-address', 'Add your payout address', 'primary',
      'Mining needs somewhere to pay you. It takes one paste from the SWARM Wallet.');
  }

  // A RUNNING node has looked at the stored address and does not recognise
  // it. Mining would hand that address to the node as its payout and the node
  // would refuse to start, so the next useful thing is to replace it. This is
  // never reached because the node could not be asked - only because it was
  // asked and said no.
  if (p.rejected === true) {
    return act('set-address', 'Replace your payout address', 'primary',
      'Your node does not recognise the address saved here, so nothing could be paid to it.');
  }

  // The node is not running AND something is known to be wrong with it.
  //
  // N-8: an older version's daemon held the chain database, the new one
  // panicked on start and exited, and the app showed the armed spinner for
  // ever. A stopped node that has a REASON must show the reason and a button
  // that acts on it - never a spinner, and never a bare "Start your node"
  // that will fail the same way again.
  if (!n.running && n.trouble && n.trouble.text) {
    if (n.trouble.action === 'stop-foreign-node') {
      return act('stop-foreign-node', 'Stop it and continue', 'primary', n.trouble.text);
    }
    if (n.trouble.action === 'choose-folder') {
      return act('choose-folder', 'Choose another chain folder', 'primary', n.trouble.text);
    }
    return act('start-node', 'Try starting your node again', 'primary', n.trouble.text);
  }

  // Everything from here is one press. Starting the node, choosing the engine
  // the address allows and waiting for the chain are the app's work, not a
  // sequence of buttons for somebody to discover.
  if (!n.running) {
    return act('start-everything', '▶  Start mining', 'primary',
      'This starts your node, waits for it to catch up, and begins mining on its own.');
  }

  // The engine the user picked is not installed. Offering "start" here would
  // fail on click, so the primary switches to the thing that can be fixed.
  if (m.mode === 'standard' && m.standardAvailable === false) {
    return act('fix-binary', 'Use the node’s own miner instead', 'primary',
      'The separate miner is not available in this build, but the node can mine on its own, across your cores.');
  }

  // The gate is open.
  if (g.allow) {
    return act('start', '▶  Start mining', 'primary',
      g.overridden
        ? 'Starting at your request, while the node catches up.'
        : 'Your node is connected and up to date.');
  }

  // The gate is closed and nobody has asked to mine yet: one press still.
  const progress = syncProgress(n, g);
  if (!m.armed) {
    return act('start-everything', '▶  Start mining', 'primary',
      (g.message ? g.message + ' ' : '') + 'Press it and walk away: mining begins by itself.',
      progress,
      g.offerOverride
        ? { id: 'override', label: 'Start anyway', why: 'This is taking longer than expected.' }
        : null);
  }
  if (m.armed) {
    return act('disarm', 'Cancel automatic start', 'primary',
      'Mining will begin by itself as soon as your node is ready. ' + (g.message || ''),
      progress,
      g.offerOverride
        ? { id: 'override', label: 'Start anyway', why: 'This is taking longer than expected.' }
        : null);
  }
  return act('arm', '▶  Start mining when ready', 'primary',
    (g.message ? g.message + ' ' : '') + 'This arms it: nothing is wasted while your node catches up.',
    progress,
    g.offerOverride
      ? { id: 'override', label: 'Start anyway', why: 'This is taking longer than expected.' }
      : null);
}

/**
 * Real progress or none. Extrapolating a percentage from a height the app has
 * not been told is how a progress bar comes to sit at 99% forever.
 */
function syncProgress(node, gate) {
  const mine = Number.isInteger(node.height) ? node.height : null;
  const net = Number.isInteger(gate.networkHeight) ? gate.networkHeight
    : Number.isInteger(node.networkHeight) ? node.networkHeight : null;
  if (mine == null) return null;
  if (net == null || net <= 0) {
    return { done: mine, total: null, label: `block ${mine.toLocaleString('en-US')} so far` };
  }
  const total = Math.max(net, mine);
  return {
    done: mine,
    total,
    label: `block ${mine.toLocaleString('en-US')} of ${total.toLocaleString('en-US')}`
  };
}

/** Where the one press has got to, in words. */
function workingOn(node, gate) {
  if (!node.running) return 'Starting your node…';
  if (!Number.isInteger(node.height)) return 'Your node is starting up…';
  if (!node.peers) return 'Looking for other nodes to download the chain from…';
  if (gate.allow) return 'Your node is ready; mining is starting…';
  return (gate.message ? gate.message + ' ' : '') + 'Mining begins by itself the moment it is ready.';
}

function act(id, label, tone, why, progress = null, alternative = null) {
  return { id, label, tone, why, progress, alternative };
}

module.exports = { nextAction, ACTIONS, syncProgress };
