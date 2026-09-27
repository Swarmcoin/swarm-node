// The rows of the "Official SWARM channels" card in Settings.
//
// One of those rows is the block explorer, and SWARM has two explorers on two
// hosts: mainnet.explore.swarm.green and testnet.explore.swarm.green. The row
// used to read just "Explorer", and both network definitions pointed it at the
// bare explore.swarm.green, which serves the TESTNET, so a SWARM mainnet build
// sent people to the testnet explorer without saying so. The address now comes
// from the running network's own definition, and the label names that network
// next to the host it opens.
//
// A plain module rather than part of dashboard.jsx so the test suite can
// import it without a JSX build.

// Only these links exist, and the main process enforces the same allow-list:
// it opens nothing but the https addresses in the running network's `links`.
export const LINK_LABELS = [
  ['website', 'Website'],
  ['explorer', 'Explorer'],
  ['x', 'X'],
  ['source', 'Source code']
];

// Links whose target differs between the two SWARM networks, so their label
// must say which network they belong to.
const PER_NETWORK = new Set(['explorer']);

/**
 * The network word for a profile id: 'mainnet' for swarm-mainnet, 'testnet'
 * for swarm-testnet, null for anything else. Never guessed.
 */
export function networkWord(profileId) {
  const m = /^swarm-(mainnet|testnet)$/.exec(String(profileId || ''));
  return m ? m[1] : null;
}

/**
 * What the card shows: one row per official link the running network carries.
 *
 * @param {object} links      the running network's `links` (https addresses)
 * @param {string} profileId  the running profile, e.g. 'swarm-mainnet'
 * @returns {{key:string, label:string, url:string, host:string}[]}
 */
export function channelRows(links, profileId) {
  const word = networkWord(profileId);
  return LINK_LABELS
    .filter(([k]) => links && typeof links[k] === 'string' && links[k].startsWith('https://'))
    .map(([k, label]) => ({
      key: k,
      label: PER_NETWORK.has(k) && word ? `${label} \u00b7 ${word}` : label,
      url: links[k],
      // The visible host, so the row shows where it goes before it is clicked.
      host: links[k].replace(/^https:\/\//, '').replace(/\/$/, '')
    }));
}
