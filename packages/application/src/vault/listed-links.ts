import { parentVaultPath, VAULT_ROOT, vaultPathName, type VaultPath } from '@dfai/domain';
import type { VaultFsPort } from './ports.ts';

/** The nearest folder above `path` that is a link, or null when none is. */
export async function linkAbove(
  fs: Pick<VaultFsPort, 'listDirectory'>,
  path: VaultPath,
): Promise<VaultPath | null> {
  const above: VaultPath[] = [];
  for (let at = parentVaultPath(path); at !== VAULT_ROOT; at = parentVaultPath(at)) above.push(at);
  const linked = await Promise.all(above.map((folder) => isListedAsLink(fs, folder)));
  return above.find((_, at) => linked[at]) ?? null;
}

/** `folder` when it is a link, else the nearest folder above it that is, or null (#680). */
export async function linkAtOrAbove(
  fs: Pick<VaultFsPort, 'listDirectory'>,
  folder: VaultPath,
): Promise<VaultPath | null> {
  if (folder === VAULT_ROOT) return null;
  const [itself, above] = await Promise.all([isListedAsLink(fs, folder), linkAbove(fs, folder)]);
  return itself ? folder : above;
}

/** Whether the folder above lists `path` as a link. */
export async function isListedAsLink(
  fs: Pick<VaultFsPort, 'listDirectory'>,
  path: VaultPath,
): Promise<boolean> {
  const name = vaultPathName(path);
  const entries = await fs.listDirectory(parentVaultPath(path));
  return entries.some((entry) => entry.name === name && entry.link === true);
}
