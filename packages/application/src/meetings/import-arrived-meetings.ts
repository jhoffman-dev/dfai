import {
  createVaultPath,
  declaresImport,
  digestOf,
  IMPORT_ERROR_KEY,
  IMPORT_OUTCOME_KEY,
  importErrorText,
  importOutcomeOf,
  isConflictCopyPath,
  isMeetingArrival,
  isMeetingInboxPath,
  leavesFileUnsettled,
  meetingCandidates,
  meetingCopies,
  meetingImportReport,
  messageWithoutPaths,
  parentVaultPath,
  splitFrontmatter,
  type FrontmatterReading,
  type MeetingImport,
  type MeetingImportError,
  type MeetingImportHappening,
  type MeetingsWaiting,
  type NoteChange,
  type VaultPath,
} from '@dfai/domain';
import type { ActivityRecorder } from '../activity/ports.ts';
import type { ArchivePorts } from '../archive/archive-notes.ts';
import type { MarkdownPort } from '../notes/ports.ts';
import {
  archiveCopy,
  letIn,
  mayWriteInto,
  meetingHolders,
  writeInto,
  type BeforeLetIn,
  type ImportContext,
  type MayWriteMeeting,
} from './meeting-files.ts';
import { meetingInboxNotes } from './meeting-inbox.ts';
import { readFrontmatter, validateMeetingFile } from './meeting-reading.ts';

/** What the import reaches: reading and writing notes, the index, the panes, and the Archive's move. */
export type MeetingImportPorts = ArchivePorts;

export interface MeetingImportRun {
  readonly ports: MeetingImportPorts;
  /** The day a duplicate is archived on, `YYYY-MM-DD`. */
  readonly today: string;
  /** Where each outcome is said: one line per meeting file. */
  readonly activity: ActivityRecorder;
  /**
   * Done to a meeting just before it is let in (stamped `imported`), with the
   * meeting still unstamped: the import's own follow-up writes, such as linking
   * its people. Done before the stamp, they are not edits to a meeting that is
   * in — a rule watching meetings sees it once, as it will stay. It settles
   * when done and never rejects: what goes wrong is its to say. It is handed
   * the vocabulary the run corrects by, and says `vault-changed` when the
   * vault is no longer the one open, which leaves the meeting unstamped.
   */
  readonly beforeLetIn?: BeforeLetIn;
  /**
   * Whether the import may write into a file now (ADR-0035 part 4): asked as
   * each file is read, and right before each of its writes. A file it may
   * not write is left as it is and not said, for the next pull to settle.
   */
  readonly mayWrite?: MayWriteMeeting;
  /**
   * What the import has said of files it leaves unsettled: see
   * {@link UnsettledSaid}. Left out, it says every one every time.
   */
  readonly unsettledSaid?: UnsettledSaid;
}

/**
 * The files the import has said it leaves unsettled — a conflict copy, one
 * it cannot read or write, a problem it cannot mark — and what each held
 * when it was said (#174). Every catch-up meets such a file again, and the
 * catch-up runs after every pull: each is said once a session, and again
 * only when what it holds changes.
 */
export interface UnsettledSaid {
  /** Whether this is news: the file was not said yet, or held something else when it was. Records it as said. */
  isNews(path: string, holding: string): boolean;
}

/** An empty record of what has been said, for one session. */
export function createUnsettledSaid(): UnsettledSaid {
  const said = new Map<string, string>();
  return {
    isNews: (path, holding) => {
      if (said.get(path) === holding) return false;
      said.set(path, holding);
      return true;
    },
  };
}

export interface MeetingImportOutcome {
  /** What happened to each meeting file the import did something about, as Activity was told. */
  readonly happenings: readonly MeetingImportHappening[];
  /** Whether any note was written or moved, so what shows the vault reads it again. */
  readonly wrote: boolean;
  /** On a Mac that is not named, which imports nothing: what waits for the one that is (ADR-0035). */
  readonly waiting?: MeetingsWaiting;
}

/** Why the problem was not written into a file, as a clause the Activity line ends a sentence with. */
const UNSAVED_CLAUSE = 'it is open in DFAI with unsaved typing';
const UNREADABLE_FRONTMATTER = 'its frontmatter cannot be read, so nothing could be added to it';

/**
 * Imports the meeting files one sync brought in or changed (ADR-0027,
 * P28-04). The change feed only says where to look: what each file is due
 * comes from the file itself — see {@link importMeetings}.
 */
