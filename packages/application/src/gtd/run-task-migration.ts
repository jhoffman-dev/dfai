import {
  joinVaultPath,
  mergedRecord,
  recordGoneOnFrom,
  MIGRATION_RECORD_PATH,
  migrationRecordText,
  parentVaultPath,
  splitFrontmatter,
  vaultPathName,
  type MigrationRecord,
  type RecordedFile,
  type VaultPath,
} from '@dfai/domain';
import { UNSAVED_TYPING } from '../automations/apply-changes.ts';
import type { Clock } from '../ports.ts';
import type { LinkUpdatePanes } from '../vault/update-links.ts';
import { ensureFolder } from '../vault/create-folder.ts';
import { EntryChangedError, type OpenEditorsPort, type VaultFsPort } from '../vault/ports.ts';
import { readMigrationRecord } from './migration-record-file.ts';
import {
  planTaskMigration,
  type FileCreation,
  type FileEdit,
  type TaskMigrationPorts,
  type TaskMigrationPreview,
} from './task-migration.ts';

/** The panes, so a note with unsaved typing is left alone and one shown is read again once written. */
export type MigrationPanes = Pick<OpenEditorsPort, 'state'> & Pick<LinkUpdatePanes, 'reload'>;

/** A file the migration, or its undo, left as it was, and why. */
export interface LeftFile {
  readonly path: VaultPath;
  readonly reason: string;
}

/** What a run did: each file written or added, and each left as it was. */
export interface TaskMigrationReport {
  readonly written: readonly VaultPath[];
  readonly left: readonly LeftFile[];
}

const reasonOf = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

/**
 * Carries out a previewed migration (ADR-0029), as one run that can be undone.
 *
 * What each file gets is worked out again from the files as they are now, with
 * the mapping the person saw, and only for the files the preview showed: a
 * task changed since keeps its change and is moved from where it now stands,
 * and one added since waits for the next preview. The record of every change
 * is written before any of them, so a run cut off partway can still be undone;
 * running again picks up what is left, and the one record covers both.
 *
 * Each file is written once, frontmatter only, through the host's refusal to
 * write over a file that changed after it was read. One that cannot be
 * written is reported and the rest carry on; a note with unsaved typing in a
 * pane is never written.
 */
export async function runTaskMigration({
  ports,
  panes,
  clock,
  preview,
}: {
  ports: TaskMigrationPorts;
  panes: MigrationPanes;
  clock: Pick<Clock, 'localNow'>;
  preview: TaskMigrationPreview;
}): Promise<TaskMigrationReport> {
  const plan = await planTaskMigration(ports, preview.mapping);
  const shown = previewedPaths(preview);
  const edits = plan.edits.filter((edit) => shown.has(edit.path));
  const creations = plan.creations.filter((creation) => shown.has(creation.path));
  if (edits.length + creations.length === 0) return { written: [], left: [] };

  await keepRecord(ports.fs, {
    at: clock.localNow(),
    files: [
      ...edits.map(({ path, before, after }): RecordedFile => ({
        kind: 'changed',
        path,
        before,
        after,
      })),
      ...creations.map(({ path, contents }): RecordedFile => ({ kind: 'created', path, contents })),
    ],
  });

  const written: VaultPath[] = [];
  const left: LeftFile[] = [];
  const outcome = (path: VaultPath, error: string | null) => {
    if (error === null) written.push(path);
    else left.push({ path, reason: error });
  };
  for (const edit of edits) outcome(edit.path, await writeEdit(ports.fs, panes, edit));
  for (const creation of creations) outcome(creation.path, await create(ports.fs, creation));
  try {
    await finishRecord(ports.fs, left);
  } catch (cause) {
    // The changes landed; only the note that the run finished did not, so the Inbox looks again.
    left.push({ path: MIGRATION_RECORD_PATH, reason: reasonOf(cause) });
  }
  return { written, left };
}

function previewedPaths(preview: TaskMigrationPreview): Set<VaultPath> {
  return new Set([
    ...(preview.type === null ? [] : [preview.type.path]),
    ...preview.tasks.map((task) => task.path),
    ...preview.references.map((reference) => reference.path),
    ...preview.views,
  ]);
}

/** Writes one edit; why it was not written, or null. */
async function writeEdit(
  fs: VaultFsPort,
  panes: MigrationPanes,
  { path, modified, after, body }: FileEdit,
): Promise<string | null> {
  if (panes.state(path) === 'dirty') return UNSAVED_TYPING;
  try {
    await fs.writeTextFile({ path, contents: after + body, expectedModified: modified });
  } catch (cause) {
    return reasonOf(cause);
  }
  if (panes.state(path) === 'clean') panes.reload(path);
  return null;
}

async function create(fs: VaultFsPort, { path, contents }: FileCreation): Promise<string | null> {
  try {
    const folder = await ensureFolder({ fs, folder: parentVaultPath(path) });
    await fs.createNote({ path: joinVaultPath(folder, vaultPathName(path)), contents });
    return null;
  } catch (cause) {
    return reasonOf(cause);
  }
}

/**
 * Writes the run's record before the run changes anything — added to the one
 * a run that is not over left, so one undo covers both; in place of one that
 * is over, so the later run's Undo takes back only what it did (#163) — see
 * {@link recordGoneOnFrom}. A record that cannot be read stops the run here:
 * running on would leave changes nothing records.
 */
