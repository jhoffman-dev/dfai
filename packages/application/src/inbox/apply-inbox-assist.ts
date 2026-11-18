import {
  archiveRefusal,
  assistAppliedWords,
  assistApplyStep,
  assistRowIntegrity,
  digestOf,
  DUPLICATE_OF_KEY,
  MEETING_PEOPLE_KEY,
  messageWithoutPaths,
  noteTitle,
  wikiLinkTargetFor,
  type AssistApplyAsk,
  type AssistApplyStep,
  type AssistEvidence,
  type AssistRow,
  type Clarification,
  type DoneAction,
  type LocalTime,
  type LogEntry,
  type VaultPath,
} from '@dfai/domain';
import type { ActivityLog, ActivityRecorder } from '../activity/ports.ts';
import { archiveNotes, type ArchivePorts } from '../archive/archive-notes.ts';
import { createPerson } from '../people/people.ts';
import type { Clock } from '../ports.ts';
import { setNoteProperties } from '../query/set-property.ts';
import { loadObjectTypes } from '../types/load-types.ts';
import { loadTemplates } from '../types/templates.ts';
import type { AsRead } from '../vault/ports.ts';
import { assistRecorder, logAssist, logMark, sayNotDone } from './assist-log.ts';
import { recheckNow, type RecheckedNow } from './assist-recheck-now.ts';
import { clarifyInboxItem, undoClarifyInboxItem, type ClarifyUndo } from './clarify-inbox-item.ts';
import { recordingWrites, type Rewritten } from './recording-writes.ts';

/** What applying an Inbox assist row reaches (#909): the Inbox's own writes, the clock, and Activity. */
export interface ApplyAssistPorts extends ArchivePorts {
  readonly clock: Pick<Clock, 'now' | 'today' | 'localNow'>;
  readonly activity: Pick<ActivityLog, 'inOpenVault'>;
}

/** What undoing one applied row needs: the item at both ends, the other notes it rewrote, and each person made. */
export interface AssistUndo {
  readonly title: string;
  /** The row, as its log names it (#911). */
  readonly row: string;
  /** When its log says it was applied. */
  readonly at: LocalTime;
  /**
   * The item from where it was to where it is, its whole text before and
   * after, and each other note its filing rewrote with theirs: one exact undo.
   */
  readonly item: ClarifyUndo;
  /** Each person added, as written: taken out only while it says exactly this. */
  readonly made: readonly AsRead[];
}

/** What applying one row came to. */
export type AssistApplied =
  | {
      readonly kind: 'applied';
      /** Where the item is now. */
      readonly path: VaultPath;
      readonly words: string;
      readonly undo: AssistUndo;
      /** False when its closing log entry could not be written: what was done stays done, and says so. */
      readonly logged: boolean;
    }
  /** Asked instead, and nothing written: the domain's reason. */
  | { readonly kind: 'asked'; readonly ask: AssistApplyAsk; readonly words: string }
  /** Not applied: what went wrong, and whether anything was left changed. */
  | { readonly kind: 'failed'; readonly words: string };

/** One row to apply, the preview's evidence for it, and the vault's notes as they stand. */
export interface AssistApplyRequest {
  readonly row: AssistRow;
  /** Undefined for a row Claude gave no answer for: never applied. */
  readonly evidence: AssistEvidence | undefined;
  readonly notePaths: readonly VaultPath[];
}

/** An applied row, and the vault's notes after it: where the item went, and anyone made. */
export interface AssistAppliedRow {
  readonly applied: AssistApplied;
  readonly notePaths: readonly VaultPath[];
}

const nothingChanged = (why: string): AssistApplied => ({
  kind: 'failed',
  words: `Not applied: ${why} Nothing changed.`,
});

