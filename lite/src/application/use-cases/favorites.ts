import {
  FAVORITES_PATH,
  moveFavorite,
  serializeFavorites,
  toggleFavorite,
  type Favorites,
} from '../../domain/favorites/index.ts';
import type { VaultPath } from '../../domain/vault/index.ts';
import { writeFile, type VaultDeps } from './vault-deps.ts';

/**
 * Writes the favourites file when the list changed. A malformed file is
 * replaced by the list the person just made: what it held was unreadable.
 */
export async function writeFavorites(deps: VaultDeps, favorites: Favorites): Promise<void> {
  const current = deps.session.favorites;
  const same =
    deps.session.favoritesProblem === null &&
    current.length === favorites.length &&
    current.every((path, at) => path === favorites[at]);
  if (same) return;
  await writeFile(deps, FAVORITES_PATH, serializeFavorites(favorites));
}

/** Makes a note a favourite (at the end of the list), or no longer one. */
export async function toggleFavoriteNote(
  deps: VaultDeps,
  { path }: { path: VaultPath },
): Promise<void> {
  await writeFavorites(deps, toggleFavorite(deps.session.favorites, path));
}

/** Moves a favourite to `index` in the list. */
export async function reorderFavorite(
  deps: VaultDeps,
  { path, index }: { path: VaultPath; index: number },
): Promise<void> {
  await writeFavorites(deps, moveFavorite(deps.session.favorites, path, index));
}
