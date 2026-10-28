import { createVaultPath, settingsFileOfCopy } from '@dfai/domain';
import type { ActivityRecorder } from '../activity/ports.ts';
import type { MarkdownPort } from '../notes/ports.ts';
import type { NoteContents, VaultFsPort } from '../vault/ports.ts';
import { readIndex } from './git-steps.ts';
import { mergeSettings } from './merge-settings.ts';
import type { GitPort } from './ports.ts';

/** What clearing the copies needs: the tracked paths, the vault's files and the Trash, frontmatter, and Activity. */
export interface ClearCopiesPorts {
  readonly git: Pick<GitPort, 'indexEntries'>;
  readonly fs: Pick<VaultFsPort, 'readTextFile' | 'trashEntry'>;
  readonly markdown: MarkdownPort;
  readonly activity: ActivityRecorder;
}

/**
 * Moves to the Trash each conflict copy of one of DFAI's own files, under
 * `Sync conflicts/atlas/`, that holds nothing its live file lacks (#235,
 * ADR-0048): the live file merged with the copy by its keys, as sync merges
 * the two Macs' versions, with no base, comes back byte for byte as it is.
 * A copy that cannot be read, nor its live file, or that either changes
 * while it is checked, stays. So does one in `keep` — made by this sync, and
 * about to be reported. Says each copy cleared in Activity; gives them back.
 */
export async function clearSettledCopies({
  ports,
  keep,
}: {
  ports: ClearCopiesPorts;
  keep: ReadonlySet<string>;
}): Promise<readonly string[]> {
  const cleared: string[] = [];
  for (const { path: copy, stage } of await readIndex(ports.git)) {
    const live = settingsFileOfCopy(copy);
    if (stage !== 0 || live === null || keep.has(copy)) continue;
    if (!(await holdsNothingMore(ports, { copy, live }))) continue;
    if (await trash(ports, { copy, live })) cleared.push(copy);
  }
  return cleared;
}

interface CopyOf {
  readonly copy: string;
  readonly live: string;
}

/** Whether the live file already holds everything in the copy, both read twice to the same bytes and time. */
async function holdsNothingMore(
  { fs, markdown }: ClearCopiesPorts,
  { copy, live }: CopyOf,
): Promise<boolean> {
  const first = await readBoth(fs, { copy, live });
  if (first === null) return false;
  const merged = mergeSettings(markdown, {
    path: live,
    base: null,
    ours: first.live.text,
    theirs: first.copy.text,
  });
  if (merged !== first.live.text) return false;
  // Read again: a write to either since the first read is one this check has not seen.
  const again = await readBoth(fs, { copy, live });
  return again !== null && same(first.copy, again.copy) && same(first.live, again.live);
}

async function readBoth(
  fs: ClearCopiesPorts['fs'],
  { copy, live }: CopyOf,
): Promise<{ copy: NoteContents; live: NoteContents } | null> {
  try {
    const [copyRead, liveRead] = await Promise.all([
      fs.readTextFile(createVaultPath(copy)),
      fs.readTextFile(createVaultPath(live)),
    ]);
    return { copy: copyRead, live: liveRead };
  } catch {
    // Safe to ignore: a file that cannot be read whole — missing, refused, not
    // text — cannot be shown to hold nothing more, so the copy stays for a person.
    return null;
  }
}

const same = (first: NoteContents, second: NoteContents) =>
  first.text === second.text && first.modified === second.modified;

/** Moves the copy to the Trash and says so; a Trash that refuses is said as a warning, and the copy stays. */
async function trash({ fs, activity }: ClearCopiesPorts, { copy, live }: CopyOf): Promise<boolean> {
  try {
    await fs.trashEntry({ path: createVaultPath(copy) });
  } catch (cause) {
    activity.record({
      level: 'warning',
      kind: 'sync',
      message: `The conflict copy ${copy} holds nothing ${live} lacks, but it could not be moved to the Trash: ${cause instanceof Error ? cause.message : String(cause)}`,
      subject: null,
    });
    return false;
  }
  activity.record({
    level: 'info',
    kind: 'sync',
    message: `Cleared the conflict copy ${copy}: ${live} already holds everything in it. It is in the Trash.`,
    subject: null,
  });
  return true;
}
