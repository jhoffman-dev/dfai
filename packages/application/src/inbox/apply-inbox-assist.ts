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
  vaultSpellingOf,
  wikiLinkTargetFor,
  type AssistApplyAsk,
  type AssistApplyStep,
  type AssistEvidence,
  type AssistIntent,
  type AssistRow,
  type Clarification,
  type DoneAction,
  type LocalTime,
  type LogEntry,
  type VaultPath,
} from '@dfai/domain';
import type { ActivityRecorder } from '../activity/ports.ts';
import { archiveNotes } from '../archive/archive-notes.ts';
import { createPerson } from '../people/people.ts';
import { setNoteProperties } from '../query/set-property.ts';
import { loadObjectTypes } from '../types/load-types.ts';
import { loadTemplates } from '../types/templates.ts';
import type { AsRead } from '../vault/ports.ts';
import type { GuardedWrites } from './assist-guard.ts';
import { assistRecorder, sayNotDone } from './assist-log.ts';
import { assistSides, type ApplyAssistPorts, type AssistSides } from './assist-sides.ts';
import { recheckNow, type RecheckedNow } from './assist-recheck-now.ts';
import { clarifyInboxItem } from './clarify-inbox-item.ts';
import { PartlyUndoneError, undoExactly, type AssistItemUndo } from './exact-undo.ts';

export type { ApplyAssistPorts } from './assist-sides.ts';

