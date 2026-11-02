import { joinFrontmatter, type EditorDocument } from '@dfai/domain';
import type { VaultFsPort } from '../vault/ports.ts';
import type { MarkdownPort } from './ports.ts';
import type { OpenNote } from './open-note.ts';
import { taskRuleProperties, withTaskRules } from '../gtd/task-rules.ts';
import type { PropertyChanges } from '../query/set-property.ts';

export interface SavedNote {
  readonly note: OpenNote;
  /** The full file text that was written, frontmatter included. */
  readonly text: string;
}

/** The note's body as the edited document has it, untouched blocks in their original bytes. */
export function editedBody({
  markdown,
  note,
  doc,
}: {
  markdown: MarkdownPort;
  note: OpenNote;
  doc: EditorDocument;
}): string {
  return markdown.serializeBody({ originalBody: note.originalBody, parsed: note.parsed, doc });
}

/**
 * Writes the edited document back to the note.
 *
 * The frontmatter is re-attached exactly as it was read, and blocks the user did
 * not touch keep their original bytes. The save is refused outright if the file
 * changed on disk since it was opened — its time, or its bytes when the time
 * stood still (#245) — rather than overwriting the other change.
 */
export async function saveNote({
  fs,
  markdown,
  note,
  doc,
  changes,
}: {
  fs: VaultFsPort;
  markdown: MarkdownPort;
  note: OpenNote;
  doc: EditorDocument;
  /**
   * Frontmatter keys to change as part of this save. Going through the same write
   * as the body means editing a property can never discard unsaved body edits.
   * They are held to the task rules (ADR-0029) against the frontmatter the note
   * was read with, as the write reads it; a refused change throws `TaskRuleRefusedError` and nothing,
   * body included, is written.
   */
  changes?: {
    readonly values: PropertyChanges;
    /** `YYYY-MM-DD`: the day a task this finishes is dated. */
    readonly today: string;
  };
}): Promise<SavedNote> {
  const ruled =
    changes === undefined
      ? undefined
      : withTaskRules({ values: changes.values, today: changes.today })(
          // Read again as the write reads it: a block listing a key twice shows
          // no properties, and the rules must judge what the write will change.
          taskRuleProperties(markdown, note.frontmatter),
        );
  const body = editedBody({ markdown, note, doc });
  const frontmatter =
    ruled === undefined || Object.keys(ruled).length === 0
      ? note.frontmatter
      : markdown.updateFrontmatter(note.frontmatter, ruled);
  const text = joinFrontmatter(frontmatter, body);

  const modified = await fs.writeTextFile({
    path: note.path,
    contents: text,
    expectedModified: note.modified,
    expectedText: note.onDisk,
  });

  // Re-parse so the next save compares against what is now on disk.
  const parsed = markdown.parseBody(body);
  return {
    text,
    note: {
      ...note,
      frontmatter,
      properties: markdown.frontmatterProperties(frontmatter),
      originalBody: body,
      parsed,
      doc: parsed.doc,
      modified,
      onDisk: text,
    },
  };
}
