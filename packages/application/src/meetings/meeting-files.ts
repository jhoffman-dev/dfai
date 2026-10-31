import {
  compileMeetingHoldersQuery,
  createVaultPath,
  DUPLICATE_OF_KEY,
  duplicateLink,
  IMPORT_ERROR_KEY,
  IMPORT_OUTCOME_KEY,
  isConflictCopyPath,
  meetingHolding,
  messageWithoutPaths,
  sameMeetingIdentity,
  splitFrontmatter,
  type MeetingIdentity,
  type MeetingImportHappening,
  type VaultPath,
  type Vocabulary,
} from '@dfai/domain';
import { archiveNotes, type ArchivePorts } from '../archive/archive-notes.ts';
import type { ActivityRecorder } from '../activity/ports.ts';
import { loadTerms } from '../terms/terms.ts';
import { correctedMeeting } from './meeting-corrections.ts';
import { readFrontmatter } from './meeting-reading.ts';
import { UNSAVED, writeStamp } from './meeting-stamp-writer.ts';

/** One run of the import, and what it has done so far. */
export interface ImportContext {
  readonly ports: ArchivePorts;
  /** The day a copy is archived on, `YYYY-MM-DD`. */
  readonly today: string;
  readonly activity: ActivityRecorder;
  /** Files this run has settled, which are not looked at again when their own turn comes. */
  readonly settled: Set<string>;
  /** The files this run was handed to look at: a sync's news, or the folder as catching up listed it. */
  readonly listed: readonly string[];
  /** The meeting each listed file's own keys name, read once a run; null for a file that names none. */
  listedMeetings: ReadonlyMap<string, MeetingIdentity | null> | null;
  /** Every note in the vault, read from the index once a run: what an archived copy's name is checked against. */
  notePaths: readonly VaultPath[] | null;
  /** Whether a note was written or moved. */
  wrote: boolean;
  /** Done to a meeting before it is let in: see `MeetingImportRun.beforeLetIn`. */
  readonly beforeLetIn?: BeforeLetIn;
  /** The spellings a meeting let in is corrected by, read from the index once a run. */
  vocabulary: Vocabulary | null;
  /** Asked right before each file's writes: see `MayWriteMeeting`. Left out, every write may go ahead. */
  readonly mayWrite?: MayWriteMeeting;
  /** When each file was last modified as this run first read it: what gate 1 judges it by. */
  readonly arrived: Map<string, number>;
}

/**
 * Whether the import may write into a file now (ADR-0035 part 4), asked
 * right before its first write and again before its stamp, with when the
 * file was last modified as the run first read it — so the run's own writes
 * before the stamp do not count against it. False holds the file, unwritten
 * and unsaid, for the catch-up after the next pull.
 */
export type MayWriteMeeting = (path: VaultPath, arrivedAt: number) => Promise<boolean>;

/**
 * Whether the run may write into a file now. A file this run has not read
 * yet — another holder of a meeting — is read for when it was last modified,
 * and that is what it is judged by from then on.
 */
export async function mayWriteInto(context: ImportContext, path: VaultPath): Promise<boolean> {
  if (context.mayWrite === undefined) return true;
  let arrivedAt = context.arrived.get(path);
  if (arrivedAt === undefined) {
    arrivedAt = (await context.ports.fs.readTextFile(path)).modified;
    context.arrived.set(path, arrivedAt);
  }
  return context.mayWrite(path, arrivedAt);
}

/**
 * Done to a meeting just before it is stamped, with what the run has read
 * for it. `vault-changed` says the vault the run is for is no longer the one
 * open: the meeting is then left unstamped, to be let in when it is next
 * looked at. A `stamp` is more for the stamp write to carry: the mark of a
 * meeting whose linking failed (#192).
 */
export type BeforeLetIn = (
  path: VaultPath,
  reading: { readonly vocabulary: Vocabulary },
) => Promise<void | 'vault-changed' | LetInStamp>;

/** What a meeting's stamp write carries besides the stamp, from what was done before it. */
export interface LetInStamp {
  readonly stamp: Readonly<Record<string, unknown>>;
}

/** Why a meeting was not let in once its vault was no longer the one open. */
export const VAULT_CHANGED =
  'Another vault was opened before it was let in; it is let in when this vault is next open.';

/** The notes holding a meeting now, and which of them the import has already let in. */
export interface Holders {
  readonly unsettled: readonly string[];
  readonly imported: readonly string[];
}

/** What finding a meeting's holders reads: the index, to know where to look, and the notes themselves. */
export type HolderPorts = Pick<ArchivePorts, 'fs' | 'markdown' | 'index'>;

/**
 * The other notes that hold a meeting now, as the import counts them (see
 * {@link meetingHoldersIn}), leaving out the file being settled and any this
 * run has settled already.
 */
export async function meetingHolders(
  context: ImportContext,
  { meeting, besides }: { meeting: MeetingIdentity; besides: string },
): Promise<Holders> {
  return meetingHoldersIn(context.ports, {
    meeting,
    skip: (holder) => holder === besides || context.settled.has(holder),
    also: await listedHolding(context, meeting),
  });
}

