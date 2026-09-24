// Mining history is not a wallet balance. Shielded spendability is private
// wallet state; a public node cannot infer it from a block's age.
export function rewardStatus(block, tipHeight, maturity) {
  if (block.mode === 'shielded') return { label: 'Check wallet', mature: false };
  if (!Number.isInteger(tipHeight) || tipHeight < block.height) {
    return { label: 'Waiting for chain tip', mature: false };
  }
  const confirmations = tipHeight - block.height + 1;
  return confirmations >= maturity
    ? { label: 'Mature', mature: true }
    : { label: `${maturity - confirmations} to go`, mature: false };
}