/**
 * Applies one Inbox assist row at the person's press (#909): checks that the
 * row and its evidence belong together, before reading anything; re-checks
 * it, for this item alone, against the notes and the vault as they are now,
 * and asks rather than write when anything it rests on has changed. Then it
 * logs that it begins, and writes only through the Inbox's own use-cases —
 * clarifying, filing, archiving, adding a person — each write held to the
 * exact text that was checked, refusing before it writes (#911). It records
 * one exact undo for the whole row, a log entry closing the row and one
 * Activity line.
 *
 * A row is applied whole or not at all: a write that fails takes back every
 * write the row made before it, a person added included, and says so.
 */
export async function applyAssistRow(
  ports: ApplyAssistPorts,
  { row, evidence, notePaths }: AssistApplyRequest,
): Promise<AssistAppliedRow> {
  const unchanged = (applied: AssistApplied) => ({ applied, notePaths });
  const refusal = assistRowIntegrity(row, evidence);
  if (refusal !== null || evidence === undefined) {
    return unchanged(nothingChanged(refusal ?? 'Nothing of it was kept at the preview.'));
  }
  let checked: RecheckedNow;
  try {
    checked = await recheckNow(ports, { row, evidence, notePaths });
  } catch (cause) {
    return unchanged(nothingChanged(`it could not be checked (${messageWithoutPaths(cause)}).`));
  }
  if (checked.kind === 'ask') {
    return unchanged({ kind: 'asked', ask: checked.ask, words: checked.words });
  }
  const recorder = assistRecorder(ports);
  const journal = await begin(ports, { row, step: checked.step, text: checked.text });
  if (journal === null) return unchanged(nothingChanged('its log could not be written.'));
  try {
    await carryOut(ports, { step: checked.step, journal, notePaths });
  } catch (cause) {
    return failedApply(ports, { recorder, journal, cause, title: row.title, notePaths });
  }
  return appliedRow(ports, { recorder, journal, step: checked.step, notePaths });
}

/** Where a row's writes stand as it is applied: what undoing it, or taking it back midway, needs. */
interface Journal {
  /** The row, as its log names it. */
  readonly row: string;
  readonly from: VaultPath;
  /** Where the item is now. */
  at: VaultPath;
  /** What the item said before the row's first write: what undoing it puts back. */
  before: string;
  /** What the row's own last write left the item saying: every next write is held to it. */
  after: string;
  /** The other notes the row's filing rewrote, with their text before and after. */
  relinked: readonly Rewritten[];
  readonly made: AsRead[];
}

/**
 * Logs that the row begins, before its first write (#911): which row, the
 * item and the digest of what it says, and what the row is to do — so a
 * crash leaves a trace. Null when the log cannot be written: nothing is.
 */
async function begin(
  ports: ApplyAssistPorts,
  { row, step, text }: { row: AssistRow; step: AssistApplyStep; text: string },
): Promise<Journal | null> {
  const at = ports.clock.localNow();
  const id = `${at} ${row.path}`;
  const plan = assistAppliedWords(step);
  const mark = {
    kind: 'begun' as const,
    at,
    row: id,
    path: row.path,
    digest: digestOf(text),
    plan,
  };
  // Not written, nothing is: a row never writes what its log does not say it began.
  const logged = await logMark(ports, mark).then(
    () => true,
    () => false,
  );
  if (!logged) return null;
  return {
    row: id,
    from: row.path,
    at: row.path,
    before: text,
    after: text,
    relinked: [],
    made: [],
  };
}

const itemUndo = (journal: Journal): ClarifyUndo => ({
  from: journal.from,
  to: journal.at,
  before: journal.before,
  after: journal.after,
  relinked: journal.relinked,
});

const changedItem = (journal: Journal) =>
  journal.at !== journal.from || journal.after !== journal.before || journal.relinked.length > 0;

/** The vault's notes once a row's moves and makes are in. */
function notesAfter(notePaths: readonly VaultPath[], journal: Journal): VaultPath[] {
  const moved = notePaths.map((path) => (path === journal.from ? journal.at : path));
  return [...moved, ...journal.made.map((person) => person.path)];
}

