import {
  assistLinksBrokenByMoveBack,
  digestOf,
  logPathFor,
  parseAssistLog,
  messageWithoutPaths,
  noteTitle,
  type AssistIntent,
  type DoneAction,
  type LogEntry,
  type VaultPath,
} from '@dfai/domain';
import type { ActivityRecorder } from '../activity/ports.ts';
import { linksToUpdate } from '../vault/update-links.ts';
import type { AssistUndo } from './apply-inbox-assist.ts';
import { assistRecorder, INBOX_ASSIST_RULE, sayNotDone } from './assist-log.ts';
import { assistSides, type ApplyAssistPorts, type AssistSides } from './assist-sides.ts';
import { PartlyUndoneError, undoExactly } from './exact-undo.ts';

/** What undoing one applied row came to. */
export type AssistUndone =
  | {
      readonly kind: 'undone';
      /** Where the item is again. */
      readonly path: VaultPath;
      readonly words: string;
      readonly logged: boolean;
    }
  /** Refused, and nothing touched: why. */
  | { readonly kind: 'refused'; readonly words: string }
  /**
   * Begun and stopped (#911): what is done and what is left, logged with the
   * row kept open; `undo` finishes it from where it stopped.
   */
  | { readonly kind: 'partly'; readonly words: string; readonly undo: AssistUndo };

/** The vault's notes as one "Undo all" read them, once for all its rows. */
export type NotesRead = () => Promise<
  readonly { readonly path: VaultPath; readonly text: string }[]
>;

/**
 * Takes one applied row back (#911): the other notes its filing rewrote, the
 * item's text, the item moved back to exactly where it was, and each person
 * it added put in the Trash — every write through the one guarded path, each
 * logged before it is made under the row's own id, which the undo begins
 * again and closes only once it is whole. Refused, with nothing touched,
 * when a note it would put back says anything else, a person it added was
 * edited or is linked from another note, or moving the item back would
 * break a link made since.
 */
export async function undoAssistRow(
  ports: ApplyAssistPorts,
  request: { undo: AssistUndo; notePaths: readonly VaultPath[] },
): Promise<AssistUndone> {
  return undoOne(assistSides(ports), request);
}

async function undoOne(
  ports: AssistSides,
  {
    undo,
    notePaths,
    notesRead,
  }: { undo: AssistUndo; notePaths: readonly VaultPath[]; notesRead?: NotesRead },
): Promise<AssistUndone> {
  const recorder = assistRecorder(ports);
  const refuse = (problem: string): AssistUndone => {
    sayNotDone(recorder, {
      title: undo.title,
      path: undo.item.to,
      happened: { doing: 'undo', problem },
    });
    return { kind: 'refused', words: `Not undone: ${problem}` };
  };
  const read = notesRead ?? readOnce(ports, notePaths);
  const refusal =
    (await peopleRefusal(ports, undo)) ??
    (await linkedElsewhere(ports, undo, notePaths)) ??
    (await linkedSince(undo, notePaths, read));
  if (refusal !== null) return refuse(refusal);
  const mark = (about: AssistIntent) =>
    ports.log.mark({ kind: 'step', at: ports.clock.localNow(), row: undo.row, done: [], about });
  // What an earlier try of this undo put back, as its log says: done, even after a restart.
  const restored = [
    ...new Set([...(undo.progress?.restored ?? []), ...(await restoredBefore(ports, undo.row))]),
  ];
  try {
    await ports.log.mark({
      kind: 'begun',
      at: ports.clock.localNow(),
      row: undo.row,
      path: undo.item.to,
      digest: digestOf(undo.item.after),
      plan: `Undo: put ${undo.title} back as it was.`,
    });
  } catch {
    // Not logged, nothing is written: an undo never writes what its log does not say it began.
    return refuse('its log could not be written, so nothing was undone.');
  }
  try {
    const { kept } = await undoExactly({
      vault: ports.vault,
      undo: undo.item,
      made: undo.made,
      notePaths,
      restored,
      itemRestored: undo.progress?.itemRestored ?? false,
      mark,
    });
    return finished(ports, { recorder, undo, kept });
  } catch (cause) {
    if (cause instanceof PartlyUndoneError) return partly(ports, { recorder, undo, cause });
    // Refused before anything was written: the row is closed again, with why, as it was.
    const why = messageWithoutPaths(cause);
    const entry = closing(ports, undo, [], [{ path: undo.item.to, reason: why }]);
    await ports.log.entry({ recorder: quiet, entry, title: undo.title, path: undo.item.to });
    return refuse(why);
  }
}

