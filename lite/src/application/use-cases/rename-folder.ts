import {
  foldedPath,
  isNotePath,
  isWithin,
  noteNameProblem,
  pathAfterMove,
  type VaultPath,
} from '../../domain/vault/index.ts';
import { renameNote } from './rename-note.ts';
import type { VaultDeps } from './vault-deps.ts';

export type RenameFolderResult =
  | {
      readonly kind: 'renamed';
      /** Notes moved. */
      readonly moved: number;
      /** Links rewritten to follow them. */
      readonly retargeted: number;
    }
  | { readonly kind: 'refused'; readonly reason: string };

function folderProblem(deps: VaultDeps, from: VaultPath, to: VaultPath): string | null {
  if (to === '') return 'A folder needs a name.';
  for (const part of to.split('/')) {
    const problem = noteNameProblem(part);
    if (problem !== null) return problem;
  }
  if (isWithin(to, from)) return 'A folder cannot move inside itself.';
  const staying = new Set<string>();
  for (const file of deps.session.allFiles()) {
    if (!isWithin(file.path, from)) staying.add(foldedPath(file.path));
  }
  for (const file of deps.session.allFiles()) {
    const after = isWithin(file.path, from) ? pathAfterMove(file.path, { from, to }) : null;
    if (after !== null && staying.has(foldedPath(after))) return `A note is already at ${after}.`;
  }
  return null;
}

/**
 * Renames or moves a folder: every note in it, at any depth, moves with
 * `renameNote`, so every link to each is rewritten and favourites follow.
 * Checked whole first, so a clash refuses before anything moves. Files in
 * it that are not notes stay where they are (git has no folder to rename).
 */
export async function renameFolder(
  deps: VaultDeps,
  { from, to }: { from: VaultPath; to: VaultPath },
): Promise<RenameFolderResult> {
  if (from === to) return { kind: 'renamed', moved: 0, retargeted: 0 };
  const problem = folderProblem(deps, from, to);
  if (problem !== null) return { kind: 'refused', reason: problem };
  const notes = [...deps.session.allFiles()]
    .map((file) => file.path)
    .filter((path) => isNotePath(path) && isWithin(path, from))
    .sort();
  let retargeted = 0;
  for (const path of notes) {
    const result = await renameNote(deps, {
      from: path,
      to: pathAfterMove(path, { from, to }) ?? path,
    });
    if (result.kind === 'refused') return result;
    retargeted += result.retargeted;
  }
  return { kind: 'renamed', moved: notes.length, retargeted };
}
