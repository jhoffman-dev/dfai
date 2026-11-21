import { conflictCopyPath, isoDate } from '../../domain/sync/index.ts';
import type { VaultPath } from '../../domain/vault/index.ts';
import type { Clock } from '../ports/index.ts';
import { writeFile, type VaultDeps } from './vault-deps.ts';

/**
 * One save of a note's text. With `basedOnText` (the text the editor loaded
 * or last saved) the save can tell when the note changed underneath the
 * editor, a sync having pulled another device's edit; `clock` then dates
 * the copy the editor's text goes to.
 */
export type SaveNoteRequest =
  | { readonly path: VaultPath; readonly text: string; readonly basedOnText?: undefined }
  | {
      readonly path: VaultPath;
      readonly text: string;
      readonly basedOnText: string;
      readonly clock: Clock;
    };

export type SaveNoteResult =
  | { readonly kind: 'saved'; readonly path: VaultPath }
  /** The note changed underneath: it was kept as it is, and the editor's text went to `path`. */
  | { readonly kind: 'forked'; readonly path: VaultPath; readonly keptPath: VaultPath };

/**
 * Keeps a note's new text: stored, marked dirty for the next sync, and read
 * into the index (that note only). Text that is already there changes nothing.
 * The caller debounces typing; this is one save.
 *
 * If the note's text is neither what the editor started from nor what it
 * saves now, someone else's edit arrived meanwhile: writing over it would
 * lose that edit silently on the next push, so the editor's text is saved as
 * a conflict copy beside it instead.
 */
export async function saveNoteText(
  deps: VaultDeps,
  request: SaveNoteRequest,
): Promise<SaveNoteResult> {
  const { path, text } = request;
  const stored = deps.session.file(path)?.text;
  if (stored === text) return { kind: 'saved', path };
  if (request.basedOnText !== undefined && stored !== undefined && stored !== request.basedOnText) {
    const copy = conflictCopyPath({
      path,
      date: isoDate(request.clock.now()),
      taken: [...deps.session.allFiles()].map((file) => file.path),
    });
    await writeFile(deps, copy, text);
    return { kind: 'forked', path: copy, keptPath: path };
  }
  await writeFile(deps, path, text);
  return { kind: 'saved', path };
}