/** A recorder that says nothing: the line is said once, by the caller. */
const quiet: ActivityRecorder = { record: () => undefined };

const closing = (
  ports: AssistSides,
  undo: AssistUndo,
  done: DoneAction[],
  left: { path: VaultPath; reason: string }[],
): LogEntry => ({
  kind: 'undo',
  at: ports.clock.localNow(),
  of: undo.at,
  done,
  left,
  row: undo.row,
});

async function finished(
  ports: AssistSides,
  {
    recorder,
    undo,
    kept,
  }: {
    recorder: ActivityRecorder;
    undo: AssistUndo;
    kept: readonly { path: VaultPath; reason: string }[];
  },
): Promise<AssistUndone> {
  const trashed = undo.made
    .filter((person) => !kept.some((each) => each.path === person.path))
    .map((person): DoneAction => ({ kind: 'trashed', path: person.path }));
  const done: DoneAction[] = [
    { kind: 'unassisted', from: undo.item.to, to: undo.item.from },
    ...trashed,
  ];
  const entry = closing(ports, undo, done, [...kept]);
  const logged = await ports.log.entry({
    recorder,
    entry,
    title: undo.title,
    path: undo.item.from,
  });
  const keptWords = kept.map((each) => `${noteTitle(each.path)} was kept: ${each.reason}`);
  const words = [
    'Put back as it was.',
    ...keptWords,
    logged ? '' : 'Its log could not be written.',
  ];
  return {
    kind: 'undone',
    path: undo.item.from,
    words: words.filter((part) => part !== '').join(' '),
    logged,
  };
}

/**
 * An undo that wrote something and stopped: what it put back and what is on
 * disk now logged as a step — the row stays open, so it is shown as left
 * unfinished after a restart — said as a warning, and held to be finished.
 */
async function partly(
  ports: AssistSides,
  {
    recorder,
    undo,
    cause,
  }: { recorder: ActivityRecorder; undo: AssistUndo; cause: PartlyUndoneError },
): Promise<AssistUndone> {
  const { itemAt, restored, itemRestored } = cause.progress;
  const read = await ports.vault.reads.fs.readNotes([itemAt, ...restored]);
  // What was put back, and what the item says now: enough to finish it by hand.
  const done = read.map((note): DoneAction => {
    const path = note.path as VaultPath;
    return restored.includes(path)
      ? { kind: 'unassisted', from: path, to: path }
      : { kind: 'assisted', from: path, to: path, digest: digestOf(note.text) };
  });
  await ports.log.mark({ kind: 'step', at: ports.clock.localNow(), row: undo.row, done });
  sayNotDone(recorder, {
    title: undo.title,
    path: itemAt,
    happened: { doing: 'undo', problem: `it is not finished. ${cause.progress.left.join(' ')}` },
  });
  return {
    kind: 'partly',
    words: cause.message,
    undo: { ...undo, progress: { restored, itemRestored } },
  };
}

/**
 * The notes an earlier try of undoing this row put back, as its log says
 * (#911): the steps since the row was last applied or closed that name a
 * note as put back. A try that read nothing finds nothing.
 */
async function restoredBefore(ports: AssistSides, row: string): Promise<VaultPath[]> {
  const [log] = await ports.vault.reads.fs.readNotes([logPathFor(INBOX_ASSIST_RULE.id)]);
  if (log === undefined) return [];
  const entries = parseAssistLog(log.text).filter((entry) => 'row' in entry && entry.row === row);
  const applied = entries.findLastIndex((entry) => entry.kind === 'run' || entry.kind === 'failed');
  return entries
    .slice(applied + 1)
    .flatMap((entry) =>
      entry.kind === 'step'
        ? entry.done.flatMap((done) => (done.kind === 'unassisted' ? [done.to] : []))
        : [],
    );
}

