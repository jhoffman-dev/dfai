import {
  createVaultPath,
  DASHBOARDS_DIRECTORY,
  VIEWS_FOLDER,
  type ObjectType,
  type SpecProposalKind,
  type VaultPath,
} from '@dfai/domain';
import { loadObjectTypes } from '../types/load-types.ts';
import type { ProposalPorts } from './proposal-file.ts';

const FOLDERS: Readonly<Record<SpecProposalKind, string>> = {
  dashboard: DASHBOARDS_DIRECTORY,
  view: VIEWS_FOLDER,
};

/**
 * What accepting a dashboard or view proposal is checked against (P32-05):
 * the vault's types as they are now, and the entries already in the folder
 * it writes into — a vault with none yet has the folder made when it is
 * written into, not before.
 */
export async function specVault(
  ports: Pick<ProposalPorts, 'fs' | 'markdown'>,
  kind: SpecProposalKind,
): Promise<{ types: readonly ObjectType[]; specPaths: readonly VaultPath[] }> {
  const types = await loadObjectTypes({ fs: ports.fs, markdown: ports.markdown });
  // No folder yet is no entries yet. Safe to read any failure so: the entry is made with the
  // exclusive create, which refuses a name taken after all rather than write over it.
  const entries = await ports.fs.listDirectory(createVaultPath(FOLDERS[kind])).catch(() => []);
  return { types, specPaths: entries.map(({ path }) => path) };
}