/** What undoing one applied row needs: the item at both ends, the other notes it rewrote, and each person made. */
export interface AssistUndo {
  readonly title: string;
  /** The row, as its log names it (#911): its undo is logged under it too. */
  readonly row: string;
  /** When its log says it was applied. */
  readonly at: LocalTime;
  readonly item: AssistItemUndo;
  /** Each person added, as written: taken out only while it says exactly this. */
  readonly made: readonly AsRead[];
  /** What an undo that stopped part-way put back already: finishing goes on from there. */
  readonly progress?: { readonly restored: readonly VaultPath[]; readonly itemRestored: boolean };
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
  /**
   * Not applied: what went wrong. When taking it back stopped part-way, `undo`
   * finishes it (#911): the row stays open in the log until it does.
   */
  | { readonly kind: 'failed'; readonly words: string; readonly undo?: AssistUndo };

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
 * clarifying, filing, archiving, adding a person — handed the one guarded
 * path (`assist-guard.ts`) as their ports: every write logged before it is
 * made, held to the exact text the row checked or last wrote, and recorded
 * (#911). It records one exact undo for the whole row, a log entry closing
 * the row and one Activity line.
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
  // As the vault spells it, or not at all (#911): on a disk that ignores case,
  // `inbox/x.md` would open `Inbox/x.md` and be logged under a name the vault does not have.
  const spelled = vaultSpellingOf(row.path, notePaths);
  if (spelled !== row.path) {
    const why =
      spelled === null ? 'it is not a note in the vault.' : `the vault spells it ${spelled}.`;
    return unchanged(nothingChanged(why));
  }
  const sides = assistSides(ports);
  let checked: RecheckedNow;
  try {
    checked = await recheckNow(
      { ...sides.vault.reads, clock: sides.clock },
      { row, evidence, notePaths },
    );
  } catch (cause) {
    return unchanged(nothingChanged(`it could not be checked (${messageWithoutPaths(cause)}).`));
  }
  if (checked.kind === 'ask') {
    return unchanged({ kind: 'asked', ask: checked.ask, words: checked.words });
  }
  const recorder = assistRecorder(sides);
  const journal = await begin(sides, { row, step: checked.step, text: checked.text });
  if (journal === null) return unchanged(nothingChanged('its log could not be written.'));
  try {
    await carryOut(sides, journal, { step: checked.step, notePaths });
  } catch (cause) {
    return failedApply(sides, { recorder, journal, cause, title: row.title, notePaths });
  }
  return appliedRow(sides, { recorder, journal, step: checked.step, notePaths });
}

/** Where a row's writes stand as it is applied: what undoing it, or taking it back midway, needs. */
interface Journal {
  /** The row, as its log names it. */
  readonly row: string;
  readonly from: VaultPath;
  /** Where the item is now. */
  at: VaultPath;
  /** What the item said when it was checked: what undoing the row puts back. */
  readonly before: string;
  /** Every write of the row goes through these, and they record it. */
  readonly guard: GuardedWrites;
  /** Where the item has been, the row's own moves taking it. */
  readonly items: Set<VaultPath>;
}

/** What a row writes through: the guarded ports alone, with the clock the use-cases read. */
type Writing = GuardedWrites['ports'] & Pick<AssistSides, 'clock'>;
const writing = (journal: Journal, sides: AssistSides): Writing => ({
  ...journal.guard.ports,
  clock: sides.clock,
});

/** The steps a row logs before each write it makes, under its own id. */
const marking =
  (sides: AssistSides, row: string) =>
  (about: AssistIntent): Promise<void> =>
    sides.log.mark({ kind: 'step', at: sides.clock.localNow(), row, done: [], about });

/** How many rows this run of DFAI has begun: part of each row's id. */
let rowsBegun = 0;

/**
 * Logs that the row begins, before its first write (#911): which row, the
 * item and the digest of what it says, and what the row is to do — so a
 * crash leaves a trace. Null when the log cannot be written: nothing is.
 */
async function begin(
  ports: AssistSides,
  { row, step, text }: { row: AssistRow; step: AssistApplyStep; text: string },
): Promise<Journal | null> {
  const at = ports.clock.localNow();
  // Unique per apply (#911): the second, the item, the clock's instant and this run's count —
  // two rows begun in one second, even of one item, never share an id the log closes.
  rowsBegun += 1;
  const id = `${at} ${row.path} ${ports.clock.now()}.${rowsBegun}`;
  const mark = {
    kind: 'begun' as const,
    at,
    row: id,
    path: row.path,
    digest: digestOf(text),
    plan: assistAppliedWords(step),
  };
  // Not written, nothing is: a row never writes what its log does not say it began.
  const logged = await ports.log.mark(mark).then(
    () => true,
    () => false,
  );
  if (!logged) return null;
  const items = new Set<VaultPath>([row.path]);
  // The kept task of a duplicate is never written: the guard refuses it outright.
  const forbidden = new Set<VaultPath>(step.duplicateOf === null ? [] : [step.duplicateOf.path]);
  const guard = ports.vault.guard({
    known: new Map([[row.path, text]]),
    items,
    forbidden,
    mark: marking(ports, id),
    madeIt: (made) =>
      ports.log.mark({
        kind: 'step',
        at: ports.clock.localNow(),
        row: id,
        done: [{ kind: 'created', path: made.path, digest: digestOf(made.text) }],
      }),
  });
  return { row: id, from: row.path, at: row.path, before: text, guard, items };
}

/** The item as the row has left it: exactly the checked text and the row's own writes, never a later read. */
const afterOf = (journal: Journal) => journal.guard.knows(journal.at) ?? journal.before;

const itemUndo = (journal: Journal): AssistItemUndo => ({
  from: journal.from,
  to: journal.at,
  before: journal.before,
  after: afterOf(journal),
  relinked: journal.guard.rewrites().filter((note) => !journal.items.has(note.path)),
});

/** The vault's notes once a row's moves and makes are in. */
function notesAfter(notePaths: readonly VaultPath[], journal: Journal): VaultPath[] {
  const moved = notePaths.map((path) => (path === journal.from ? journal.at : path));
  return [...moved, ...journal.guard.made().map((person) => person.path)];
}

async function appliedRow(
  ports: AssistSides,
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
    made: journal.guard.made(),
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
  const logged = await ports.log.entry({ recorder, entry, title: step.title, path: journal.at });
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

/** The writes a row comes to, one after another, each through the guard. */
async function carryOut(
  sides: AssistSides,
  journal: Journal,
  { step, notePaths }: { step: AssistApplyStep; notePaths: readonly VaultPath[] },
): Promise<void> {
  const ports = writing(journal, sides);
  if (step.duplicateOf !== null) return archiveDuplicate(ports, { step, journal, notePaths });
  await fillIn(ports, { step, journal, notePaths });
  await linkPeople(ports, { step, journal, notePaths: notesAfter(notePaths, journal) });
}

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
  if (move !== undefined) journal.at = move.move.to;
  if (move === undefined || outcome.failed.length > 0) {
    throw new NotApplied(outcome.failed[0]?.reason ?? 'It could not be archived.');
  }
}

/** Makes it a task, or files it, filling only what the row found empty: Clarify's one byte-preserving save. */
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
  });
  journal.at = outcome.undo.to;
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