async function appliedRow(
  ports: ApplyAssistPorts,
  {
    recorder,
    journal,
    step,
    notePaths,
  }: {
    recorder: ActivityRecorder;
    journal: Journal;
    step: AssistApplyStep;
    notePaths: readonly VaultPath[];
  },
): Promise<AssistAppliedRow> {
  const undo: AssistUndo = {
    title: step.title,
    row: journal.row,
    at: ports.clock.localNow(),
    item: itemUndo(journal),
    made: [...journal.made],
  };
  const entry: LogEntry = {
    kind: 'run',
    at: undo.at,
    trigger: 'hand',
    done: doneOf(undo),
    left: [],
    capped: false,
    row: journal.row,
  };
  const logged = await logAssist(ports, { recorder, entry, title: step.title, path: journal.at });
  const words = assistAppliedWords(step) + (logged ? '' : ' Its log could not be written.');
  return {
    applied: { kind: 'applied', path: journal.at, words, undo, logged },
    notePaths: notesAfter(notePaths, journal),
  };
}

/** What a log says an applied row did: the item changed, and each person made with what it said. */
function doneOf(undo: AssistUndo): DoneAction[] {
  return [
    { kind: 'assisted', from: undo.item.from, to: undo.item.to, digest: digestOf(undo.item.after) },
    ...undo.made.map((person): DoneAction => ({
      kind: 'created',
      path: person.path,
      digest: digestOf(person.text),
    })),
  ];
}

/** The writes a row comes to, one after another, each recorded in `journal` as it lands. */
async function carryOut(
  ports: ApplyAssistPorts,
  {
    step,
    journal,
    notePaths,
  }: { step: AssistApplyStep; journal: Journal; notePaths: readonly VaultPath[] },
): Promise<void> {
  const writing = journaling(ports, journal);
  if (step.duplicateOf !== null) return archiveDuplicate(writing, { step, journal, notePaths });
  await fillIn(writing, { step, journal, notePaths });
  await linkPeople(writing, { step, journal, notePaths: notesAfter(notePaths, journal) });
}

/**
 * The ports a row writes through: each note's text as written kept, and each
 * person, as made, kept in `journal` and logged at once (#911) — so a crash
 * after it is known.
 */
function journaling(
  ports: ApplyAssistPorts,
  journal: Journal,
): ApplyAssistPorts & { written: ReadonlyMap<VaultPath, string> } {
  const { ports: recording, written } = recordingWrites(ports);
  const createNote: ArchivePorts['fs']['createNote'] = async (create) => {
    const modified = await recording.fs.createNote(create);
    const made = { path: create.path, modified, text: create.contents };
    journal.made.push(made);
    const done: DoneAction[] = [{ kind: 'created', path: made.path, digest: digestOf(made.text) }];
    await logMark(ports, { kind: 'step', at: ports.clock.localNow(), row: journal.row, done });
    return modified;
  };
  return { ...ports, ...recording, fs: { ...recording.fs, createNote }, written };
}

type Writing = ReturnType<typeof journaling>;

/** Stamps the item with the task it copies, then archives it: the kept task is never touched. */
async function archiveDuplicate(
  ports: Writing,
  {
    step,
    journal,
    notePaths,
  }: { step: AssistApplyStep; journal: Journal; notePaths: readonly VaultPath[] },
): Promise<void> {
  const refusal = archiveRefusal(journal.from);
  if (refusal !== null) throw new NotApplied(refusal);
  const kept = `[[${wikiLinkTargetFor(step.duplicateOf!.path, notePaths)}]]`;
  await writeOnItem(ports, { journal, values: { [DUPLICATE_OF_KEY]: kept } });
  const outcome = await archiveNotes({
    ports,
    paths: [journal.at],
    notePaths,
    today: ports.clock.today(),
  });
  const move = outcome.moves[0];
  if (move !== undefined) {
    journal.at = move.move.to;
    journal.after = ports.written.get(journal.at) ?? journal.after;
  }
  if (move === undefined || outcome.failed.length > 0) {
    throw new NotApplied(outcome.failed[0]?.reason ?? 'It could not be archived.');
  }
}

