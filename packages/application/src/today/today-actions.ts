import {
  createVaultPath,
  KeyAsWritten,
  splitFrontmatter,
  stillAsRead,
  taskAsRead,
  TASK_KEYS,
  type TaskAsRead,
} from '@dfai/domain';
import type { MarkdownPort } from '../notes/ports.ts';
import type { PropertyChanges } from '../query/set-property.ts';
import type { VaultFsPort } from '../vault/ports.ts';

type Properties = Readonly<Record<string, unknown>>;

/** A task no longer says what an action — or its undo — took it to say, so nothing was written. */
export class ChangedSinceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChangedSinceError';
  }
}

const STALE_ROW = 'This task has changed since the page read it, so nothing was done. Try again.';
const STALE_UNDO = 'This task has changed since, so the change was not undone.';

/**
 * A row's change, made only while the task still is what the row showed
 * (#111): judged against the properties the write itself reads, so nothing
 * can change between the look and the write. Refused with
 * {@link ChangedSinceError} otherwise, and nothing is written.
 */
export function whileAsRead({
  values,
  row,
}: {
  values: PropertyChanges;
  row: TaskAsRead;
}): PropertyChanges {
  return (properties) => {
    if (!stillAsRead({ row, properties })) throw new ChangedSinceError(STALE_ROW);
    return typeof values === 'function' ? values(properties) : values;
  };
}

/** A task's frontmatter at one moment: each key as written and as read. */
interface Frontmatter {
  readonly texts: Readonly<Record<string, string>>;
  readonly properties: Properties;
  readonly modified: number;
}

async function frontmatterOf({
  fs,
  markdown,
  path,
}: {
  fs: Pick<VaultFsPort, 'readTextFile'>;
  markdown: Pick<MarkdownPort, 'frontmatterKeyTexts' | 'frontmatterProperties'>;
  path: string;
}): Promise<Frontmatter> {
  const { text, modified } = await fs.readTextFile(createVaultPath(path));
  const { frontmatter } = splitFrontmatter(text);
  return {
    texts: markdown.frontmatterKeyTexts(frontmatter),
    properties: frontmatter === null ? {} : markdown.frontmatterProperties(frontmatter),
    modified,
  };
}

const sameValue = (left: unknown, right: unknown) =>
  JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

/**
 * The keys a write changed, added or took out — whoever changed them: what
 * the page set, what a repeating task's roll set, what the task rules added.
 * `completed` is always among them, so the undo says what it held: the task
 * rules take a reopened task's day away unless the change names one.
 */
function keysChanged(before: Frontmatter, after: Frontmatter): string[] {
  return [...new Set([...keysDiffering(before, after), TASK_KEYS.completed])];
}

/** The keys whose text or value differs between two reads of a task's frontmatter. */
function keysDiffering(before: Frontmatter, after: Frontmatter): string[] {
  const keys = new Set([...Object.keys(before.properties), ...Object.keys(after.properties)]);
  return [...keys].filter(
    (key) =>
      before.texts[key] !== after.texts[key] ||
      !sameValue(before.properties[key], after.properties[key]),
  );
}

/**
 * Makes a change to a task and answers with what takes it back (#111).
 *
 * The task's frontmatter is read before the write and after it, so the undo
 * knows every key the write left different — not only those the page set —
 * and gives each back exactly as it was written, comments and quotes and
 * all. The undo is itself a change: it refuses with {@link ChangedSinceError}
 * when a key no longer holds what the write left, so it never undoes a
 * later edit. `write` is handed the stamp the task was read at, to refuse a
 * file that moved on in between.
 */
export async function changeUndoably({
  fs,
  markdown,
  path,
  write,
}: {
  fs: Pick<VaultFsPort, 'readTextFile'>;
  markdown: Pick<MarkdownPort, 'frontmatterKeyTexts' | 'frontmatterProperties'>;
  path: string;
  /** Carries the change out, however this note is written: through a pane holding it, or to its file. */
  write: (readAt: number) => Promise<void>;
}): Promise<UndoableChange> {
  const before = await frontmatterOf({ fs, markdown, path });
  await write(before.modified);
  const was = taskAsRead(before.properties);
  // The change is written by now. If the task cannot be read back, what it
  // changed is not known, so no undo is offered — it is not a failed write.
  const after = await frontmatterOf({ fs, markdown, path }).catch(() => null);
  if (after === null) return { was, undo: null, wrote: true };
  const keys = keysChanged(before, after);
  return {
    was,
    // The task reads as it did: the change came to nothing (#107), so there is nothing to read back.
    wrote: keysDiffering(before, after).length > 0,
    undo: (properties) => {
      const asLeft = keys.every((key) => sameValue(properties[key], after.properties[key]));
      if (!asLeft) throw new ChangedSinceError(STALE_UNDO);
      return Object.fromEntries(keys.map((key) => [key, asItWas(before, key)]));
    },
  };
}

/** A change that was made, and the way back from it. */
export interface UndoableChange {
  /**
   * The change that takes it back, refused once the task says something
   * else. Null when the task could not be read back after the write: the
   * change was made, and there is no knowing what to restore.
   */
  readonly undo: PropertyChanges | null;
  /** What the task was before the change — and is again once it is undone. */
  readonly was: TaskAsRead;
  /**
   * Whether the file was written. False when the change came to nothing —
   * already so — which leaves the index nothing to read back. True when it
   * could not be read back, since then it is not known.
   */
  readonly wrote: boolean;
}

/** A key as the task held it before: its own text when the block's keys can be told apart, else its value; null for none. */
function asItWas(before: Frontmatter, key: string): unknown {
  const text = before.texts[key];
  if (text !== undefined) return new KeyAsWritten(text);
  return before.properties[key] ?? null;
}
