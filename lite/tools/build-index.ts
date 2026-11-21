// Writes `_index/` for a vault folder. The generator itself is not written yet;
// until it is, this only checks its argument and says how it will be used.
const [vaultPath] = process.argv.slice(2);

if (vaultPath === undefined) {
  console.error('Usage: pnpm index <path-to-vault>');
  process.exit(1);
}

console.error(
  `Usage: pnpm index <path-to-vault>. The index writer is not built yet: ${vaultPath} is unchanged.`,
);
process.exit(1);
