import {
  capturedTaskStatus,
  createVaultPath,
  firstNamedLine,
  INBOX_DIRECTORY,
  splitFrontmatter,
  TASK_KEYS,
  TASK_TYPE,
  taskTypeOf,
  type VaultPath,
} from '@dfai/domain';
import { createNote } from '../notes/create-note.ts';
import type { MarkdownPort } from '../notes/ports.ts';
import { loadObjectTypes, noteTypeName } from '../types/load-types.ts';
import { ensureFolder } from '../vault/create-folder.ts';
import type { VaultFsPort } from '../vault/ports.ts';

/**
 * Makes a captured note in the Inbox — made first if the vault has none — and
 * says where it landed. Whatever is open, capture lands there: it is the one
 * place everything waits to be processed (P30-01). A name in use is numbered,
 * as a new note's is. A captured task starts with the Inbox status when the
 * Task type has it (P30-02), and is held to the task rules as any new note is.
 */
export async function captureToInbox({
  fs,
  markdown,
  today,
  name,
  notePaths,
  contents,
}: {
  fs: VaultFsPort;
  markdown: MarkdownPort;
  /** `YYYY-MM-DD`, from the injected clock. */
  today: string;
  name: string;
  notePaths: readonly VaultPath[];
  /** Starting text, when capture makes its note from the task template. */
  contents?: string;
}): Promise<VaultPath> {
  const started =
    contents === undefined ? undefined : await capturedTaskContents({ fs, markdown, contents });
  const folder = await ensureFolder({ fs, folder: createVaultPath(INBOX_DIRECTORY) });
  return createNote({
    fs,
    markdown,
    today,
    // Pasted rather than typed, a paragraph is named by its first line (#672).
    name: firstNamedLine(name),
    beside: null,
    folder,
    notePaths,
    ...(started === undefined ? {} : { contents: started }),
  });
}

/**
 * A captured task's starting text: the Task template's, with its status set
 * to where new tasks start — the Inbox — when the vault's Task type has that
 * status (ADR-0029). A vault still on statuses of its own keeps the
 * template's, and text that is not a task is left as it is.
 */
export async function capturedTaskContents({
  fs,
  markdown,
  contents,
}: {
  fs: VaultFsPort;
  markdown: MarkdownPort;
  contents: string;
}): Promise<string> {
  const { frontmatter, body } = splitFrontmatter(contents);
  const properties = markdown.frontmatterProperties(frontmatter);
  if (frontmatter === null || noteTypeName(properties)?.toLowerCase() !== TASK_TYPE)
    return contents;
  const types = await loadObjectTypes({ fs, markdown });
  const status = capturedTaskStatus(taskTypeOf(types));
  if (status === null || properties[TASK_KEYS.status] === status) return contents;
  return markdown.updateFrontmatter(frontmatter, { [TASK_KEYS.status]: status }) + body;
}