/** One byte-preserving write of the item's frontmatter where it is now: the guard holds it to what the row left. */
async function writeOnItem(
  ports: Writing,
  { journal, values }: { journal: Journal; values: Record<string, unknown> },
): Promise<void> {
  const { fs, markdown } = ports;
  await setNoteProperties({ fs, markdown, path: journal.at, values, today: ports.clock.today() });
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
 * the other notes its filing rewrote, the item put back as it was, then
 * anyone it added taken out again — through the same guarded path, each
 * write logged first. Taken back whole, a `failed` entry closes the row. An
 * edit landed in the item meanwhile: it goes back where it was with that edit
 * kept, and anyone the row made — never linked yet — is taken out. Taken back
 * part-way, the row stays open in the log with what is on disk, and its undo
 * is held to be finished (#911).
 */
async function failedApply(
  ports: AssistSides,
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
  const undo: AssistUndo = {
    title,
    row: journal.row,
    at: ports.clock.localNow(),
    item: itemUndo(journal),
    made: journal.guard.made(),
  };
  if (!changedAnything(journal, undo))
    return nothingLeftChanged(ports, { recorder, journal, reason, title, notePaths });
  const taken = await undoExactly({
    vault: ports.vault,
    undo: undo.item,
    made: undo.made,
    notePaths: notesAfter(notePaths, journal),
    keepItemEdit: true,
    mark: marking(ports, journal.row),
  }).then(
    (done) => ({ done, partly: null }),
    (stopped: unknown) => ({ done: null, partly: stopped }),
  );
  if (taken.partly !== null) {
    return partlyTakenBack(ports, {
      recorder,
      undo,
      reason,
      stopped: taken.partly,
      notePaths,
      journal,
    });
  }
  const { keptEdit, kept } = taken.done!;
  const words = [
    `Not applied: ${reason}`,
    ...(keptEdit
      ? [
          'It was edited while it was being applied: it is back where it was with that edit kept, and what this row wrote into it before the edit is still there.',
        ]
      : []),
    ...addedThenTaken(undo.made, kept),
    keptEdit ? '' : 'Nothing was left changed.',
  ].filter((part) => part !== '');
  const entry: LogEntry = {
    kind: 'failed',
    at: ports.clock.localNow(),
    trigger: 'hand',
    problem: reason,
    done: await onDisk(ports, keptEdit ? [journal.from] : [], kept),
    row: journal.row,
  };
  await ports.log.entry({ recorder: silent, entry, title, path: journal.from });
  sayNotDone(recorder, {
    title,
    path: journal.from,
    happened: { doing: 'apply', problem: reason },
  });
  return { applied: { kind: 'failed', words: words.join(' ') }, notePaths };
}

/** Whether the row wrote anything at all: a move, a text of its own, a note rewritten or made. */
function changedAnything(journal: Journal, undo: AssistUndo): boolean {
  return (
    journal.at !== journal.from ||
    undo.item.after !== undo.item.before ||
    undo.item.relinked.length > 0 ||
    undo.made.length > 0
  );
}

/** A row stopped before it changed anything: closed, and said, with nothing to take back. */
async function nothingLeftChanged(
  ports: AssistSides,
  {
    recorder,
    journal,
    reason,
    title,
    notePaths,
  }: {
    recorder: ActivityRecorder;
    journal: Journal;
    reason: string;
    title: string;
    notePaths: readonly VaultPath[];
  },
): Promise<AssistAppliedRow> {
  const entry: LogEntry = {
    kind: 'failed',
    at: ports.clock.localNow(),
    trigger: 'hand',
    problem: reason,
    row: journal.row,
  };
  await ports.log.entry({ recorder: silent, entry, title, path: journal.from });
  sayNotDone(recorder, {
    title,
    path: journal.from,
    happened: { doing: 'apply', problem: reason },
  });
  return {
    applied: { kind: 'failed', words: `Not applied: ${reason} Nothing was left changed.` },
    notePaths,
  };
}

/** "Tobias Fenn was added, then taken out again (in the Trash)." — and who could not be. */
function addedThenTaken(made: readonly AsRead[], kept: readonly { path: VaultPath }[]): string[] {
  const out = made.filter((person) => !kept.some((each) => each.path === person.path));
  const names = out.map((person) => noteTitle(person.path));
  return [
    ...(names.length === 0
      ? []
      : [
          `${names.join(' and ')} ${names.length === 1 ? 'was' : 'were'} added, then taken out again (in the Trash).`,
        ]),
    ...kept.map((person) => `${noteTitle(person.path)} was left in People: it changed since.`),
  ];
}

/** A rollback that stopped part-way: logged as a step that keeps the row open, said, and held to be finished. */
async function partlyTakenBack(
  ports: AssistSides,
  {
    recorder,
    undo,
    reason,
    stopped,
    notePaths,
    journal,
  }: {
    recorder: ActivityRecorder;
    undo: AssistUndo;
    reason: string;
    stopped: unknown;
    notePaths: readonly VaultPath[];
    journal: Journal;
  },
): Promise<AssistAppliedRow> {
  const partly = stopped instanceof PartlyUndoneError ? stopped : null;
  const why = messageWithoutPaths(stopped);
  const progress: { restored: readonly VaultPath[]; itemRestored: boolean; itemAt: VaultPath } =
    partly?.progress ?? { restored: [], itemRestored: false, itemAt: journal.at };
  const held: AssistUndo = {
    ...undo,
    progress: { restored: progress.restored, itemRestored: progress.itemRestored },
  };
  const changed = [
    progress.itemAt,
    ...undo.item.relinked
      .map((note) => note.path)
      .filter((path) => !progress.restored.includes(path)),
  ];
  const done = await onDisk(ports, changed, undo.made);
  await ports.log.mark({ kind: 'step', at: ports.clock.localNow(), row: undo.row, done });
  sayNotDone(recorder, {
    title: undo.title,
    path: progress.itemAt,
    happened: { doing: 'apply', problem: `${reason} ${why}` },
  });
  const words = partly
    ? `Not applied: ${reason} Taking it back stopped part-way: ${why}`
    : `Not applied: ${reason} It could not be taken back: ${why} Undo it to try again.`;
  return {
    applied: { kind: 'failed', words, undo: held },
    notePaths: notesAfter(notePaths, journal),
  };
}

/** What is on disk at each of `paths` now, by digest, and each person still there: for a log a person can act on. */
async function onDisk(
  ports: AssistSides,
  paths: readonly VaultPath[],
  people: readonly { path: VaultPath }[],
): Promise<DoneAction[]> {
  const read = await ports.vault.reads.fs.readNotes([
    ...paths,
    ...people.map((person) => person.path),
  ]);
  return read.map((note): DoneAction => {
    const path = note.path as VaultPath;
    const digest = digestOf(note.text);
    return people.some((person) => person.path === path)
      ? { kind: 'created', path, digest }
      : { kind: 'assisted', from: path, to: path, digest };
  });
}

/** A recorder that says nothing: the line is said once, in the row's own words. */
const silent: ActivityRecorder = { record: () => undefined };

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