/** The vault's notes read once, the first time they are asked for. */
function readOnce(ports: AssistSides, notePaths: readonly VaultPath[]): NotesRead {
  let read: Promise<readonly { path: VaultPath; text: string }[]> | null = null;
  return () => {
    read ??= ports.vault.reads.fs
      .readNotes(notePaths)
      .then((notes) => notes.map((note) => ({ path: note.path as VaultPath, text: note.text })));
    return read;
  };
}

/** Why an undo is refused before anything is touched over the people it added; null when they are as made. */
async function peopleRefusal(ports: AssistSides, undo: AssistUndo): Promise<string | null> {
  for (const person of undo.made) {
    const read = await ports.vault.reads.fs.readTextFile(person.path).catch(() => null);
    if (read === null) return `${noteTitle(person.path)} is not where it was added.`;
    if (read.text !== person.text)
      return `${noteTitle(person.path)} it was changed since, so it was left as it is.`;
  }
  return null;
}

/**
 * Why moving the item back would break a link made since (#911): another
 * note — not one the row rewrote — links to it where it is now, by a link
 * that would open nothing once it moved back. Wiki links only. The notes are
 * read once per "Undo all". Null when none does.
 */
async function linkedSince(
  undo: AssistUndo,
  notePaths: readonly VaultPath[],
  read: NotesRead,
): Promise<string | null> {
  const { from, to } = undo.item;
  if (from === to) return null;
  const broken = assistLinksBrokenByMoveBack({
    notes: await read(),
    from,
    to,
    notePaths,
    ignoring: new Set(undo.item.relinked.map((note) => note.path)),
  });
  if (broken.length === 0) return null;
  return `${noteTitle(broken[0]!)} links to it where it is now, and undoing would break that link, so nothing was undone.`;
}

/**
 * Why a person the row added is not taken out (#911): a note other than the
 * item links them now, read from the notes as they are on disk — the index
 * may not have caught up with a link just saved. Null when none does.
 */
async function linkedElsewhere(
  ports: AssistSides,
  undo: AssistUndo,
  notePaths: readonly VaultPath[],
): Promise<string | null> {
  for (const person of undo.made) {
    // As if the person went: every link that would no longer open them is a note linking them.
    const gone = `${person.path.slice(0, -3)} (taken out).md` as VaultPath;
    const update = await linksToUpdate({
      fs: ports.vault.reads.fs,
      notePaths,
      move: { from: person.path, to: gone },
    });
    const other = update.notes.find((note) => note.path !== undo.item.to);
    if (other !== undefined) {
      return `${noteTitle(other.path)} links ${noteTitle(person.path)} now, so nothing was undone.`;
    }
  }
  return null;
}

/** "Undo all" (#909): each applied row taken back on its own, the last applied first; one refused leaves the rest to go on. */
export async function undoAssistRows(
  ports: ApplyAssistPorts,
  {
    undos,
    notePaths,
    onEach,
  }: {
    undos: readonly { path: VaultPath; undo: AssistUndo }[];
    notePaths: readonly VaultPath[];
    onEach?: (each: { path: VaultPath; undone: AssistUndone }) => void;
  },
): Promise<{ path: VaultPath; undone: AssistUndone }[]> {
  const results: { path: VaultPath; undone: AssistUndone }[] = [];
  let paths = notePaths;
  // Read once for every row (#911): each undo's own writes are to notes it rewrote itself.
  const sides = assistSides(ports);
  const notesRead = readOnce(sides, notePaths);
  for (const { path, undo } of [...undos].reverse()) {
    const undone = await undoOne(sides, { undo, notePaths: paths, notesRead });
    if (undone.kind === 'undone') paths = notesUndone(paths, undo);
    const each = { path, undone };
    results.push(each);
    onEach?.(each);
  }
  return results;
}

function notesUndone(notePaths: readonly VaultPath[], undo: AssistUndo): VaultPath[] {
  const made = new Set<string>(undo.made.map((person) => person.path));
  return notePaths
    .filter((path) => !made.has(path))
    .map((path) => (path === undo.item.to ? undo.item.from : path));
}
