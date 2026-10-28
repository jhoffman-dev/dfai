import {
  createVaultPath,
  excludesText,
  LARGE_FILE_BYTES,
  leftOutWarnings,
  macOfCommit,
  parseOmittedObjects,
  syncActivityMessage,
  syncCommitMessage,
  type ConflictCopy,
  type LeftOut,
  type SyncReport,
} from '@dfai/domain';
import type { ActivityRecorder } from '../activity/ports.ts';
import type { MarkdownPort } from '../notes/ports.ts';
import type { Clock } from '../ports.ts';
import type { VaultFsPort } from '../vault/ports.ts';
import { followCaseRenames, moveCaseCollisionsAside } from './case-steps.ts';
import {
  blobOf,
  commitAll,
  commitAs,
  commitStaged,
  currentBranch,
  expectOk,
  identityFor,
  readIndex,
  readStatus,
  stageAll,
  SyncError,
  withPrograms,
} from './git-steps.ts';
import { clearSettledCopies } from './clear-settled-copies.ts';
import { leaveOut } from './leave-out.ts';
import type { GitPort, SyncFilesPort, UnsavedWorkPort } from './ports.ts';
import { clearJournal, readJournal } from './journal.ts';
import { mergeHeadOf, recordMerge, settleConflicts } from './settle-conflicts.ts';

export interface SyncPorts {
  readonly git: GitPort;
  /**
   * To measure files, for what is too large to sync, to make a folder a copy
   * goes in, to write a settings file both Macs changed merged by its keys,
   * and to move a copy that holds nothing more to the Trash.
   */
  readonly fs: Pick<
    VaultFsPort,
    'listDirectory' | 'createFolder' | 'readTextFile' | 'writeTextFile' | 'trashEntry'
  >;
  /** To read and write the frontmatter of a settings file both Macs changed. */
  readonly markdown: MarkdownPort;
  /** The journal and the excludes, in the vault's `.git/atlas-sync/`. */
  readonly files: SyncFilesPort;
  readonly unsaved: UnsavedWorkPort;
  readonly activity: ActivityRecorder;
}

/**
 * Syncs the vault with its GitHub repository (U-29): writes any unsaved
 * typing, commits this Mac's changes, fetches, merges the other Macs' in —
 * settling any file both changed so no note is ever left with conflict
 * markers — and pushes. Ordinary merges only: nothing is rebased, and no
 * history that reached GitHub is rewritten. Each sync, and any failure,
 * goes in the Activity log.
 */
