import { favoritesAfterMove } from '../../domain/favorites/index.ts';
import {
  linkKeysOf,
  moveResolvers,
  notesAfterMove,
  retargetLinks,
} from '../../domain/links/index.ts';
import {
  foldedPath,
  isNotePath,
  noteNameProblem,
  withoutExtension,
  type VaultPath,
} from '../../domain/vault/index.ts';
import type { StoredFile } from '../ports/index.ts';
import { writeFavorites } from './favorites.ts';
import { writeFile, type VaultDeps } from './vault-deps.ts';

export type RenameResult =
  | {
      readonly kind: 'renamed';
      readonly path: VaultPath;
      /** How many links in the vault were rewritten to follow it. */
      readonly retargeted: number;
    }
  | { readonly kind: 'refused'; readonly reason: string };

/**
 * Renames or moves a note to `to` (a full path, `.md` included), rewriting
 * every link the move would break, in every note, and following it in the
 * favourites. Refused when the new name breaks the file-name rules or
 * another file already has the path, case aside.
 */
export async function renameNote(
  deps: VaultDeps,
  { from, to }: { from: VaultPath; to: VaultPath },
): Promise<RenameResult> {
  const file = deps.session.file(from);
  if (file === null) return { kind: 'refused', reason: `There is no note at ${from}.` };
  if (to === from) return { kind: 'renamed', path: to, retargeted: 0 };
  const problem = renameProblem(deps, from, to);
  if (problem !== null) return { kind: 'refused', reason: problem };

  const index = deps.session.index;
  const resolvers = moveResolvers(notesAfterMove({ from, to }, index.paths()));
  const sources = index.linkSources([...linkKeysOf(from), ...linkKeysOf(to)]);

  const own = retargetLinks(file.text, resolvers);
  const moved: StoredFile = { path: to, text: own.text, baseSha: null, dirty: true };
  await deps.store.rename(from, moved);
  deps.session.applyRename(from, moved);

  let retargeted = own.count;
  for (const source of sources) {
    const other = source === from ? null : deps.session.file(source);
    if (other === null) continue;
    const result = retargetLinks(other.text, resolvers);
    if (result.count === 0) continue;
    retargeted += result.count;
    await writeFile(deps, source, result.text);
  }
  await writeFavorites(deps, favoritesAfterMove(deps.session.favorites, { from, to }));
  return { kind: 'renamed', path: to, retargeted };
}

function renameProblem(deps: VaultDeps, from: VaultPath, to: VaultPath): string | null {
  if (!isNotePath(to)) return 'A note’s path ends in .md.';
  for (const part of withoutExtension(to).split('/')) {
    const problem = noteNameProblem(part);
    if (problem !== null) return problem;
  }
  const wanted = foldedPath(to);
  for (const other of deps.session.allFiles()) {
    if (other.path !== from && foldedPath(other.path) === wanted) {
      return `A note is already at ${other.path}.`;
    }
  }
  return null;
}
