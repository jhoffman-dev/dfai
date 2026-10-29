import {
  ATLAS_DIRECTORY,
  createVaultPath,
  isPromptPath,
  PROMPTS_DIRECTORY,
  type VaultEntry,
  vaultPathName,
} from '@dfai/domain';
import { VaultAccessError, type VaultFsPort } from '../vault/ports.ts';

/*
 * The prompt notes in `.atlas/prompts` (ADR-0021), as the Skills page lists
 * them beside the skills: ADR-0050 keeps them as they are, not migrated, so
 * the page only names them and offers to open each.
 */

/** A prompt note as listed: its name and where it is. */
export interface PromptNote {
  readonly name: string;
  readonly path: VaultEntry['path'];
}

/** By name as written, code unit by code unit: the same order on every Mac. */
const byName = (left: PromptNote, right: PromptNote) =>
  left.name === right.name ? 0 : left.name < right.name ? -1 : 1;

/**
 * Whether `.atlas` lists a `prompts` folder: a folder it lists that the host
 * then will not list is a failure, not a vault without prompts.
 */
async function promptsFolderListed(fs: Pick<VaultFsPort, 'listDirectory'>): Promise<boolean> {
  const folder = vaultPathName(createVaultPath(PROMPTS_DIRECTORY)).toLowerCase();
  try {
    const entries = await fs.listDirectory(createVaultPath(ATLAS_DIRECTORY));
    return entries.some(
      (entry) => entry.kind === 'directory' && entry.name.toLowerCase() === folder,
    );
  } catch (error) {
    // A vault with no `.atlas` has no prompts folder either.
    if (error instanceof VaultAccessError) return false;
    throw error;
  }
}

/** Every prompt note directly in `.atlas/prompts`, by name; none when there is no such folder. */
export async function listPromptNotes(
  fs: Pick<VaultFsPort, 'listDirectory'>,
): Promise<PromptNote[]> {
  let entries: readonly VaultEntry[];
  try {
    entries = await fs.listDirectory(createVaultPath(PROMPTS_DIRECTORY));
  } catch (error) {
    if (!(error instanceof VaultAccessError)) throw error;
    if (await promptsFolderListed(fs)) throw error;
    return [];
  }
  return entries
    .filter((entry) => entry.kind === 'file' && isPromptPath(entry.path))
    .map((entry) => ({ name: entry.name.replace(/\.md$/i, ''), path: entry.path }))
    .sort(byName);
}
