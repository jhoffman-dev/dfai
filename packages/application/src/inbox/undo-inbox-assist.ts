import {
  messageWithoutPaths,
  noteTitle,
  type DoneAction,
  type LogEntry,
  type PassedOver,
  type VaultPath,
} from '@dfai/domain';
import type { ApplyAssistPorts, AssistUndo } from './apply-inbox-assist.ts';
import { assistRecorder, logAssist, sayNotDone } from './assist-log.ts';
import { undoClarifyInboxItem } from './clarify-inbox-item.ts';

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
  | { readonly kind: 'refused'; readonly words: string };

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
    sayNotDone(recorder, { title: undo.title, path: undo.item.to, happened: { doing: 'undo', problem } });
    return { kind: 'refused', words: `Not undone: ${problem}` };
  };
  const refusal = await undoRefusal(ports, undo);
  if (refusal !== null) return refuse(refusal);
  try {
    await undoClarifyInboxItem({ ports, undo: undo.item, notePaths });
  } catch (cause) {
    return refuse(messageWithoutPaths(cause));
  }
  const { done, left } = await takeOutPeople(ports, undo);
  const entry: LogEntry = {
    kind: 'undo',
    at: ports.clock.localNow(),
    of: undo.at,
    done: [{ kind: 'unassisted', from: undo.item.to, to: undo.item.from }, ...done],
    left,
  };
  const logged = await logAssist(ports, { recorder, entry, title: undo.title, path: undo.item.from });
  const kept = left.map((each) => `${noteTitle(each.path)} was kept: ${each.reason}`);
  const words = ['Put back as it was.', ...kept, logged ? '' : 'Its log could not be written.'];
  return { kind: 'undone', path: undo.item.from, words: words.filter((part) => part !== '').join(' '), logged };
}

const CHANGED_SINCE = 'it was changed since, so it was left as it is.';

/** Why an undo is refused before anything is touched; null when every note is as the row left it. */
async function undoRefusal(ports: ApplyAssistPorts, undo: AssistUndo): Promise<string | null> {
  const { item } = undo;
  if (ports.editors.state(item.to) === 'dirty') return 'it has typing not saved yet.';
  // Gone from where the row left it: the Inbox's undo finds it, or says it is not there.
  const now = await ports.fs.readTextFile(item.to).catch(() => null);
  if (now !== null && now.text !== item.after) return CHANGED_SINCE;
  for (const person of undo.made) {
    const read = await ports.fs.readTextFile(person.path).catch(() => null);
    if (read === null) return `${noteTitle(person.path)} is not where it was added.`;
    if (read.text !== person.text) return `${noteTitle(person.path)} ${CHANGED_SINCE}`;
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