/**
 * The files of this run's own listing whose keys name the meeting. The index
 * is behind the folder after a pull — it may have read none of them — so two
 * files of one meeting waiting together are found in the listing itself, or
 * each would be let in as the only one. Like the index, this only says where
 * to look: each is read again by {@link holdingAt}.
 */
async function listedHolding(context: ImportContext, meeting: MeetingIdentity): Promise<string[]> {
  context.listedMeetings ??= new Map(
    await Promise.all(
      context.listed.map(
        async (path) => [path, await meetingNamedAt(context.ports, path)] as const,
      ),
    ),
  );
  return [...context.listedMeetings]
    .filter(([, named]) => named !== null && sameMeetingIdentity(named, meeting))
    .map(([path]) => path);
}

/** The provider and id a file's frontmatter gives, whatever else it holds; null when it cannot be read or gives neither. */
async function meetingNamedAt(
  { fs, markdown }: Pick<HolderPorts, 'fs' | 'markdown'>,
  path: string,
): Promise<MeetingIdentity | null> {
  try {
    const { text } = await fs.readTextFile(createVaultPath(path));
    const { properties } = readFrontmatter(markdown, splitFrontmatter(text).frontmatter);
    const { provider, external_id: externalId } = properties;
    return typeof provider === 'string' && typeof externalId === 'string'
      ? { provider, externalId }
      : null;
  } catch {
    // Gone since it was listed: it names nothing, and its own turn finds that out.
    return null;
  }
}

/**
 * The notes that hold a meeting now: the index names the notes that held its
 * provider + external_id when it last read them, and each is read again,
 * since the index is behind what the import writes and moves. One stamped
 * `imported` holds it whatever else it says — the person may have added to it
 * since. One not stamped holds it when it follows the contract. One stamped
 * `duplicate` or `error`, and a sync conflict's copy, holds nothing. Ids are
 * compared without the spaces around them, as the index keeps them. A note
 * `skip` names is not read. `also` names notes to read beside the index's:
 * where else the caller knows to look.
 */
export async function meetingHoldersIn(
  ports: HolderPorts,
  {
    meeting,
    skip,
    also = [],
  }: { meeting: MeetingIdentity; skip: (holder: string) => boolean; also?: readonly string[] },
): Promise<Holders> {
  const { sql, parameters } = compileMeetingHoldersQuery({
    provider: meeting.provider,
    externalId: meeting.externalId,
  });
  const found = await ports.index.query(sql, parameters);
  const unsettled: string[] = [];
  const imported: string[] = [];
  for (const holder of new Set([...found.rows.map((row) => String(row[0])), ...also])) {
    if (skip(holder) || isConflictCopyPath(holder)) continue;
    const held = await holdingAt(ports, { holder, meeting });
    if (held === 'imported') imported.push(holder);
    else if (held === 'unsettled') unsettled.push(holder);
  }
  return { unsettled, imported };
}

/** Whether a note holds the meeting now, and whether the import has let it in; null when it does not hold it. */
export async function holdingAt(
  { fs, markdown }: Pick<HolderPorts, 'fs' | 'markdown'>,
  { holder, meeting }: { holder: string; meeting: MeetingIdentity },
): Promise<'imported' | 'unsettled' | null> {
  let text: string;
  try {
    ({ text } = await fs.readTextFile(createVaultPath(holder)));
  } catch {
    // Gone since the index read it — moved or deleted: it holds nothing here now.
    return null;
  }
  return meetingHolding({
    text,
    readFrontmatter: (frontmatter) => readFrontmatter(markdown, frontmatter),
    meeting,
  });
}

/**
 * Lets a meeting in, as one sequence that ends at the stamp: the run's
 * `beforeLetIn` first (its people linked, P29-04), then one write that stamps
 * it `imported`, takes out any import error it carried from before it was
 * fixed, and corrects its words by the vocabulary (P28-06). Nothing is
 * written after, so the version that carries the stamp — the one a rule
 * hears as the meeting's arrival (#92) — is the meeting as it stays: linked
 * and corrected. A file being typed in is left as it
 * is, and said so; it is let in when it next changes, or when the import
 * next looks over every arrival. So is one whose vault stopped being the one
 * open while `beforeLetIn` ran: what it did, it did nothing or only in part,
 * and a stamp would say the meeting is as it stays.
 *
 * The run's vocabulary is read before `beforeLetIn` and handed to it, so the
 * speakers are read by the same spellings the stamp write corrects by.
 *
 * Null when the gates shut before `beforeLetIn` or before the stamp
 * (`mayWriteInto`): the meeting is left unstamped, and unsaid, for the next pull.
 */
