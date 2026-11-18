import {
  clarifyPlan,
  clarifyVocabulary,
  noteTitle,
  splitFrontmatter,
  vaultSpellingOf,
  waitingOnRefusal,
  type Clarification,
  type VaultPath,
} from '@dfai/domain';
import {
  moveAndStampNotes,
  type ArchiveFailure,
  type ArchivePorts,
  type UnsavedTyping,
} from '../archive/archive-notes.ts';
import { TaskRuleRefusedError } from '../gtd/task-rules.ts';
import { FrontmatterRefusedError } from '../notes/frontmatter-refused-error.ts';
import { setNoteProperties } from '../query/set-property.ts';
import { loadObjectTypes, noteTypeName } from '../types/load-types.ts';
import { UnsavedTypingError } from '../vault/update-links.ts';
import { FilingRefusedError, filingTarget, processInboxItems } from './process-inbox.ts';
import { recordingWrites, type Rewritten } from './recording-writes.ts';

/** A clarification the rules refuse, with the reason the row shows. Nothing was written. */
export class ClarifyRefusedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'ClarifyRefusedError';
  }
}

/** What undoing a clarification needs: where the note was and is, and its text at each end. */
export interface ClarifyUndo {
  readonly from: VaultPath;
  readonly to: VaultPath;
  /** The note's whole text before it was clarified. */
  readonly before: string;
  /** Its text as clarifying left it: undo is refused once the note says anything else. */
  readonly after: string;
  /**
   * The other notes filing it rewrote — their links to it — each with its text
   * before and after (#911). An exact undo puts exactly these back.
   */
  readonly relinked?: readonly Rewritten[];
}

/** What clarifying a note did. */
export interface ClarifyOutcome {
  /** Where the note is now. */
  readonly path: VaultPath;
  /** Where it was, when it was filed under a project; null when it stayed. */
  readonly movedFrom: VaultPath | null;
  /** What could not be done once its properties were written: the filing, or a link left behind. */
  readonly failed: readonly ArchiveFailure[];
  readonly linksUpdated: number;
  readonly undo: ClarifyUndo;
}

/**
 * Whether clarifying changed the note at all: wrote its properties, or moved
 * it. A filing alone whose move failed changed nothing, so it has nothing to
 * be said done or taken back.
 */
export function clarifiedAnything({ undo }: Pick<ClarifyOutcome, 'undo'>): boolean {
  return undo.from !== undo.to || undo.before !== undo.after;
}

/** A note to clarify, and how. */
export interface ClarifyRequest {
  readonly ports: ArchivePorts;
  readonly path: VaultPath;
  readonly clarification: Clarification;
  /** Every note in the vault, for spelling paths, writing links and naming clashes. */
  readonly notePaths: readonly VaultPath[];
  /** `YYYY-MM-DD`, from the injected clock. */
  readonly today: string;
  /** `save` unless said otherwise: the app's own commands are the person's (ADR-0016). */
  readonly unsavedTyping?: UnsavedTyping;
  /**
   * The note's whole text as the caller checked it (#911). Given, a note that
   * says anything else is refused before anything is written, and its
   * properties are written only over exactly that text.
   */
  readonly expectedText?: string;
}

/**
 * Clarifies one note waiting in the Inbox (#112): everything its row decided
 * — status, who it waits on, defer, due, contexts — is written in one
 * byte-preserving save held to the task rules, and a note in the `Inbox`
 * folder given a project is then filed under it, as Process files it: out to
 * its home folder, linked (#214). A task or a meeting elsewhere given a
 * project is only linked, where it is.
 *
 * Everything is judged before anything is written: a refusal — a project
 * that cannot be filed under, a person who is not one — throws {@link ClarifyRefusedError} and leaves the vault as it
 * was. The properties are written first, so a filing that then fails —
 * refused, or thrown, by a project sync took away meanwhile — leaves a
 * clarified note where it was, says so in `failed`, and can still be undone.
 */
