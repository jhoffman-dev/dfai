import { splitFrontmatter, TASK_TYPE, type VaultPath } from '@dfai/domain';
import { ApiError } from './api-error.ts';
import { requiredString, type Fields } from './fields.ts';
import { readNote } from './note-io.ts';
import { isApiNotePath, notePathFrom } from './paths.ts';
import type { VaultRequest } from './vault-request.ts';
import { spelledAsVault } from './vault-spelling.ts';

/**
 * The task a body names under `field`, as the vault spells it, and when it
 * was read: refused unless it is a note of type task.
 */
export async function taskNoteFrom(
  request: VaultRequest,
  { fields, field }: { fields: Fields; field: string },
): Promise<{ path: VaultPath; modified: number }> {
  const path = await spelledAsVault({
    fs: request.fs,
    asked: notePathFrom(requiredString(fields, field), field),
    accepts: isApiNotePath,
  });
  const { text, modified } = await readNote(request, path);
  const type = request.markdown.frontmatterProperties(splitFrontmatter(text).frontmatter)['type'];
  if (typeof type !== 'string' || type.trim().toLowerCase() !== TASK_TYPE) {
    throw new ApiError('invalid', `${field} must be a note of type task, and ${path} is not one`);
  }
  return { path, modified };
}
