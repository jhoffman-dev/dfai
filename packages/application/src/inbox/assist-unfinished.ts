import {
  digestOf,
  logPathFor,
  noteTitle,
  openAssistRows,
  parseAssistLog,
  type AssistIntent,
  type AssistMark,
  type LoggedEntry,
  type VaultPath,
} from '@dfai/domain';
import type { Clock } from '../ports.ts';
import type { VaultFsPort } from '../vault/ports.ts';
import { INBOX_ASSIST_RULE, logMark } from './assist-log.ts';

/** A row Inbox assist began and never closed: a crash mid-row or mid-undo, or an undo that stopped, and what it left. */
export interface AssistUnfinished {
  /** The row, as its log names it: what putting it aside names. */
  readonly row: string;
  readonly title: string;
  /** Where the item was when the row, or its undo, began. */
  readonly path: VaultPath;
  /** What the row was to do, what is on disk now, and how to put it right, a line each. */
  readonly lines: readonly string[];
}

type Begun = Extract<AssistMark, { kind: 'begun' }>;

/**
 * The rows Inbox assist's log leaves open (#911) — begun, or begun again by
 * an undo, and never closed — each with what the row was to do and exactly
 * what is on disk now: the item as it was, changed, gone, or where it moved;
 * each person made; each note about to be written, made or put in the Trash;
 * and how to put it right by hand. Read only: nothing is repaired. A row this
 * window is writing now (`writing`, by item) is not unfinished.
 */
export async function findUnfinishedAssist(
  ports: { readonly fs: Pick<VaultFsPort, 'readNotes'> },
  writing: ReadonlySet<string> = new Set(),
): Promise<AssistUnfinished[]> {
  const [log] = await ports.fs.readNotes([logPathFor(INBOX_ASSIST_RULE.id)]);
  if (log === undefined) return [];
  const entries = parseAssistLog(log.text);
  const open = openAssistRows(entries);
  const lastBegun = new Map<string, Begun>();
  for (const entry of entries) if (entry.kind === 'begun') lastBegun.set(entry.row, entry);
  const rows = [...open].flatMap((row) => {
    const begun = lastBegun.get(row);
    return begun === undefined || writing.has(begun.path) ? [] : [begun];
  });
  return Promise.all(rows.map((begun) => leftOf(ports, begun, entries)));
}

/** Puts an unfinished row aside by hand (#911): it is no longer shown as left unfinished. Nothing in the vault changes. */
export async function dismissUnfinishedAssist(
  ports: { readonly fs: VaultFsPort; readonly clock: Pick<Clock, 'now' | 'localNow'> },
  row: string,
): Promise<void> {
  await logMark(ports, { kind: 'dismissed', at: ports.clock.localNow(), row });
}

/** The steps of a row since it last began: what it was doing when it stopped. */
function stepsOf(begun: Begun, entries: readonly LoggedEntry[]) {
  const from = entries.lastIndexOf(begun);
  return entries
    .slice(from + 1)
    .flatMap((entry) => (entry.kind === 'step' && entry.row === begun.row ? [entry] : []));
}

async function leftOf(
  ports: { readonly fs: Pick<VaultFsPort, 'readNotes'> },
  begun: Begun,
  entries: readonly LoggedEntry[],
): Promise<AssistUnfinished> {
  const steps = stepsOf(begun, entries);
  // Anyone the row made, since its apply began: an undo's steps name them only as about to go.
  const madeByPath = new Map<VaultPath, { path: VaultPath; digest?: string }>();
  for (const entry of entries) {
    if (entry.kind !== 'step' || entry.row !== begun.row) continue;
    // The latest says what is on disk: a rollback that stopped records each person again.
    for (const done of entry.done) if (done.kind === 'created') madeByPath.set(done.path, done);
  }
  const made = [...madeByPath.values()];
  const intents = steps.flatMap((step) => (step.about === undefined ? [] : [step.about]));
  const moved = intents.flatMap((about) => (about.doing === 'move' ? [about.to] : []));
  const touched = touchedBy(intents, begun.path, made);
  const paths = [
    begun.path,
    ...moved,
    ...made.map((person) => person.path),
    ...touched.map((each) => each.path),
  ];
  const read = await ports.fs.readNotes([...new Set(paths)]);
  const textOf = (path: VaultPath) => read.find((note) => note.path === path)?.text ?? null;
  const title = noteTitle(begun.path);
  const movedTo = moved.find((path) => textOf(path) !== null) ?? null;
  return {
    row: begun.row,
    title,
    path: begun.path,
    lines: [
      `It was to do: ${begun.plan}`,
      movedTo !== null && textOf(begun.path) === null
        ? `${title} is at ${movedTo} now: what the row wrote may be in it. Check its properties, or move it back.`
        : itemLine(title, begun, textOf(begun.path)),
      ...made.map((person) => personLine(title, person, textOf(person.path))),
      ...touched.flatMap((each) => touchedLine(title, each, textOf(each.path))),
    ],
  };
}

/** The notes a row was about to write, make or trash, other than the item and anyone it is known to have made. */
function touchedBy(
  intents: readonly AssistIntent[],
  item: VaultPath,
  made: readonly { path: VaultPath }[],
): { path: VaultPath; doing: AssistIntent['doing'] }[] {
  const seen = new Map<VaultPath, AssistIntent['doing']>();
  for (const about of intents) {
    if (about.doing === 'move' || about.doing === 'folder' || about.path === item) continue;
    if (about.doing === 'create' && made.some((person) => person.path === about.path)) continue;
    seen.set(about.path, about.doing);
  }
  return [...seen].map(([path, doing]) => ({ path, doing }));
}

function touchedLine(
  title: string,
  { path, doing }: { path: VaultPath; doing: AssistIntent['doing'] },
  text: string | null,
): string[] {
  const name = noteTitle(path);
  if (doing === 'create') {
    return text === null
      ? []
      : [
          `${name} may have been made (${path}) just before it stopped, and was not recorded as made. Link it from ${title}, or put it in the Trash.`,
        ];
  }
  if (doing === 'trash') {
    return [
      text === null
        ? `${name} (${path}) is in the Trash.`
        : `${name} (${path}) is still there: put it in the Trash if ${title} no longer links it.`,
    ];
  }
  return [`${name} (${path}) may have had its links to ${title} rewritten. Check them.`];
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