export async function importArrivedMeetings(
  run: MeetingImportRun & { readonly changes: readonly NoteChange[] },
): Promise<MeetingImportOutcome> {
  return importMeetings(run, meetingCandidates(run.changes));
}

/**
 * Imports every file where meeting files land that is not settled yet: what
 * the import does when it starts, so nothing the change feed did not report —
 * a fresh index's first sync, news heard while another Mac imports, a run
 * that failed — is left behind.
 */
export async function catchUpMeetings(run: MeetingImportRun): Promise<MeetingImportOutcome> {
  return importMeetings(run, await meetingInboxNotes(run.ports.fs));
}

/**
 * Settles each file where meeting files land that is not settled yet, and
 * stamps it `atlas_import_outcome` with how:
 *
 * - `imported` — it follows the contract and is its meeting's original (see
 *   `meetingCopies`); the stamp is the only line written.
 * - `duplicate` — another note holds the same meeting: marked
 *   `atlas_duplicate_of` the original, and archived.
 * - `error` — it breaks the contract: marked `atlas_import_error` with why,
 *   where it landed. A file stamped `error` is looked at again whenever it
 *   is, so a fix lets it in.
 *
 * A file stamped `imported` or `duplicate` is never judged again — an edit, a
 * rename, a move, an unarchive or a sync conflict's copy of it carries the
 * stamp — and a file with no stamp is an arrival not finished yet, whatever
 * the feed called it. Each outcome is one line in Activity; one file's
 * failure is said against that file, and the rest carry on.
 */
async function importMeetings(
  run: MeetingImportRun,
  paths: readonly string[],
): Promise<MeetingImportOutcome> {
  const context: ImportContext = {
    ...run,
    settled: new Set(),
    listed: paths,
    listedMeetings: null,
    notePaths: null,
    wrote: false,
    vocabulary: null,
    arrived: new Map(),
  };
  const happenings: MeetingImportHappening[] = [];
  for (const path of paths) {
    if (context.settled.has(path)) continue;
    const looked = await importOne(context, createVaultPath(path));
    for (const happening of looked.happenings) {
      if (isNews(run, happening, looked.read)) run.activity.record(meetingImportReport(happening));
      happenings.push(happening);
    }
  }
  return { happenings, wrote: context.wrote };
}

/**
 * Whether a happening is news to Activity: always, unless it leaves its file
 * unsettled and was said already of the file holding what it holds now. A
 * file not read is known by what was said of it.
 */
function isNews(
  { unsettledSaid }: MeetingImportRun,
  happening: MeetingImportHappening,
  read: { readonly path: string; readonly text: string } | null,
): boolean {
  if (unsettledSaid === undefined || !leavesFileUnsettled(happening)) return true;
  const said = 'problem' in happening ? `${happening.kind}: ${happening.problem}` : happening.kind;
  const holding = read?.path === happening.path ? digestOf(read.text) : said;
  return unsettledSaid.isNews(happening.path, holding);
}

/** What one file looked at came to, and what it held when read: none, when it could not be. */
interface Looked {
  /** What happened to the file and the others of its meeting; empty when there was nothing to do or say. */
  readonly happenings: MeetingImportHappening[];
  readonly read: { readonly path: VaultPath; readonly text: string } | null;
}

/** Looks at one file, and settles it with the others of its meeting. */
async function importOne(context: ImportContext, path: VaultPath): Promise<Looked> {
  let read: Looked['read'] = null;
  const looked = (happenings: MeetingImportHappening[]): Looked => ({ happenings, read });
  try {
    const { markdown } = context.ports;
    const { text, modified } = await context.ports.fs.readTextFile(path);
    read = { path, text };
    context.arrived.set(path, modified);
    // Not on fresh sync state, or changed here since the last pull: left for the next pull.
    if (!(await mayWriteInto(context, path))) return looked([]);
    const reading = readFrontmatter(markdown, splitFrontmatter(text).frontmatter);
    const outcome = importOutcomeOf(reading.properties);
    // A meeting made by hand in `Meetings` declares no contract: it is a note, not the import's (#214).
    const importDeclared = declaresImport(reading.properties);
    if (!isMeetingArrival({ path, importDeclared, importOutcome: outcome })) return looked([]);
    // Settled: and a copy stamped where meetings land was brought back from the Archive by the person.
    if (outcome === 'imported' || outcome === 'duplicate') return looked([]);
    // The other Mac's version of a meeting both changed: the person's to settle, never a copy.
    if (isConflictCopyPath(path)) return looked([{ kind: 'conflict', path }]);
    const result = validateMeetingFile(markdown, text);
    if (result.ok) return looked(await settleMeeting(context, { path, meeting: result.meeting }));
    const refused = await refuse(context, { path, modified, text, reading, errors: result.errors });
    return looked(refused === null ? [] : [refused]);
  } catch (cause) {
    // Moved or deleted since the feed named it: there is nothing to settle, and the next sync says so.
    if (await isGone(context, path)) return looked([]);
    return looked([{ kind: 'failed', path, problem: messageWithoutPaths(cause) }]);
  }
}