export async function clarifyInboxItem(request: ClarifyRequest): Promise<ClarifyOutcome> {
  const { notePaths, today } = request;
  const { ports, written, rewritten } = recordingWrites(request.ports);
  const unsavedTyping = request.unsavedTyping ?? 'save';
  const path = vaultSpellingOf(request.path, notePaths);
  if (path === null) throw new ClarifyRefusedError('There is no note at that path.');
  await settleTyping({ ports, path, unsavedTyping });

  const { text, modified } = await ports.fs.readTextFile(path);
  const { expectedText } = request;
  if (expectedText !== undefined && text !== expectedText)
    throw new ClarifyRefusedError(CHANGED_SINCE_CHECKED);
  const clarification = await asTheVaultSpells(request);
  const types = await loadObjectTypes({ fs: ports.fs, markdown: ports.markdown });
  const plan = clarifyPlan({
    path,
    properties: propertiesOf(ports, text),
    clarification,
    notePaths,
    today,
    vocabulary: clarifyVocabulary(types),
  });
  if ('refused' in plan) throw new ClarifyRefusedError(plan.refused);

  if (Object.keys(plan.changes).length > 0) {
    assertWritable(ports, { text, changes: plan.changes });
    const write = { fs: ports.fs, markdown: ports.markdown, path, values: plan.changes, today };
    const held = { ifModified: modified, ...(expectedText !== undefined && { ifText: text }) };
    await setNoteProperties({ ...write, ...held }).catch(refusedByTheRules);
    if (ports.editors.state(path) !== 'dirty') ports.editors.reload(path);
  }
  const filed =
    plan.fileUnder === null
      ? { moves: [], failed: [], linksUpdated: 0 }
      : await processInboxItems({
          ports,
          paths: [path],
          notePaths,
          project: plan.fileUnder,
          today,
          updateLinks: true,
          unsavedTyping,
        }).catch((cause: unknown) => {
          // Everything it throws, it throws before it moves anything: once the
          // properties are written, a filing that cannot start is said in `failed`,
          // so the written note still has its undo. Before, it is the rejection.
          if (!written.has(path)) throw cause;
          return { moves: [], failed: [{ path, reason: notFiled(cause) }], linksUpdated: 0 };
        });
  const landed = filed.moves[0]?.move.to ?? path;
  // What clarifying itself wrote, not the disk read back: an edit saved since is
  // then a change the undo refuses to write over.
  const after = written.get(landed) ?? written.get(path) ?? text;
  const relinked = rewritten().filter((note) => note.path !== path && note.path !== landed);
  return {
    path: landed,
    movedFrom: landed === path ? null : path,
    failed: filed.failed,
    linksUpdated: filed.linksUpdated,
    undo: { from: path, to: landed, before: text, after, relinked },
  };
}

const CHANGED_SINCE_CHECKED = 'It changed since it was checked, so nothing was written.';

const notFiled = (cause: unknown): string =>
  `Clarified, but not filed: ${cause instanceof Error ? cause.message : String(cause)}`;

/**
 * Takes a clarification back (#112): the note goes back where it was and says
 * what it said, byte for byte. Refused, with nothing touched, once the note
 * says anything other than what clarifying left — an edit since is kept —
 * or something else has taken its old path.
 */
