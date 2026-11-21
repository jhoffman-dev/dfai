import { noteTitle, type AssistIntent, type PassedOver, type VaultPath } from '@dfai/domain';
import { moveAndStampNotes, type ArchivePorts } from '../archive/archive-notes.ts';
import type { AsRead } from '../vault/ports.ts';
import { guardedWrites } from './assist-guard.ts';

/** What undoing one row's writes on its item needs: the item at both ends, and each other note it rewrote. */
export interface AssistItemUndo {
  readonly from: VaultPath;
  readonly to: VaultPath;
  /** The item's whole text before the row's first write. */
  readonly before: string;
  /** What the row's own last write left it saying. */
  readonly after: string;
  /** Each other note the row rewrote — its links to the item — with its text before and after. */
  readonly relinked: readonly {
    readonly path: VaultPath;
    readonly before: string;
    readonly after: string;
  }[];
}

/** What an undo got done before it had to stop, and what is left, for the person, the log and a retry. */
export interface UndoProgress {
  /** What was put back, a sentence each. */
  readonly done: readonly string[];
  /** What is left as it was, a sentence each: "Week still links to Notes/2026/Call Mara.md." */
  readonly left: readonly string[];
  /** Where the item is now. */
  readonly itemAt: VaultPath;
  /** Every note this undo has put back so far, earlier tries included: done, never touched again. */
  readonly restored: readonly VaultPath[];
  /** Whether the item's own text is put back already. */
  readonly itemRestored: boolean;
}

/** An undo refused before it touched anything, and why. */
export class UndoRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UndoRefusedError';
  }
}

/** An undo that wrote something and could not finish (#911): undoing again finishes it from where it stopped. */
export class PartlyUndoneError extends Error {
  constructor(readonly progress: UndoProgress) {
    super(`Partly undone: ${progress.left.join(' ')} Undo again to finish.`);
    this.name = 'PartlyUndoneError';
  }
}

type NoteStand = 'left' | 'restored' | 'changed';

/**
 * Puts back exactly what an Inbox assist row wrote, and nothing else (#911),
 * every write through the one guarded path (`assist-guard.ts`): each other
 * note its filing rewrote, then the item's text where it is, then the item
 * moved back rewriting no link, then each person the row made put in the
 * Trash. Everything is read first: a note changed since, the item's place
 * taken, or typing not saved, refuses with nothing touched. From the first
 * write on, a write refused stops it with a {@link PartlyUndoneError}; undoing
 * again — handed what is `restored` already — picks up from there, and a note
 * this undo already put back is never touched again, whatever it says now.
 *
 * `keepItemEdit`: an item edited since is not a refusal — it is moved back
 * as it is, its edit kept (taking back a row an edit landed in mid-apply).
 */
export async function undoExactly({
  ports,
  undo,
  made = [],
  notePaths,
  keepItemEdit = false,
  restored: already = [],
  itemRestored: itemAlready = false,
  mark,
}: {
  ports: ArchivePorts;
  undo: AssistItemUndo;
  /** The people the row made, as made: taken out while they say exactly that. */
  made?: readonly AsRead[];
  notePaths: readonly VaultPath[];
  keepItemEdit?: boolean;
  /** What an earlier try of this undo put back. */
  restored?: readonly VaultPath[];
  itemRestored?: boolean;
  /** Logs each write before it is made. */
  mark: (intent: AssistIntent) => Promise<void>;
}): Promise<{ readonly keptEdit: boolean; readonly kept: readonly PassedOver[] }> {
  const standing = await standingOf(ports, undo, new Set(already));
  const blocker = blockerOf(ports, standing, keepItemEdit);
  const progress = { done: [] as string[], restored: [...already], itemRestored: itemAlready };
  const begun = already.length > 0 || itemAlready || standing.item?.stand === 'restored';
  if (blocker !== null) {
    if (!begun) throw new UndoRefusedError(blocker);
    throw new PartlyUndoneError({
      ...progress,
      left: [blocker],
      itemAt: standing.item?.at ?? undo.to,
    });
  }
  const item = standing.item!;
  const guard = guardedWrites(ports, {
    known: knownOf(item, standing, made),
    items: new Set([item.at]),
    mark,
  });
  const stop = (left: string, at: VaultPath) =>
    progress.done.length === 0 && !begun
      ? new UndoRefusedError(`${left} Nothing was undone.`)
      : new PartlyUndoneError({ ...progress, left: [left], itemAt: at });
  for (const note of standing.relinked) {
    if (note.stand !== 'left') continue;
    const saved = undo.relinked.find((each) => each.path === note.path)!;
    const put = await written(() =>
      guard.ports.fs.writeTextFile({
        path: note.path,
        contents: saved.before,
        expectedModified: null,
      }),
    );
    if (!put) throw stop(`${noteTitle(note.path)} still links to ${undo.to}.`, item.at);
    progress.done.push(`${noteTitle(note.path)} is as it was.`);
    progress.restored.push(note.path);
  }
  // Its own text never changed (a row that only moved it): nothing to write back.
  if (item.stand === 'left' && undo.before !== undo.after) {
    const put = await written(() =>
      guard.ports.fs.writeTextFile({
        path: item.at,
        contents: undo.before,
        expectedModified: null,
      }),
    );
    if (!put) throw stop(`${noteTitle(undo.from)} still says what the row wrote.`, item.at);
    progress.done.push(`${noteTitle(undo.from)} says what it said before.`);
    progress.itemRestored = true;
  }
  if (item.at !== undo.from) {
    const moved = await moveBackAsItIs(guard.ports, { from: item.at, to: undo.from, notePaths });
    if (!moved) throw stop(`${noteTitle(undo.from)} is still at ${item.at}.`, item.at);
  }
  // Took the item back; anyone the row made is taken out while they are as made, else kept and said.
  const kept: PassedOver[] = [];
  for (const person of made) {
    const why = await refusedWhy(() => guard.ports.fs.trashEntry({ path: person.path }));
    if (why !== null) kept.push({ path: person.path, reason: why });
  }
  return { keptEdit: item.stand === 'changed', kept };
}