/** Whether a note is no longer in its folder, as the folder lists it now. */
async function isGone(context: ImportContext, path: VaultPath): Promise<boolean> {
  const listed = await context.ports.fs.listDirectory(parentVaultPath(path)).catch(() => null);
  return listed !== null && !listed.some((entry) => entry.path === path);
}

/**
 * Stamps a file that breaks the contract `error`, with why, where it landed.
 * A file already saying the same is not news.
 */
async function refuse(
  context: ImportContext,
  {
    path,
    modified,
    text,
    reading,
    errors,
  }: {
    path: VaultPath;
    modified: number;
    text: string;
    reading: FrontmatterReading;
    errors: readonly MeetingImportError[];
  },
): Promise<MeetingImportHappening | null> {
  context.settled.add(path);
  if (reading.problem !== null) {
    const problem = importErrorText(errors);
    return { kind: 'invalid', path, problem, unmarked: UNREADABLE_FRONTMATTER };
  }
  const problem = problemAsMarked(context.ports.markdown, text, errors);
  const stamped = importOutcomeOf(reading.properties) === 'error';
  if (stamped && reading.properties[IMPORT_ERROR_KEY] === problem) return null;
  if (!(await mayWriteInto(context, path))) return null;
  const unsaved = await writeInto(context, { path, modified, values: errorStamp(problem) });
  return { kind: 'invalid', path, problem, unmarked: unsaved === null ? null : UNSAVED_CLAUSE };
}

const errorStamp = (problem: string) => ({
  [IMPORT_OUTCOME_KEY]: 'error',
  [IMPORT_ERROR_KEY]: problem,
});

/**
 * The problems as the file will read once the stamp is in it. The stamp is
 * lines of the frontmatter — and, in a file with none, a block of its own —
 * so it moves every line below it: counted in the file as it was, a body
 * problem's line would be wrong once written, and the next look would write
 * it again. The stamp keeps its number of lines whatever it says, so the
 * lines counted with it in place stay right.
 */
function problemAsMarked(
  markdown: MarkdownPort,
  text: string,
  errors: readonly MeetingImportError[],
): string {
  const first = importErrorText(errors);
  const document = splitFrontmatter(text);
  const marked =
    markdown.updateFrontmatter(document.frontmatter, errorStamp(first)) + document.body;
  const again = validateMeetingFile(markdown, marked);
  return again.ok ? first : importErrorText(again.errors);
}

/**
 * A file that follows the contract, settled with the other notes of its
 * meeting: the original is let in when it sits where meeting files land and
 * is not in yet, and every copy there is archived. Each is said against its
 * own file, so one that cannot be written leaves the others settled.
 */
async function settleMeeting(
  context: ImportContext,
  { path, meeting }: { path: VaultPath; meeting: MeetingImport },
): Promise<MeetingImportHappening[]> {
  const { unsettled, imported } = await meetingHolders(context, { meeting, besides: path });
  const { original, copies } = meetingCopies([path, ...unsettled], imported);
  const kept = createVaultPath(original);
  const settling: { path: VaultPath; settle: () => Promise<MeetingImportHappening | null> }[] = [
    ...(imported.includes(original) || !isMeetingInboxPath(original)
      ? []
      : [{ path: kept, settle: () => letIn(context, kept) }]),
    ...copies.map((copy) => {
      const at = createVaultPath(copy);
      return { path: at, settle: () => archiveCopy(context, { path: at, original: kept }) };
    }),
  ];
  const happenings: MeetingImportHappening[] = [];
  for (const each of settling) {
    const happening = await each.settle().catch((cause: unknown): MeetingImportHappening => ({
      kind: 'failed',
      path: each.path,
      problem: messageWithoutPaths(cause),
    }));
    // Null: held by the gates for the next pull, and not said.
    if (happening !== null) happenings.push(happening);
  }
  return happenings;
}
