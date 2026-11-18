import {
  createVaultPath,
  messageWithoutPaths,
  noteTitle,
  type DoneAction,
  type LogEntry,
  type PassedOver,
  type VaultPath,
} from '@dfai/domain';
import type { ActivityRecorder } from '../activity/ports.ts';
import type { ApplyAssistPorts, AssistUndo } from './apply-inbox-assist.ts';
import { assistRecorder, logAssist, sayNotDone } from './assist-log.ts';
import { linksToUpdate } from '../vault/update-links.ts';
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
  /** Begun and stopped (#911): what is done and what is left, logged; undoing again finishes it. */
  | { readonly kind: 'partly'; readonly words: string };

/**
 * Takes one applied row back (#909), through the Inbox's exact undo: the item
 * goes back to exactly where it was and says exactly what it said, and each
 * person the row added is put in the Trash. Refused, with nothing touched,
 * when the item or a person it added says anything other than the row left,
 * or the item has typing not saved: an edit since is kept.
 */
export async function undoAssistRow(
  ports: ApplyAssistPorts,
  { undo, notePaths }: { undo: AssistUndo; notePaths: readonly VaultPath[] },
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
  const refusal =
    (await undoRefusal(ports, undo)) ??
    (await linkedElsewhere(ports, undo, notePaths)) ??
    (await linkedSince(ports, undo, notePaths));
  if (refusal !== null) return refuse(refusal);
  try {
    await undoExactly({ ports, undo: undo.item, notePaths });
  } catch (cause) {
    if (cause instanceof PartlyUndoneError) return partly(ports, { recorder, undo, cause });
    return refuse(messageWithoutPaths(cause));
  }
  const { done, left } = await takeOutPeople(ports, undo);
  const entry: LogEntry = {
    kind: 'undo',
    at: ports.clock.localNow(),
    of: undo.at,
    done: [{ kind: 'unassisted', from: undo.item.to, to: undo.item.from }, ...done],
    left,
    row: undo.row,
  };
  const logged = await logAssist(ports, {
    recorder,
    entry,
    title: undo.title,
    path: undo.item.from,
  });
  const kept = left.map((each) => `${noteTitle(each.path)} was kept: ${each.reason}`);
  const words = ['Put back as it was.', ...kept, logged ? '' : 'Its log could not be written.'];
  return {
    kind: 'undone',
    path: undo.item.from,
    words: words.filter((part) => part !== '').join(' '),
    logged,
  };
}

const CHANGED_SINCE = 'it was changed since, so it was left as it is.';

/** An undo that wrote something and stopped: what is left, logged as an undo entry and said. */
async function partly(
  ports: ApplyAssistPorts,
  {
    recorder,
    undo,
    cause,
  }: { recorder: ActivityRecorder; undo: AssistUndo; cause: PartlyUndoneError },
): Promise<AssistUndone> {
  const { left, itemAt } = cause.progress;
  const entry: LogEntry = {
    kind: 'undo',
    at: ports.clock.localNow(),
    of: undo.at,
    done: [],
    left: left.map((reason) => ({ path: itemAt, reason })),
    row: undo.row,
  };
  await logAssist(ports, { recorder, entry, title: undo.title, path: itemAt });
  return { kind: 'partly', words: cause.message };
}

/**
 * Why moving the item back would break a link made since (#911): another
 * note, not one the row rewrote, now links to it by the path it is at — and
 * would open nothing once it moved back. A link by its title still opens it
 * there. Read from the notes on disk. Null when none does.
 */
async function linkedSince(
  ports: ApplyAssistPorts,
  undo: AssistUndo,
  notePaths: readonly VaultPath[],
): Promise<string | null> {
  const { from, to } = undo.item;
  if (from === to) return null;
  const ours = new Set<string>([to, ...(undo.item.relinked ?? []).map((note) => note.path)]);
  const others = notePaths.filter((path) => !ours.has(path));
  const target = to.slice(0, -'.md'.length);
  const byPath = new RegExp(`\\[\\[${escaped(target)}(?:\\.md)?(?:[|#\\]])`, 'u');
  const notes = await ports.fs.readNotes(others);
  const linking = notes.find((note) => byPath.test(note.text));
  if (linking === undefined) return null;
  return `${noteTitle(linking.path as VaultPath)} links to it where it is now, and undoing would break that link, so nothing was undone.`;
}

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

/** Why an undo is refused before anything is touched; null when every note is as the row left it. */
async function undoRefusal(ports: ApplyAssistPorts, undo: AssistUndo): Promise<string | null> {
  const { item } = undo;
  if (ports.editors.state(item.to) === 'dirty') return 'it has typing not saved yet.';
  // Gone from where the row left it: the Inbox's undo finds it, or says it is not there.
  const now = await ports.fs.readTextFile(item.to).catch(() => null);
  // Its text put back already is an undo stopped part-way: undoing again finishes it.
  if (now !== null && now.text !== item.after && now.text !== item.before) return CHANGED_SINCE;
  for (const person of undo.made) {
    const read = await ports.fs.readTextFile(person.path).catch(() => null);
    if (read === null) return `${noteTitle(person.path)} is not where it was added.`;
    if (read.text !== person.text) return `${noteTitle(person.path)} ${CHANGED_SINCE}`;
  }
  return null;
}

/**
 * Why a person the row added is not taken out (#911): a note other than the
 * item links them now, read from the notes as they are on disk — the index
 * may not have caught up with a link just saved. Null when none does.
 */
async function linkedElsewhere(
  ports: ApplyAssistPorts,
  undo: AssistUndo,
  notePaths: readonly VaultPath[],
): Promise<string | null> {
  for (const person of undo.made) {
    // As if the person went: every link that would no longer open them is a note linking them.
    const gone = createVaultPath(`${person.path.slice(0, -3)} (taken out).md`);
    const update = await linksToUpdate({
      fs: ports.fs,
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

/** Puts each person the row added in the Trash, while the host finds them exactly as made. */
async function takeOutPeople(
  ports: ApplyAssistPorts,
  undo: AssistUndo,
): Promise<{ done: DoneAction[]; left: PassedOver[] }> {
  const done: DoneAction[] = [];
  const left: PassedOver[] = [];
  for (const person of undo.made) {
    await ports.fs.trashEntry({ path: person.path, unchanged: [person] }).then(
      () => void done.push({ kind: 'trashed', path: person.path }),
      (cause: unknown) => void left.push({ path: person.path, reason: messageWithoutPaths(cause) }),
    );
  }
  return { done, left };
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
  for (const { path, undo } of [...undos].reverse()) {
    const undone = await undoAssistRow(ports, { undo, notePaths: paths });
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