export async function undoClarifyInboxItem({
  ports,
  undo,
  notePaths,
  exact = false,
}: {
  ports: ArchivePorts;
  undo: ClarifyUndo;
  notePaths: readonly VaultPath[];
  /**
   * Put back exactly what clarifying wrote, and nothing else (#911): the note
   * is moved back rewriting no link, and each other note its filing rewrote
   * is given back its text — refused, with nothing touched, once any of them
   * says anything else. Left out, the move back rewrites links as a move does.
   */
  exact?: boolean;
}): Promise<void> {
  const held = await whereItIs(ports, undo);
  await settleTyping({ ports, path: held.path, unsavedTyping: 'save' });
  if ((await ports.fs.readTextFile(held.path)).text !== undo.after) throw new ChangedSince();
  const relinked = exact ? await relinkedAsLeft(ports, undo) : [];
  const moved = held.path !== undo.from;
  if (moved) await moveBack({ ports, undo, notePaths, updateLinks: !exact });
  // Read again where it is written: an edit that landed since the check is kept, not
  // written over. A note moved back rewriting its links is not compared — the move
  // respells the links it holds to itself — so there the host's own check of `modified`
  // is what stands. Moved back exactly, it says what clarifying left, or it is refused.
  const { text, modified } = await ports.fs.readTextFile(undo.from);
  if ((!moved || exact) && text !== undo.after) throw new ChangedSince();
  await ports.fs.writeTextFile({
    path: undo.from,
    contents: undo.before,
    expectedModified: modified,
    ...(exact && { expectedText: undo.after }),
  });
  if (ports.editors.state(undo.from) !== 'dirty') ports.editors.reload(undo.from);
  for (const note of relinked) await putBack(ports, note);
}

/**
 * The other notes filing rewrote, each read now and still saying what the
 * filing left, ready to be given back their text; refused, naming the note,
 * when one says anything else or its text before is unknown.
 */
async function relinkedAsLeft(
  ports: ArchivePorts,
  undo: ClarifyUndo,
): Promise<{ path: VaultPath; before: string; after: string; modified: number }[]> {
  const ready = [];
  for (const note of undo.relinked ?? []) {
    const now = await ports.fs.readTextFile(note.path).catch(() => null);
    if (now === null || now.text !== note.after || note.before === null) {
      throw new ClarifyRefusedError(
        `${noteTitle(note.path)} was changed since, so nothing was undone.`,
      );
    }
    ready.push({ path: note.path, before: note.before, after: note.after, modified: now.modified });
  }
  return ready;
}

/** One other note given back the text it had, held to the text the filing left it. */
async function putBack(
  ports: ArchivePorts,
  note: { path: VaultPath; before: string; after: string; modified: number },
): Promise<void> {
  await ports.fs.writeTextFile({
    path: note.path,
    contents: note.before,
    expectedModified: note.modified,
    expectedText: note.after,
  });
  if (ports.editors.state(note.path) !== 'dirty') ports.editors.reload(note.path);
}

class ChangedSince extends ClarifyRefusedError {
  constructor() {
    super('It was changed since, so it was left as it is.');
  }
}

/**
 * Where the clarified note is: where clarifying left it, or — when an undo
 * moved it back and then could not write it — already where it was, still
 * saying what clarifying wrote, so the undo can be tried again.
 */
async function whereItIs(ports: ArchivePorts, undo: ClarifyUndo): Promise<{ path: VaultPath }> {
  const readable = (path: VaultPath) =>
    ports.fs.readTextFile(path).then(
      ({ text }) => text,
      () => null,
    );
  if ((await readable(undo.to)) !== null) return { path: undo.to };
  if ((await readable(undo.from)) === undo.after) return { path: undo.from };
  throw new ClarifyRefusedError('It is not there any more, so nothing was undone.');
}

/** Moves a filed note back to exactly where it was, rewriting the links the move back leaves. */
async function moveBack({
  ports,
  undo,
  notePaths,
  updateLinks,
}: {
  ports: ArchivePorts;
  undo: ClarifyUndo;
  notePaths: readonly VaultPath[];
  updateLinks: boolean;
}): Promise<void> {
  // Asked of the disk, not of `notePaths`: that list was read before the note was filed.
  const taken = await ports.fs.readTextFile(undo.from).then(
    () => true,
    () => false,
  );
  if (taken) {
    throw new ClarifyRefusedError(
      'Nothing was undone: another note has taken its place in the Inbox.',
    );
  }
  const outcome = await moveAndStampNotes(
    { ports, paths: [undo.to], notePaths, updateLinks },
    {
      refusal: () => null,
      destination: async () => undo.from,
      // Nothing is stamped: its text is put back whole once it is where it was.
      stamp: () => () => ({ changes: {}, keepsBlock: true }),
    },
  );
  if (outcome.moves.length === 0) {
    const why = outcome.failed[0]?.reason ?? 'it could not be moved back.';
    throw new ClarifyRefusedError(`Nothing was undone: ${why}`);
  }
}

