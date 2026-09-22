// The pages may only read state the engine actually publishes.
//
// The Swarm map read `s.chain.peers`. There is no `chain` in the state object -
// the node's own figures live under `node` - so the expression was always
// undefined. The page said "Your node: not running" with "1 PEER" in the title
// bar two inches above it, and the fallback peer count it was supposed to show
// when the seed is unreachable could never appear at all. Nothing failed;
// nothing was thrown; it was simply wrong on screen.
//
// This walks the renderer sources for every `s.<key>` and `state.<key>` and
// checks that key against a real snapshot from a real engine. A page cannot
// silently read something that is not there.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { ChainEngine } = require('../electron/chain/engine');

const SRC = path.join(__dirname, '..', 'src');

function snapshot() {
  const e = new ChainEngine({
    manifest: require('../electron/net/network.json'),
    dataDir: 'C:/nowhere',
    settings: { payoutAddress: '', miningMode: 'standard' },
    saveSettings: () => {}
  });
  return e.getState();
}

/** Top-level names the renderer binds the snapshot to. */
const BINDINGS = ['s', 'state'];

// Where a name is bound to something OTHER than the engine snapshot. Each
// entry was confirmed by reading the file, not assumed.
//
//   map.jsx  `state` is the map's own fetch result ({data, offline,
//            fetchedAt}). The engine snapshot arrives there as the `s` prop
//            and is checked like everywhere else.
const NOT_THE_SNAPSHOT = { 'map.jsx': ['state'] };

test('every state key the pages read is one the engine publishes', () => {
  const live = snapshot();
  const top = new Set(Object.keys(live));
  const files = fs.readdirSync(SRC).filter((f) => f.endsWith('.jsx'));
  assert.ok(files.length >= 4, 'no renderer sources found');

  const misses = [];
  let checked = 0;

  for (const file of files) {
    // Comments are prose, and prose mentions the bug it is explaining. The
    // comment above the fix in map.jsx says "s.node, not s.chain", which the
    // scan dutifully reported as a miss. Read the code, not the notes.
    const text = fs.readFileSync(path.join(SRC, file), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    const skip = NOT_THE_SNAPSHOT[file] || [];
    for (const binding of BINDINGS) {
      if (skip.includes(binding)) continue;
      // `s.node.peers`, `state.rewards.blocksFound`, `s?.node?.running`
      const re = new RegExp(`\\b${binding}\\s*\\??\\.\\s*([a-zA-Z_$][\\w$]*)`, 'g');
      let m;
      while ((m = re.exec(text)) !== null) {
        const key = m[1];
        // Object and function members that are not state.
        if (['length', 'map', 'filter', 'slice', 'trim', 'toString', 'current',
          'replace', 'split', 'join', 'push', 'includes', 'src', 'onload',
          'onerror', 'textContent', 'setAttribute', 'style'].includes(key)) continue;
        checked += 1;
        if (!top.has(key)) misses.push(`${file}: ${binding}.${key}`);
      }
    }
  }

  assert.ok(checked > 20, `only ${checked} state reads found; the scan is not working`);
  assert.deepEqual(misses, [], `pages read state the engine never publishes:\n  ${misses.join('\n  ')}`);
});

test('the snapshot carries the sections this release added', () => {
  const live = snapshot();
  // Each of these is read by a page, and each was added for a specific
  // defect. If one disappears the page silently shows nothing.
  assert.ok('next' in live, 'the Mining page\u2019s primary action');
  assert.ok('confirmed' in live.payout, 'whether the node has checked the address');
  assert.ok('rejected' in live.payout, 'whether the node refused it');
  assert.ok('armed' in live.mining, 'start-when-ready');
  assert.ok('rpcMoved' in live.node, 'the control-port fallback');
  assert.ok('peers' in live.node, 'the figure the map falls back to');
});