export async function syncNow({
  ports,
  mac,
  clock,
}: {
  ports: SyncPorts;
  mac: string;
  clock: Pick<Clock, 'now' | 'localNow'>;
}): Promise<SyncReport> {
  try {
    const report = await withPrograms(() => runSync({ ports, mac, clock }));
    recordReport(ports.activity, report);
    return report;
  } catch (cause) {
    ports.activity.record({
      level: 'error',
      kind: 'sync',
      message: `Sync failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      subject: null,
    });
    throw cause;
  }
}

interface SyncStep {
  readonly git: GitPort;
  readonly fs: SyncPorts['fs'];
  readonly markdown: MarkdownPort;
  readonly files: SyncFilesPort;
  readonly activity: ActivityRecorder;
  readonly mac: string;
  readonly branch: string;
  readonly message: string;
  readonly leftOut: LeftOut;
}

async function runSync({
  ports: { git, fs, files, unsaved, activity, markdown },
  mac,
  clock,
}: {
  ports: SyncPorts;
  mac: string;
  clock: Pick<Clock, 'now' | 'localNow'>;
}): Promise<SyncReport> {
  await unsaved.flushAll();
  const branch = await currentBranch(git);
  const { leftOut, newly, ignored } = await leaveOut({ git, fs, files });
  warn(activity, leftOutWarnings(newly));
  const message = syncCommitMessage({ mac, localNow: clock.localNow() });
  const step: SyncStep = { git, fs, markdown, files, activity, mac, branch, leftOut, message };
  const leftover = await concludeLeftoverMerge(step);
  await followCaseRenames(git, await readStatus(git));
  const committed = (await commitAll({ git, mac, message, leftOut })) || leftover;
  expectOk('fetch from GitHub', await git.fetch());
  const pulled = await mergeFromOrigin(step);
  const cleared = await clearCopiesThatAddNothing(step);
  const tooLarge = await leaveOutOfUnpushedHistory(step);
  const after = await readStatus(git);
  // Without a comparison the upstream is not on GitHub yet, so nothing here is either.
  const pushed = after.upstream === null || !after.compared || after.ahead > 0;
  if (pushed) expectOk('push to GitHub', await git.push());
  const conflicts = await copiesToReport(git, files);
  await clearJournal(files);
  return {
    at: clock.now(),
    committed: committed || cleared,
    pulled,
    pushed,
    conflicts,
    notSynced: [...new Set([...leftOut.nested, ...leftOut.large, ...tooLarge])],
    ignored,
  };
}

/**
 * Every copy the journal holds that is in the vault: made by this sync, or
 * by one the app quit before it could say so (review A29-01). A copy that
 * was noted but never made — its merge given up by hand — is not.
 */
async function copiesToReport(
  git: GitPort,
  files: SyncFilesPort,
): Promise<readonly ConflictCopy[]> {
  const { unreported } = await readJournal(files);
  const made: ConflictCopy[] = [];
  for (const copy of unreported) {
    if ((await blobOf(git, copy.copy)) !== null) made.push(copy);
  }
  return made;
}

/**
 * Finishes a merge an earlier sync left part-way — the app quit, or a step
 * failed: settles any file still in conflict from the journal, then commits
 * the merge, which otherwise refuses every merge after it. Says whether it
 * committed.
 */
async function concludeLeftoverMerge(step: SyncStep): Promise<boolean> {
  const { git, files, mac, branch, message, leftOut } = step;
  const { conflicts } = await readStatus(git);
  if (conflicts.length > 0) {
    const from = await otherMac(git, branch);
    await settleConflicts({
      git,
      files,
      conflicts,
      mac: from,
      leftOut,
      settings: settingsOf(step),
    });
  }
  const waiting = (await mergeHeadOf(git)) !== null;
  if (waiting) await commitStaged({ git, mac, message });
  return waiting;
}

/**
 * Merges `origin/<branch>` when there is one, settling any conflicts; says
 * whether anything came in. This Mac's files whose names differ only in
 * case from the other Macs' are moved aside first, so the merge writes
 * neither over the other on a disk that does not tell them apart.
 */
async function mergeFromOrigin(step: SyncStep): Promise<boolean> {
  const { git, fs, files, mac, branch, message, leftOut } = step;
  if ((await git.remoteBranchExists(branch)).code !== 0) return false;
  const status = await readStatus(git);
  // Nothing new from the other Macs: nothing to merge, and no names to compare.
  if (status.compared && status.behind === 0) return false;
  const aside = status.born
    ? await moveCaseCollisionsAside({ git, fs, files, branch, mac, untracked: status.untracked })
    : [];
  // One author for every commit this merge makes: the case moves, the merge, its conclusion.
  const identity = await identityFor(git, mac);
  if (aside.length > 0) await commitAs({ git, message, identity });
  const headBefore = (await git.head()).stdout;
  const merge = await git.merge({ branch, identity });
  if (merge.code === 0) return (await git.head()).stdout !== headBefore;
  const { conflicts } = await readStatus(git);
  // A merge that stopped for another reason is not one to settle by guessing.
  if (conflicts.length === 0) expectOk('merge the other Macs’ changes', merge);
  await recordMerge({ git, files, conflicts });
  const from = await otherMac(git, branch);
  await settleConflicts({ git, files, conflicts, mac: from, leftOut, settings: settingsOf(step) });
  await commitAs({ git, message, identity });
  return true;
}

/**
 * Clears the `.atlas` conflict copies whose live file, as this sync's merge
 * left it, already holds everything in them (#235), then commits their
 * removal so it goes out with this push. Copies this sync made are kept: it
 * is about to report them. Says whether it committed.
 */
async function clearCopiesThatAddNothing(step: SyncStep): Promise<boolean> {
  const { git, fs, markdown, files, activity, mac, message, leftOut } = step;
  const { unreported } = await readJournal(files);
  const cleared = await clearSettledCopies({
    ports: { git, fs, markdown, activity },
    keep: new Set(unreported.map(({ copy }) => copy)),
  });
  return cleared.length > 0 && (await commitAll({ git, mac, message, leftOut }));
}

/**
 * A file over GitHub's limit in commits not pushed yet — made before DFAI
 * kept such files out, or by hand — would have every push refused. Those
 * commits are folded into one without it; nothing that reached GitHub is
 * touched, and the file stays on this Mac (A29-01). Says which files.
 */
async function leaveOutOfUnpushedHistory(step: SyncStep): Promise<readonly string[]> {
  const { git, mac, branch, message, leftOut } = step;
  // A branch with no commit yet has no history to hold one.
  if ((await git.head()).code !== 0) return [];
  const listed = await git.largeUnpushed(LARGE_FILE_BYTES);
  const large = parseOmittedObjects(expectOk('look for files too large to push', listed));
  if (large.size === 0) return [];
  if ((await git.remoteBranchExists(branch)).code !== 0) {
    throw new SyncError(
      'A file in this vault’s history is over GitHub’s 100 MB limit, and nothing has been sent to GitHub yet to go back to. Remove it from the vault’s history in Terminal, then sync again.',
    );
  }
  expectOk('fold the unsent changes together', await git.resetSoftTo(branch));
  const paths = (await readIndex(git)).filter(({ oid }) => large.has(oid)).map(({ path }) => path);
  const without = { ...leftOut, large: [...new Set([...leftOut.large, ...paths])] };
  // Kept out of the next `add` too, and said once, as any file left out is.
  await step.files.write('exclude', excludesText(without));
  warn(step.activity, leftOutWarnings({ large: paths, nested: [] }));
  await stageAll({ git, leftOut: without });
  await commitStaged({ git, mac, message });
  return paths;
}

const settingsOf = ({ fs, markdown }: SyncStep) => ({ vault: fs, markdown });

/**
 * The Mac the other side of a merge came from, which a conflict copy is named
 * for: read from its last commit, or "another Mac" when DFAI did not make it.
 */
async function otherMac(git: GitPort, branch: string): Promise<string> {
  const subject = await git.remoteSubject(branch);
  return (subject.code === 0 ? macOfCommit(subject.stdout) : null) ?? 'another Mac';
}

function warn(activity: ActivityRecorder, warnings: readonly string[]): void {
  for (const message of warnings) {
    activity.record({ level: 'warning', kind: 'sync', message, subject: null });
  }
}

function recordReport(activity: ActivityRecorder, report: SyncReport): void {
  activity.record({
    level: report.conflicts.length > 0 ? 'warning' : 'info',
    kind: 'sync',
    message: syncActivityMessage(report),
    subject: null,
  });
  for (const { path, copy, whose } of report.conflicts) {
    activity.record({
      level: 'warning',
      kind: 'sync',
      message:
        whose === 'theirs'
          ? `Both Macs changed ${path}. This Mac’s version was kept; the other is saved as ${copy}.`
          : `Another Mac made ${path} under a name that differs from this Mac’s only in case. The other Mac’s keeps the name; this Mac’s is saved as ${copy}.`,
      subject: noteSubject(copy),
    });
  }
}

/**
 * A note's copy opens from its line; an image or a PDF has no page to open,
 * nor has a name the vault's paths cannot spell (one with a backslash).
 */
function noteSubject(
  copy: string,
): { kind: 'note'; path: ReturnType<typeof createVaultPath> } | null {
  if (!copy.endsWith('.md') || copy.includes('\\')) return null;
  return { kind: 'note', path: createVaultPath(copy) };
}