/**
 * Makes it a task, or files it, filling only what the row found empty:
 * Clarify's one byte-preserving save, held to the text that was checked —
 * Clarify refuses, before writing anything, a note that says anything else.
 */
async function fillIn(
  ports: Writing,
  {
    step,
    journal,
    notePaths,
  }: { step: AssistApplyStep; journal: Journal; notePaths: readonly VaultPath[] },
): Promise<void> {
  const fill = step.fill!;
  const clarification: Clarification = {
    ...(fill.makeTask && { asTask: true }),
    ...(fill.project !== null && { project: fill.project.path }),
    ...(fill.due !== null && { due: fill.due }),
  };
  if (Object.keys(clarification).length === 0) return;
  const outcome = await clarifyInboxItem({
    ports,
    path: journal.from,
    clarification,
    notePaths,
    today: ports.clock.today(),
    unsavedTyping: 'leave',
    expectedText: journal.after,
  });
  journal.at = outcome.undo.to;
  journal.after = outcome.undo.after;
  journal.relinked = outcome.undo.relinked ?? [];
  if (outcome.failed.length > 0) throw new NotApplied(outcome.failed[0]!.reason);
}

/** Adds each new person, then links everyone under `people` in one write: a person made is linked, or taken out again. */
async function linkPeople(
  ports: Writing,
  {
    step,
    journal,
    notePaths,
  }: { step: AssistApplyStep; journal: Journal; notePaths: readonly VaultPath[] },
): Promise<void> {
  if (step.links.length + step.adds.length === 0) return;
  let paths = notePaths;
  const targets = step.links.map((person) => wikiLinkTargetFor(person.path, paths));
  if (step.adds.length > 0) {
    const [types, templates] = await Promise.all([loadObjectTypes(ports), loadTemplates(ports)]);
    for (const person of step.adds) {
      const made = await createPerson({ ...ports, ...person, types, templates, notePaths: paths });
      paths = [...paths, made.path];
      targets.push(made.target);
    }
  }
  const values = { [MEETING_PEOPLE_KEY]: targets.map((target) => `[[${target}]]`) };
  await writeOnItem(ports, { journal, values });
}

/**
 * One byte-preserving write of the item's frontmatter where it is now, held
 * to exactly the text the row last checked or left (#911): an edit landing
 * in the disk's timestamp tick is refused as any other, before anything is
 * written, and the row stops.
 */
async function writeOnItem(
  ports: Writing,
  { journal, values }: { journal: Journal; values: Record<string, unknown> },
): Promise<void> {
  const { fs, markdown } = ports;
  const today = ports.clock.today();
  await setNoteProperties({ fs, markdown, path: journal.at, values, today, ifText: journal.after });
  journal.after = ports.written.get(journal.at) ?? journal.after;
}

/** A row stopped on purpose, in words for the person. */
class NotApplied extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'NotApplied';
  }
}

/**
 * A row that could not be finished: every write it made is taken back —
 * the item put back as it was, the other notes its filing rewrote with it,
 * then anyone it added taken out again — and said. Its log entry closes the
 * row either way, with what could not be taken back.
 */
async function failedApply(
  ports: ApplyAssistPorts,
  {
    recorder,
    journal,
    cause,
    title,
    notePaths,
  }: {
    recorder: ActivityRecorder;
    journal: Journal;
    cause: unknown;
    title: string;
    notePaths: readonly VaultPath[];
  },
): Promise<AssistAppliedRow> {
  const reason = messageWithoutPaths(cause);
  const left = await takeBack(ports, journal, notesAfter(notePaths, journal));
  const entry: LogEntry = {
    kind: 'failed',
    at: ports.clock.localNow(),
    trigger: 'hand',
    problem: reason,
    done: leftDone(journal, left),
    row: journal.row,
  };
  if (left.problems.length === 0) {
    const made = journal.made.map((person) => noteTitle(person.path));
    const addedThenTaken =
      made.length === 0
        ? ''
        : ` ${made.join(' and ')} ${made.length === 1 ? 'was' : 'were'} added, then taken out again (in the Trash).`;
    await logAssist(ports, { recorder: silent, entry, title, path: journal.from });
    sayNotDone(recorder, {
      title,
      path: journal.from,
      happened: { doing: 'apply', problem: reason },
    });
    return {
      applied: {
        kind: 'failed',
        words: `Not applied: ${reason}${addedThenTaken} Nothing was left changed.`,
      },
      notePaths,
    };
  }
  await logAssist(ports, { recorder, entry, title, path: left.itemAt });
  const words = `Not applied: ${reason} ${left.problems.join(' ')}`;
  return { applied: { kind: 'failed', words }, notePaths: notesAfter(notePaths, journal) };
}

