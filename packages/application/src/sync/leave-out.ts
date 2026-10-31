import {
  ATLAS_DIRECTORY,
  atlasPathsIgnored,
  createVaultPath,
  excludesText,
  largeFiles,
  nestedRepositories,
  newlyLeftOut,
  parentVaultPath,
  parseExcludes,
  type LeftOut,
} from '@dfai/domain';
import type { VaultFsPort } from '../vault/ports.ts';
import { readIndex, readStatus } from './git-steps.ts';
import type { GitPort, SyncFilesPort } from './ports.ts';

type Fs = Pick<VaultFsPort, 'listDirectory'>;

/**
 * Decides, afresh each sync, what is left out of it on this Mac (A29-01):
 * files over GitHub's limit and folders that are repositories of their own,
 * written to the vault's excludes file before anything is staged. The file
 * is cleared first, so git shows everything again: a file made smaller, or a
 * folder that is no longer a repository, syncs once more.
 */
export async function leaveOut({
  git,
  fs,
  files,
}: {
  git: GitPort;
  fs: Fs;
  files: SyncFilesPort;
}): Promise<{ leftOut: LeftOut; newly: LeftOut; ignored: readonly string[] }> {
  const before = parseExcludes(await files.read('exclude'));
  await files.write('exclude', null);
  const status = await readStatus(git);
  const nested = nestedRepositories(status.untracked);
  const candidates = status.changed.filter((path) => !path.endsWith('/'));
  const leftOut = { large: largeFiles(await sizesOf(fs, candidates)), nested };
  if (leftOut.large.length > 0 || leftOut.nested.length > 0) {
    await files.write('exclude', excludesText(leftOut));
  }
  const ignored = await atlasIgnored({ git, fs, untracked: status.untracked });
  return { leftOut, newly: newlyLeftOut({ before, now: leftOut }), ignored };
}

/**
 * DFAI's own files the vault's `.gitignore` keeps out (issue #8): in
 * `.atlas` on disk, and neither tracked nor listed by git as untracked.
 * Read with DFAI's excludes cleared, so only the person's lines count.
 */
async function atlasIgnored({
  git,
  fs,
  untracked,
}: {
  git: GitPort;
  fs: Fs;
  untracked: readonly string[];
}): Promise<readonly string[]> {
  const onDisk = await filesUnder(fs, ATLAS_DIRECTORY, 0);
  if (onDisk.length === 0) return [];
  const inGit = new Set([...untracked, ...(await readIndex(git)).map(({ path }) => path)]);
  return atlasPathsIgnored({ onDisk, inGit });
}

/** How deep `.atlas` is walked: far past any folder DFAI makes, and short of a link to a folder above. */
const MAX_ATLAS_DEPTH = 8;

/**
 * Every file under a folder, as the host lists them; a folder that cannot be
 * listed holds none. A link is one entry, as git tracks it, never walked into
 * (#169): what is listed through it is never a path git could hold.
 */
async function filesUnder(fs: Fs, folder: string, depth: number): Promise<string[]> {
  if (depth > MAX_ATLAS_DEPTH) return [];
  const found: string[] = [];
  for (const entry of await listed(fs, folder)) {
    if (entry.kind === 'file' || entry.link === true) found.push(entry.path);
    else found.push(...(await filesUnder(fs, entry.path, depth + 1)));
  }
  return found;
}

/** Each file's size, as the host lists its folder; a file that cannot be listed is left out of the answer. */
async function sizesOf(fs: Fs, paths: readonly string[]): Promise<ReadonlyMap<string, number>> {
  const sizes = new Map<string, number>();
  const byFolder = new Map<string, Set<string>>();
  for (const path of paths) {
    const folder = folderOf(path);
    if (folder === null) continue;
    byFolder.set(folder, (byFolder.get(folder) ?? new Set()).add(path));
  }
  for (const [folder, wanted] of byFolder) {
    for (const entry of await listed(fs, folder)) {
      if (entry.kind === 'file' && wanted.has(entry.path) && entry.size !== undefined) {
        sizes.set(entry.path, entry.size);
      }
    }
  }
  return sizes;
}

/** The folder a path is in, as a vault path; null for a name the vault's paths cannot spell. */
function folderOf(path: string): string | null {
  try {
    return parentVaultPath(createVaultPath(path));
  } catch {
    // A name with a backslash has no vault path: its size is not asked, and
    // a file of that name is never taken for one too large.
    return null;
  }
}

async function listed(fs: Fs, folder: string) {
  try {
    return await fs.listDirectory(createVaultPath(folder));
  } catch {
    // A folder gone since git listed it holds nothing to measure.
    return [];
  }
}