/** A pane's typing is written first, or — for another tool — the note is left alone. */
async function settleTyping({
  ports,
  path,
  unsavedTyping,
}: {
  ports: ArchivePorts;
  path: VaultPath;
  unsavedTyping: UnsavedTyping;
}): Promise<void> {
  if (ports.editors.state(path) !== 'dirty') return;
  if (unsavedTyping === 'leave') throw new UnsavedTypingError(path);
  await ports.editors.flush([path]);
}

/**
 * Refuses a change the note's frontmatter cannot take — a block that is a
 * list or a bare string, say — in the row's words rather than the writer's,
 * and before anything is written.
 */
function assertWritable(
  ports: ArchivePorts,
  { text, changes }: { text: string; changes: Readonly<Record<string, unknown>> },
): void {
  try {
    ports.markdown.updateFrontmatter(splitFrontmatter(text).frontmatter, changes);
  } catch (cause) {
    // Everything caught, on purpose: the writer is pure — it reads no file and no
    // clock — so whatever it throws is about this note's block. A refusal it
    // words for the person is passed on; anything else is a block that is not a
    // map of keys, in a YAML library's words.
    if (cause instanceof FrontmatterRefusedError) throw new ClarifyRefusedError(cause.message);
    throw new ClarifyRefusedError(
      'Its frontmatter is not a list of properties, so nothing was written.',
    );
  }
}

function propertiesOf(ports: ArchivePorts, text: string): Readonly<Record<string, unknown>> {
  const { frontmatter } = splitFrontmatter(text);
  const problem = ports.markdown.frontmatterProblem(frontmatter);
  if (problem !== null) {
    throw new ClarifyRefusedError(`Its frontmatter could not be read (${problem}).`);
  }
  return ports.markdown.frontmatterProperties(frontmatter);
}

/**
 * The clarification with its project and its person as the vault spells
 * them, each checked before anything is written: the project as Process
 * checks it, the person as someone a task can wait on.
 */
async function asTheVaultSpells({
  ports,
  clarification,
  notePaths,
}: ClarifyRequest): Promise<Clarification> {
  const { project, waitingOn } = clarification;
  const spelled: { project?: VaultPath; waitingOn?: VaultPath } = {};
  if (project !== undefined) {
    spelled.project = await filingTarget({ ports, notePaths, project }).catch((cause: unknown) => {
      if (cause instanceof FilingRefusedError) throw new ClarifyRefusedError(cause.message);
      throw cause;
    });
  }
  if (waitingOn !== undefined && waitingOn !== null) {
    spelled.waitingOn = await personToWaitOn({ ports, notePaths, person: waitingOn });
  }
  return { ...clarification, ...spelled };
}

async function personToWaitOn({
  ports,
  notePaths,
  person,
}: {
  ports: ArchivePorts;
  notePaths: readonly VaultPath[];
  person: VaultPath;
}): Promise<VaultPath> {
  const found = vaultSpellingOf(person, notePaths);
  if (found === null) throw new ClarifyRefusedError('There is nobody to wait on at that path.');
  const { text } = await ports.fs.readTextFile(found);
  const type = noteTypeName(
    ports.markdown.frontmatterProperties(splitFrontmatter(text).frontmatter),
  );
  const refusal = waitingOnRefusal({ path: found, type });
  if (refusal !== null) throw new ClarifyRefusedError(refusal);
  return found;
}

/** A change the task rules refuse where the write lands is a refusal like any other. */
function refusedByTheRules(cause: unknown): never {
  if (cause instanceof TaskRuleRefusedError) throw new ClarifyRefusedError(cause.message);
  throw cause;
}