/** A recorder that says nothing: the line is said once, in the row's own words. */
const silent: ActivityRecorder = { record: () => undefined };

interface LeftBehind {
  readonly problems: readonly string[];
  /** Where the item is: back where it was, or where it was left. */
  readonly itemAt: VaultPath;
  readonly itemChanged: boolean;
  readonly people: readonly AsRead[];
}

/** Undoes what a row wrote, item first: a person is taken out only once the item no longer links them. */
async function takeBack(
  ports: ApplyAssistPorts,
  journal: Journal,
  notePaths: readonly VaultPath[],
): Promise<LeftBehind> {
  const problems: string[] = [];
  if (changedItem(journal)) {
    const undone = await undoClarifyInboxItem({
      ports,
      undo: itemUndo(journal),
      notePaths,
      exact: true,
    }).then(
      () => null,
      (cause: unknown) => messageWithoutPaths(cause),
    );
    if (undone !== null) {
      problems.push(`It was left as the row changed it (${undone}), and anyone it added is kept.`);
      return { problems, itemAt: journal.at, itemChanged: true, people: journal.made };
    }
  }
  const people: AsRead[] = [];
  for (const person of [...journal.made].reverse()) {
    await ports.fs
      .trashEntry({ path: person.path, unchanged: [person] })
      .catch((cause: unknown) => {
        people.push(person);
        problems.push(
          `${noteTitle(person.path)} was left in People (${messageWithoutPaths(cause)}).`,
        );
      });
  }
  return { problems, itemAt: journal.from, itemChanged: false, people };
}

/** What a row that could not be taken back whole left done, for its log. */
function leftDone(journal: Journal, left: LeftBehind): DoneAction[] {
  return [
    ...(left.itemChanged
      ? [
          {
            kind: 'assisted' as const,
            from: journal.from,
            to: journal.at,
            digest: digestOf(journal.after),
          },
        ]
      : []),
    ...left.people.map((person): DoneAction => ({
      kind: 'created',
      path: person.path,
      digest: digestOf(person.text),
    })),
  ];
}

/** Each row "Apply all" tried, and what it came to. */
export interface AssistAppliedEach {
  readonly path: VaultPath;
  readonly applied: AssistApplied;
}

/**
 * "Apply all sure ones" (#909): every row that is applied at all, one after
 * another, each re-checked and applied on its own — a question is never
 * applied, and a row that asks or fails leaves the next to go on. Aborted,
 * it finishes the row it is on, whole or taken back, and starts no other.
 */
export async function applySureRows(
  ports: ApplyAssistPorts,
  {
    rows,
    notePaths,
    signal,
    onEach,
  }: {
    rows: readonly { row: AssistRow; evidence: AssistEvidence | undefined }[];
    notePaths: readonly VaultPath[];
    signal?: AbortSignal;
    /** Told as each row lands, so the page can show it. */
    onEach?: (each: AssistAppliedEach) => void;
  },
): Promise<AssistAppliedEach[]> {
  const results: AssistAppliedEach[] = [];
  let paths = notePaths;
  for (const { row, evidence } of rows) {
    if (assistApplyStep(row) === null || evidence === undefined) continue;
    if (signal?.aborted === true) break;
    const done = await applyAssistRow(ports, { row, evidence, notePaths: paths });
    paths = done.notePaths;
    const each = { path: row.path, applied: done.applied };
    results.push(each);
    onEach?.(each);
  }
  return results;
}
