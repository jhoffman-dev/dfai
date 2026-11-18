import {
  digestOf,
  logPathFor,
  noteTitle,
  parseAssistLog,
  type AssistMark,
  type LoggedEntry,
  type VaultPath,
} from '@dfai/domain';
import type { VaultFsPort } from '../vault/ports.ts';
import { INBOX_ASSIST_RULE } from './assist-log.ts';

/** A row Inbox assist began and never closed: a crash mid-row, and what it left on disk. */
export interface AssistUnfinished {
  readonly title: string;
  /** Where the item was when the row began. */
  readonly path: VaultPath;
  /** What the row was to do, what is on disk now, and how to put it right, a line each. */
  readonly lines: readonly string[];
}

/**
 * The rows Inbox assist's log says began and that no entry closes (#911):
 * each with what the row was to do and exactly what is on disk now — the
 * item as it was or not, each person it made there or not — and how to put
 * it right by hand. Read only: nothing is repaired.
 */
export async function findUnfinishedAssist(
  ports: { readonly fs: Pick<VaultFsPort, 'readNotes'> },
  /** Items this window is applying or undoing now: their rows are open, not left unfinished. */
  writing: ReadonlySet<string> = new Set(),
): Promise<AssistUnfinished[]> {
  const [log] = await ports.fs.readNotes([logPathFor(INBOX_ASSIST_RULE.id)]);
  if (log === undefined) return [];
  const entries = parseAssistLog(log.text);
  const closed = new Set(entries.flatMap(closedRow));
  const open = entries.filter(
    (entry): entry is Extract<AssistMark, { kind: 'begun' }> =>
      entry.kind === 'begun' && !closed.has(entry.row) && !writing.has(entry.path),
  );
  return Promise.all(open.map((begun) => leftOf(ports, begun, entries)));
}

/** The row an entry closes: a run, a failure or an undo that names it. */
function closedRow(entry: LoggedEntry): string[] {
  const closes = entry.kind === 'run' || entry.kind === 'failed' || entry.kind === 'undo';
  return closes && entry.row !== undefined ? [entry.row] : [];
}

async function leftOf(
  ports: { readonly fs: Pick<VaultFsPort, 'readNotes'> },
  begun: Extract<AssistMark, { kind: 'begun' }>,
  entries: readonly LoggedEntry[],
): Promise<AssistUnfinished> {
  const steps = entries.flatMap((entry) =>
    entry.kind === 'step' && entry.row === begun.row ? [entry] : [],
  );
  const made = steps.flatMap((step) =>
    step.done.flatMap((done) => (done.kind === 'created' ? [done] : [])),
  );
  const intents = steps.flatMap((step) => (step.about === undefined ? [] : [step.about]));
  const moved = intents.flatMap((about) => (about.doing === 'move' ? [about.to] : []));
  const toCreate = intents.flatMap((about) =>
    about.doing === 'create' && !made.some((person) => person.path === about.path)
      ? [about.path]
      : [],
  );
  const relinked = [
    ...new Set(intents.flatMap((about) => (about.doing === 'relink' ? [about.path] : []))),
  ];
  const paths = [begun.path, ...moved, ...made.map((person) => person.path), ...toCreate];
  const read = await ports.fs.readNotes(paths);
  const textOf = (path: VaultPath) => read.find((note) => note.path === path)?.text ?? null;
  const title = noteTitle(begun.path);
  const movedTo = moved.find((path) => textOf(path) !== null) ?? null;
  return {
    title,
    path: begun.path,
    lines: [
      `It was to do: ${begun.plan}`,
      movedTo !== null && textOf(begun.path) === null
        ? `${title} is at ${movedTo} now: what the row wrote may be in it. Check its properties, or move it back.`
        : itemLine(title, begun, textOf(begun.path)),
      ...made.map((person) => personLine(title, person, textOf(person.path))),
      ...toCreate.flatMap((path) =>
        textOf(path) === null
          ? []
          : [
              `${noteTitle(path)} may have been made (${path}) just before it stopped, and was not recorded as made. Link it from ${title}, or put it in the Trash.`,
            ],
      ),
      ...relinked.map(
        (path) =>
          `${noteTitle(path)} (${path}) may have had its links to ${title} rewritten. Check them.`,
      ),
    ],
  };
}

function itemLine(title: string, begun: { path: VaultPath; digest: string }, text: string | null) {
  if (text === null) {
    return `${title} is no longer at ${begun.path}: it may have been filed or archived. Look for it there.`;
  }
  if (digestOf(text) === begun.digest) return `${title} is where it was, as it was before.`;
  return `${title} is where it was, but says something else: what the row wrote may be in it. Check its properties.`;
}

function personLine(
  title: string,
  person: { path: VaultPath; digest?: string },
  text: string | null,
): string {
  const name = noteTitle(person.path);
  if (text === null) return `${name} was made (${person.path}) and is gone since.`;
  if (digestOf(text) === person.digest) {
    return `${name} was made (${person.path}), as made. Link it from ${title}, or put it in the Trash.`;
  }
  return `${name} was made (${person.path}) and changed since. Keep it, or put it in the Trash.`;
}
