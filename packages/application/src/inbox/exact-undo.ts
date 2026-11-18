import { noteTitle, type VaultPath } from '@dfai/domain';
import { moveAndStampNotes, type ArchivePorts } from '../archive/archive-notes.ts';
import { ClarifyRefusedError, type ClarifyUndo } from './clarify-inbox-item.ts';

/** What an exact undo got done before it had to stop, and what is left, for the person and the log. */
export interface UndoProgress {
  /** What was put back, a sentence each. */
  readonly done: readonly string[];
  /** What is left as it was, a sentence each: "Week still links to Notes/2026/Call Mara.md." */
  readonly left: readonly string[];
  /** Where the item is now. */
  readonly itemAt: VaultPath;
}

/**
 * An exact undo that wrote something and could not finish (#911). Nothing it
 * did is lost: undoing again finishes from where it stopped.
 */
export class PartlyUndoneError extends ClarifyRefusedError {
  constructor(readonly progress: UndoProgress) {
    super(`Partly undone: ${progress.left.join(' ')} Undo again to finish.`);
    this.name = 'PartlyUndoneError';
  }
}

type NoteStand = 'left' | 'restored' | 'changed';

interface Standing {
  /** Where the item is, and what it says there; null when it is in neither place. */
  readonly item: {
    readonly at: VaultPath;
    readonly text: string;
    readonly stand: NoteStand;
  } | null;
  readonly relinked: readonly { readonly path: VaultPath; readonly stand: NoteStand }[];
  /** Whether another note has taken the item's old place. */
  readonly taken: boolean;
}

/**
 * Puts back exactly what an Inbox assist row wrote, and nothing else (#911):
 * each other note its filing rewrote, then the item's text where it is, then
 * the item moved back, rewriting no link — each write held to the text it is
 * to replace. Everything is read first: one note changed since, the item's
 * place taken, or typing not saved, refuses with nothing touched. From the
 * first write on, a write refused stops it with a {@link PartlyUndoneError}
 * naming what is done and what is left; undoing again picks up from there.
 *
 * `keepItemEdit`: an item edited since is not a refusal — it is moved back
 * as it is, its edit kept (taking back a row an edit landed in mid-apply).
 */
export async function undoExactly({
  ports,
  undo,
  notePaths,
  keepItemEdit = false,
}: {
  ports: ArchivePorts;
  undo: ClarifyUndo;
  notePaths: readonly VaultPath[];
  keepItemEdit?: boolean;
}): Promise<{ readonly keptEdit: boolean }> {
  const standing = await standingOf(ports, undo);
  const blocker = blockerOf(ports, standing, keepItemEdit);
  const progress = { done: [] as string[], left: [] as string[] };
  const begun =
    standing.relinked.some((note) => note.stand === 'restored') ||
    standing.item?.stand === 'restored';
  if (blocker !== null) {
    if (!begun) throw new ClarifyRefusedError(blocker);
    throw new PartlyUndoneError({
      ...progress,
      left: [blocker],
      itemAt: standing.item?.at ?? undo.to,
    });
  }
  const item = standing.item!;
  // Stopped at the very first write, nothing was touched: a refusal like any other.
  const stop = (left: string) =>
    progress.done.length === 0
      ? new ClarifyRefusedError(`${left} Nothing was undone.`)
      : new PartlyUndoneError({ ...progress, left: [left], itemAt: item.at });
  for (const note of standing.relinked) {
    if (note.stand !== 'left') continue;
    const saved = undo.relinked!.find((each) => each.path === note.path)!;
    const put = await putBack(ports, {
      path: note.path,
      before: saved.before!,
      after: saved.after,
    });
    if (!put) throw stop(`${noteTitle(note.path)} still links to ${undo.to}.`);
    progress.done.push(`${noteTitle(note.path)} is as it was.`);
  }
  if (item.stand === 'left') {
    const put = await putBack(ports, { path: item.at, before: undo.before, after: undo.after });
    if (!put) throw stop(`${noteTitle(undo.from)} still says what the row wrote.`);
    progress.done.push(`${noteTitle(undo.from)} says what it said before.`);
  }
  if (item.at !== undo.from) {
    const moved = await moveBackAsItIs(ports, { from: item.at, to: undo.from, notePaths });
    if (!moved) throw stop(`${noteTitle(undo.from)} is still at ${item.at}.`);
  }
  return { keptEdit: item.stand === 'changed' };
}

/** Where everything the row wrote stands now: as the row left it, put back already, or changed by someone. */
async function standingOf(ports: ArchivePorts, undo: ClarifyUndo): Promise<Standing> {
  const read = (path: VaultPath) =>
    ports.fs.readTextFile(path).then(
      ({ text }) => text,
      // A note that cannot be read is not there to put back: said as such below.
      () => null,
    );
  const stand = (text: string | null, before: string | null, after: string): NoteStand =>
    text === after ? 'left' : before !== null && text === before ? 'restored' : 'changed';
  const atTo = await read(undo.to);
  const atFrom = undo.to === undo.from ? atTo : await read(undo.from);
  const item =
    atTo !== null
      ? { at: undo.to, text: atTo, stand: stand(atTo, undo.before, undo.after) }
      : atFrom !== null && atFrom === undo.before
        ? { at: undo.from, text: atFrom, stand: 'restored' as const }
        : null;
  const relinked = [];
  for (const note of undo.relinked ?? []) {
    relinked.push({
      path: note.path,
      stand: stand(await read(note.path), note.before, note.after),
    });
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

/** One note given back the text it had, held to the text the row left it; false when the host refuses. */
async function putBack(
  ports: ArchivePorts,
  note: { path: VaultPath; before: string; after: string },
): Promise<boolean> {
  try {
    const { text, modified } = await ports.fs.readTextFile(note.path);
    if (text !== note.after) return false;
    await ports.fs.writeTextFile({
      path: note.path,
      contents: note.before,
      expectedModified: modified,
      expectedText: note.after,
    });
  } catch {
    // Refused or unreadable: said as what is left, never thrown past the progress made.
    return false;
  }
  if (ports.editors.state(note.path) !== 'dirty') ports.editors.reload(note.path);
  return true;
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