async function keepRecord(fs: VaultFsPort, record: MigrationRecord): Promise<void> {
  const earlier = await readMigrationRecord(fs);
  const goneOnFrom = recordGoneOnFrom(earlier?.record ?? null);
  const contents = migrationRecordText(mergedRecord(goneOnFrom, record));
  if (earlier !== null) {
    await fs.writeTextFile({
      path: MIGRATION_RECORD_PATH,
      contents,
      expectedModified: earlier.modified,
    });
    return;
  }
  await ensureFolder({ fs, folder: parentVaultPath(MIGRATION_RECORD_PATH) });
  await fs.createNote({ path: MIGRATION_RECORD_PATH, contents });
}

/**
 * Marks the record finished once the run has tried every file, naming the
 * files it left: the Inbox's quick look reads this to know whether a run
 * still has work, rather than reading every task.
 */
async function finishRecord(fs: VaultFsPort, left: readonly LeftFile[]): Promise<void> {
  const kept = await readMigrationRecord(fs);
  if (kept === null) return;
  await fs.writeTextFile({
    path: MIGRATION_RECORD_PATH,
    contents: migrationRecordText({
      ...kept.record,
      finished: true,
      left: left.map((file) => file.path),
    }),
    expectedModified: kept.modified,
  });
}

/**
 * Ends the Inbox's offer to undo the move (#163), in the record, so neither a
 * restart nor the other Mac offers it again. The record stays: it still says
 * whether a run has work left. Nothing to do when there is no record.
 */
export async function dismissMigrationUndo(fs: VaultFsPort): Promise<void> {
  const kept = await readMigrationRecord(fs);
  if (kept === null || kept.record.undoDismissed === true) return;
  await fs.writeTextFile({
    path: MIGRATION_RECORD_PATH,
    contents: migrationRecordText({ ...kept.record, undoDismissed: true }),
    expectedModified: kept.modified,
  });
}

/** What an undo did: each file put back or taken away, and each left as it is. */
export interface TaskMigrationUndo {
  readonly restored: readonly VaultPath[];
  readonly left: readonly LeftFile[];
}

const CHANGED_SINCE = 'It has changed since the migration wrote it, so it was left as it is.';
const GONE = 'It is no longer there.';
const RECORD_CHANGED =
  'The migration’s record changed while it was being undone, so it was kept: run Undo again to see what is left.';

/**
 * Undoes the migration from its record: each file that still says what the
 * migration wrote gets back the exact frontmatter it had, its body as it is
 * now; each file the migration added goes to the Trash while it is still as
 * added. A file changed since is left and said so. Settles with null when
 * there is no migration to undo.
 *
 * The record goes once nothing is left that a second try could put back: a
 * file left for unsaved typing, or one the host would not write, keeps its
 * line so undo can be tried again; one changed since never will be.
 */
export async function undoTaskMigration({
  fs,
  panes,
}: {
  fs: VaultFsPort;
  panes: MigrationPanes;
}): Promise<TaskMigrationUndo | null> {
  const kept = await readMigrationRecord(fs);
  if (kept === null) return null;
  const restored: VaultPath[] = [];
  const left: LeftFile[] = [];
  const retry: RecordedFile[] = [];
  for (const file of kept.record.files) {
    const outcome = await undoFile(fs, panes, file);
    if (outcome === 'restored') restored.push(file.path);
    else if (outcome !== 'unchanged') left.push({ path: file.path, reason: outcome.reason });
    if (outcome !== 'restored' && outcome !== 'unchanged' && outcome.retry) retry.push(file);
  }
  const record = { path: MIGRATION_RECORD_PATH, modified: kept.modified, text: kept.text };
  if (retry.length === 0) {
    try {
      // Held to the record as read: one a second run rewrote meanwhile is kept (#694).
      await fs.trashEntry({ path: MIGRATION_RECORD_PATH, unchanged: [record] });
    } catch (cause) {
      if (!(cause instanceof EntryChangedError)) throw cause;
      left.push({ path: MIGRATION_RECORD_PATH, reason: RECORD_CHANGED });
    }
  } else {
    await fs.writeTextFile({
      path: MIGRATION_RECORD_PATH,
      contents: migrationRecordText({ ...kept.record, files: retry, undoUnfinished: true }),
      expectedModified: kept.modified,
      expectedText: kept.text,
    });
  }
  return { restored, left };
}

type UndoOutcome = 'restored' | 'unchanged' | { reason: string; retry: boolean };

async function undoFile(
  fs: VaultFsPort,
  panes: MigrationPanes,
  file: RecordedFile,
): Promise<UndoOutcome> {
  if (panes.state(file.path) === 'dirty') return { reason: UNSAVED_TYPING, retry: true };
  let current;
  try {
    current = await fs.readTextFile(file.path);
  } catch {
    // Read failing is the file being gone, as far as putting it back goes.
    return file.kind === 'created' ? 'unchanged' : { reason: GONE, retry: false };
  }
  try {
    if (file.kind === 'created') {
      if (current.text !== file.contents) return { reason: CHANGED_SINCE, retry: false };
      // Held to the read just checked, so an edit landing before the Trash keeps the file (#694).
      await fs.trashEntry({
        path: file.path,
        unchanged: [{ path: file.path, modified: current.modified, text: current.text }],
      });
      return 'restored';
    }
    const { frontmatter, body } = splitFrontmatter(current.text);
    if (frontmatter === file.before) return 'unchanged';
    if (frontmatter !== file.after) return { reason: CHANGED_SINCE, retry: false };
    await fs.writeTextFile({
      path: file.path,
      contents: file.before + body,
      expectedModified: current.modified,
    });
  } catch (cause) {
    if (cause instanceof EntryChangedError) return { reason: CHANGED_SINCE, retry: false };
    return { reason: reasonOf(cause), retry: true };
  }
  if (panes.state(file.path) === 'clean') panes.reload(file.path);
  return 'restored';
}