/** Why a guarded write did not land, in its own words; null when it did. */
async function refusedWhy(write: () => Promise<unknown>): Promise<string | null> {
  try {
    await write();
    return null;
  } catch (cause) {
    // Refused by the guard or the host: never thrown past the progress made, said by the caller.
    return cause instanceof Error ? cause.message : String(cause);
  }
}

/** Whether a guarded write landed. */
const written = async (write: () => Promise<unknown>): Promise<boolean> =>
  (await refusedWhy(write)) === null;

interface Standing {
  /** Where the item is, and what it says there; null when it is in neither place. */
  readonly item: {
    readonly at: VaultPath;
    readonly text: string;
    readonly stand: NoteStand;
  } | null;
  readonly relinked: readonly {
    readonly path: VaultPath;
    readonly text: string | null;
    readonly stand: NoteStand;
  }[];
  /** Whether another note has taken the item's old place. */
  readonly taken: boolean;
}

/** What each note is held to: what it says now, in a state this undo expects; the people as made. */
function knownOf(
  item: NonNullable<Standing['item']>,
  standing: Standing,
  made: readonly AsRead[],
): Map<VaultPath, string> {
  const known = new Map<VaultPath, string>([[item.at, item.text]]);
  for (const note of standing.relinked) {
    if (note.stand === 'left' && note.text !== null) known.set(note.path, note.text);
  }
  for (const person of made) known.set(person.path, person.text);
  return known;
}

/** Where everything the row wrote stands now: as the row left it, put back already, or changed by someone. */
async function standingOf(
  ports: ArchivePorts,
  undo: AssistItemUndo,
  already: ReadonlySet<VaultPath>,
): Promise<Standing> {
  const read = (path: VaultPath) =>
    ports.fs.readTextFile(path).then(
      ({ text }) => text,
      // A note that cannot be read is not there to put back: said as such below.
      () => null,
    );
  const stand = (text: string | null, before: string, after: string): NoteStand =>
    text === after ? 'left' : text === before ? 'restored' : 'changed';
  const atTo = await read(undo.to);
  const atFrom = undo.to === undo.from ? atTo : await read(undo.from);
  const item =
    atTo !== null
      ? { at: undo.to, text: atTo, stand: stand(atTo, undo.before, undo.after) }
      : atFrom !== null && atFrom === undo.before
        ? { at: undo.from, text: atFrom, stand: 'restored' as const }
        : null;
  const relinked = [];
  for (const note of undo.relinked) {
    // Put back by this undo already: done, whatever the person has written in it since.
    if (already.has(note.path)) continue;
    const text = await read(note.path);
    relinked.push({ path: note.path, text, stand: stand(text, note.before, note.after) });
  }
  return { item, relinked, taken: undo.to !== undo.from && atTo !== null && atFrom !== null };
}

/** Why the undo cannot go on, in the person's words; null when it can. */
function blockerOf(
  ports: ArchivePorts,
  { item, relinked, taken }: Standing,
  keepItemEdit: boolean,
): string | null {
  if (item === null) return 'It is not there any more, so nothing was undone.';
  if (item.stand === 'changed' && !keepItemEdit)
    return 'It was changed since, so it was left as it is.';
  if (ports.editors.state(item.at) === 'dirty')
    return 'It has typing not saved yet, so it was left as it is.';
  const changed = relinked.find((note) => note.stand === 'changed');
  if (changed !== undefined)
    return `${noteTitle(changed.path)} was changed since, so nothing was undone.`;
  if (taken) return 'Nothing was undone: another note has taken its place in the Inbox.';
  return null;
}

/** Moves the item back to exactly where it was, rewriting no link and writing nothing into it. */
async function moveBackAsItIs(
  ports: ArchivePorts,
  { from, to, notePaths }: { from: VaultPath; to: VaultPath; notePaths: readonly VaultPath[] },
): Promise<boolean> {
  const outcome = await moveAndStampNotes(
    { ports, paths: [from], notePaths, updateLinks: false },
    {
      refusal: () => null,
      destination: async () => to,
      stamp: () => () => ({ changes: {}, keepsBlock: true }),
    },
  );
  return outcome.moves.length > 0;
}