export async function letIn(
  context: ImportContext,
  path: VaultPath,
): Promise<MeetingImportHappening | null> {
  if (!(await mayWriteInto(context, path))) return null;
  const vocabulary = await importVocabulary(context);
  // Before the read, so the file is read as it will be stamped: the follow-up may have written to it.
  const went = await context.beforeLetIn?.(path, { vocabulary });
  if (went === 'vault-changed') {
    context.settled.add(path);
    return { kind: 'failed', path, problem: VAULT_CHANGED };
  }
  const { text, modified } = await context.ports.fs.readTextFile(path);
  const { properties } = readFrontmatter(
    context.ports.markdown,
    splitFrontmatter(text).frontmatter,
  );
  const fixed = Object.hasOwn(properties, IMPORT_ERROR_KEY);
  const corrected = correctedMeeting({
    markdown: context.ports.markdown,
    text,
    vocabulary,
  });
  // Asked again: the follow-up may have taken long enough for a sleep, or a pull to start.
  if (!(await mayWriteInto(context, path))) return null;
  const unsaved = await writeInto(context, {
    path,
    modified,
    values: {
      ...(typeof went === 'object' && went.stamp),
      [IMPORT_OUTCOME_KEY]: 'imported',
      ...(fixed && { [IMPORT_ERROR_KEY]: null }),
      ...corrected?.values,
    },
    ...(corrected !== null && corrected.count > 0 && { body: corrected.body }),
  });
  context.settled.add(path);
  if (unsaved !== null) return { kind: 'failed', path, problem: unsaved };
  const corrections =
    corrected === null || corrected.count === 0 ? {} : { corrected: corrected.count };
  return { kind: fixed ? 'fixed' : 'arrived', path, ...corrections };
}

/** The vocabulary a run corrects meetings by, read from the index the first time a meeting is let in. */
async function importVocabulary(context: ImportContext): Promise<Vocabulary> {
  context.vocabulary ??= (await loadTerms({ index: context.ports.index })).vocabulary;
  return context.vocabulary;
}

/**
 * Archives a copy, then marks it where it landed: stamped `duplicate`,
 * `atlas_duplicate_of` its original, any import error it carried taken out.
 *
 * The move comes first so a copy is never left in the Inbox stamped as
 * settled: one whose move fails stays unstamped, and is archived when it is
 * next looked at. A `duplicate` stamp under `Inbox/Meetings/` then only ever
 * means the person brought the copy back, and it is left alone. A copy
 * being typed in is not moved, and said so. Null when the gates are shut
 * (`mayWriteInto`): the copy is left where it is, and unsaid, for the next
 * pull. Once moved it is marked: the mark finishes the move, and a copy
 * moved but unmarked would be met by no later look.
 */
export async function archiveCopy(
  context: ImportContext,
  { path, original }: { path: VaultPath; original: VaultPath },
): Promise<MeetingImportHappening | null> {
  if (!(await mayWriteInto(context, path))) return null;
  context.settled.add(path);
  if (context.ports.editors.state(path) === 'dirty') {
    return { kind: 'failed', path, problem: UNSAVED };
  }
  const notePaths = await everyNote(context);
  const outcome = await archiveNotes({
    ports: context.ports,
    paths: [path],
    notePaths,
    today: context.today,
    // The import is not the person: it never saves what someone is typing.
    unsavedTyping: 'leave',
  });
  const archivedTo = outcome.moves[0]?.move.to ?? null;
  const reasons = outcome.failed.map((failure) => failure.reason);
  if (archivedTo === null) {
    return { kind: 'duplicate', path, of: original, archivedTo, problem: reasons.join(' ') };
  }
  context.wrote = true;
  const marked = await markCopy(context, { path: archivedTo, original }).catch(
    (cause: unknown) => `Archived, but not marked as a copy: ${messageWithoutPaths(cause)}`,
  );
  const problems = [...reasons, ...(marked === null ? [] : [marked])];
  const problem = problems.length === 0 ? null : problems.join(' ');
  return { kind: 'duplicate', path, of: original, archivedTo, problem };
}

/** Writes a copy's stamp and its link to the original; why not, when it could not be. */
async function markCopy(
  context: ImportContext,
  { path, original }: { path: VaultPath; original: VaultPath },
): Promise<string | null> {
  const { text, modified } = await context.ports.fs.readTextFile(path);
  const { properties } = readFrontmatter(
    context.ports.markdown,
    splitFrontmatter(text).frontmatter,
  );
  return writeInto(context, {
    path,
    modified,
    values: {
      [IMPORT_OUTCOME_KEY]: 'duplicate',
      ...(Object.hasOwn(properties, IMPORT_ERROR_KEY) && { [IMPORT_ERROR_KEY]: null }),
      [DUPLICATE_OF_KEY]: duplicateLink(original),
    },
  });
}

/**
 * Every note in the vault, read from the index once a run. A copy archives to
 * its own path under `Archive/`, so the moves of one run never take each
 * other's place, and what the index read is enough to number around.
 */
async function everyNote(context: ImportContext): Promise<readonly VaultPath[]> {
  context.notePaths ??= (await context.ports.index.manifest()).map((entry) =>
    createVaultPath(entry.path),
  );
  return context.notePaths;
}

/** Writes the import's keys into a note (see `writeStamp`), and says the run wrote. */
export async function writeInto(
  context: ImportContext,
  args: Parameters<typeof writeStamp>[1],
): Promise<string | null> {
  const unsaved = await writeStamp(context.ports, args);
  if (unsaved === null) context.wrote = true;
  return unsaved;
}
