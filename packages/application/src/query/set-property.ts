import {
  createVaultPath,
  isAtlasNote,
  opensUnclosedFrontmatter,
  repeatingTaskUpdate,
  splitFrontmatter,
} from '@dfai/domain';
import type { VaultFsPort } from '../vault/ports.ts';
import type { MarkdownPort } from '../notes/ports.ts';
import { NoteChangedError } from '../notes/note-changed-error.ts';
import { taskRuleProperties, withTaskRules } from '../gtd/task-rules.ts';

/** What counts as finishing a task, for the views that can tick one off. */
export interface CompletionRule {
  /** The property that says whether a task is finished. */
  readonly statusKey: string;
  /** The value that means finished. */
  readonly doneValue: string;
  /** What a repeating task goes back to once it rolls over. */
  readonly resetStatus: string;
}

/**
 * Changes one property of a note that is not open in the editor — a cell in a
 * table, for instance.
 *
 * The note is read, its frontmatter changed and the file written back, so the
 * file remains what everything else is derived from.
 */
export async function setNoteProperty({
  fs,
  markdown,
  path,
  key,
  value,
  completion,
  today,
}: {
  fs: VaultFsPort;
  markdown: MarkdownPort;
  path: string;
  key: string;
  value: unknown;
  /** `YYYY-MM-DD`: the day a task this finishes is dated (ADR-0029). */
  today: string;
  /**
   * When given, finishing a repeating task rolls it forward instead: its due
   * date moves on and it goes back into play, rather than the series ending.
   */
  completion?: CompletionRule;
}): Promise<void> {
  await setNoteProperties({
    fs,
    markdown,
    path,
    values: propertyChange({ key, value, ...(completion ? { completion } : {}) }),
    today,
  });
}

/**
 * What changing one property means, as something a write can carry out.
 *
 * Rolling a series forward needs the frontmatter the file already has, and
 * reading it separately would open a window in which the file could change. So
 * the rule travels as a function of the properties, to be run by whichever
 * write ends up doing the read — the file itself, or the editor holding it.
 */
export function propertyChange({
  key,
  value,
  completion,
}: {
  key: string;
  value: unknown;
  completion?: CompletionRule;
}): PropertyChanges {
  const rule = completion ?? null;
  const finishing = rule !== null && key === rule.statusKey && String(value) === rule.doneValue;
  const change = { [key]: value };
  if (!finishing || rule === null) return change;
  return (properties) =>
    repeatingTaskUpdate({
      properties,
      statusKey: rule.statusKey,
      resetStatus: rule.resetStatus,
    }) ?? change;
}

/**
 * What to write into a note's frontmatter: the changes themselves, or a rule
 * that works them out from the properties the note currently has.
 */
export type PropertyChanges =
  | Readonly<Record<string, unknown>>
  | ((properties: Readonly<Record<string, unknown>>) => Readonly<Record<string, unknown>>);

/**
 * Changes some properties of a note, leaving the rest of the file as it was.
 *
 * This is the one place a note that is not open in the editor is written, so
 * the byte-preserving read-change-write happens once — and so the task rules
 * (ADR-0029) are held here, against the frontmatter the write reads, for
 * every caller: a refused change throws `TaskRuleRefusedError` and writes
 * nothing. Moving a bar on a timeline changes when work starts *and* when it
 * ends, and those are one edit rather than two: written separately, the file
 * would be briefly inconsistent and the watcher would see two changes.
 *
 * The index is not touched here: it follows the file, never the other way round.
 */
export async function setNoteProperties({
  today,
  values,
  ...write
}: FrontmatterWrite & {
  /** `YYYY-MM-DD`: the day a task this finishes is dated. */
  today: string;
}): Promise<void> {
  await writeChanges({
    ...write,
    values: withTaskRules({ values, today }),
    read: (frontmatter) => taskRuleProperties(write.markdown, frontmatter),
  });
}

interface FrontmatterWrite {
  fs: VaultFsPort;
  markdown: MarkdownPort;
  path: string;
  values: PropertyChanges;
  /**
   * The modification time the caller read the note at. When given, a note that
   * has moved on since is refused with `NoteChangedError` rather than written.
   */
  ifModified?: number;
}

/**
 * The byte-preserving read-change-write of a file's frontmatter, with no
 * rules about what a note may hold: for DFAI's own files — a type's
 * definition, the vault's settings — which are not notes. A note is written
 * with {@link setNoteProperties}.
 */
export async function writeFrontmatterChanges(write: FrontmatterWrite): Promise<void> {
  await writeChanges({
    ...write,
    read: (frontmatter) => write.markdown.frontmatterProperties(frontmatter, { forWriting: true }),
    settingsFile: true,
  });
}

/**
 * A write refused because the file opens a frontmatter block it never closes.
 * Its settings are that block, which reads as none: a block written above it
 * would hold only the change, and the file would no longer say what it is (#683).
 */
export class UnclosedFrontmatterError extends Error {
  constructor(path: string) {
    super(
      `${path} has a frontmatter block with no closing ---, so nothing was written to it: add the --- line that ends the block, then try again`,
    );
    this.name = 'UnclosedFrontmatterError';
  }
}

/** The read-change-write itself, `values` given as a rule worked out against what `read` gives. */
async function writeChanges({
  fs,
  markdown,
  path,
  values,
  ifModified,
  read,
  settingsFile = false,
}: FrontmatterWrite & {
  read: (frontmatter: string | null) => Readonly<Record<string, unknown>>;
  /**
   * A file whose settings are its frontmatter, which a block it never closes
   * would lose. Every file under `.atlas` is one, however it is written (#683).
   */
  settingsFile?: boolean;
}): Promise<void> {
  const target = createVaultPath(path);
  const { text, modified } = await fs.readTextFile(target);
  if (ifModified !== undefined && ifModified !== modified) throw new NoteChangedError(target);
  const ownFile = settingsFile || isAtlasNote(target);
  if (ownFile && opensUnclosedFrontmatter(text)) throw new UnclosedFrontmatterError(target);
  const document = splitFrontmatter(text);

  const changes = typeof values === 'function' ? values(read(document.frontmatter)) : values;
  // Nothing to change writes nothing, rather than re-writing the note as it was.
  if (Object.keys(changes).length === 0) return;

  const frontmatter = markdown.updateFrontmatter(document.frontmatter, changes);
  const contents =
    document.frontmatter === null
      ? underNewFrontmatter(frontmatter, document.body)
      : frontmatter + document.body;
  // Nor do changes that leave every byte as it was: a value set to what it is, a key taken away that is not there.
  if (contents === text) return;
  await fs.writeTextFile({
    path: target,
    contents,
    expectedModified: modified,
    // The whole text too, so a write landing within the disk's timestamp tick is refused
    // (#245) — and the text a write is recorded as replacing is the text it replaced (#320).
    expectedText: text,
  });
}

const BYTE_ORDER_MARK = '\uFEFF';

/**
 * A note that had no frontmatter, under the block it is given: the block goes
 * after a byte-order mark, which only means anything first in the file, and
 * is written with the note's line endings when those are CRLF throughout.
 */
function underNewFrontmatter(frontmatter: string, body: string): string {
  const mark = body.startsWith(BYTE_ORDER_MARK) ? BYTE_ORDER_MARK : '';
  const text = body.slice(mark.length);
  const crlf = text.includes('\r\n') && !/(^|[^\r])\n/.test(text);
  return mark + (crlf ? frontmatter.replaceAll('\n', '\r\n') : frontmatter) + text;
}
