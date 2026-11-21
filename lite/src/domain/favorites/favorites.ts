import { APP_FOLDER, pathAfterMove, type PathMove, type VaultPath } from '../vault/index.ts';

/** Where the favourites live: an ordinary vault file, synced like a note. */
export const FAVORITES_PATH = `${APP_FOLDER}/favorites.json`;

/** The favourite notes' paths, in the order the sidebar shows them, each once. */
export type Favorites = readonly VaultPath[];

/**
 * The favourites read from the file's text. Malformed text — not JSON, or not
 * a list — reads as no favourites, and says why, so the app can tell the
 * person instead of quietly emptying their list. Entries that are not
 * strings, and repeats, are left out.
 */
export type ParsedFavorites =
  | { readonly kind: 'ok'; readonly favorites: Favorites }
  | { readonly kind: 'malformed'; readonly favorites: Favorites; readonly reason: string };

export function parseFavorites(text: string): ParsedFavorites {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    // The text is not JSON; that is exactly what `malformed` reports.
    return { kind: 'malformed', favorites: [], reason: `${FAVORITES_PATH} is not valid JSON.` };
  }
  if (!Array.isArray(value)) {
    return { kind: 'malformed', favorites: [], reason: `${FAVORITES_PATH} is not a list.` };
  }
  const paths = value.filter((entry): entry is string => typeof entry === 'string');
  return { kind: 'ok', favorites: [...new Set(paths)] };
}

/** The file's text: a JSON list, one path per line, ending in a newline. Same list, same bytes. */
export function serializeFavorites(favorites: Favorites): string {
  return `${JSON.stringify(favorites, null, 2)}\n`;
}

export function isFavorite(favorites: Favorites, path: VaultPath): boolean {
  return favorites.includes(path);
}

/** Adds `path` at the end, or takes it out when it is already a favourite. */
export function toggleFavorite(favorites: Favorites, path: VaultPath): Favorites {
  return isFavorite(favorites, path)
    ? favorites.filter((favorite) => favorite !== path)
    : [...favorites, path];
}

/** Moves `path` to `index` (clamped to the list); unchanged when it is not a favourite. */
export function moveFavorite(favorites: Favorites, path: VaultPath, index: number): Favorites {
  if (!isFavorite(favorites, path)) return favorites;
  const rest = favorites.filter((favorite) => favorite !== path);
  const at = Math.max(0, Math.min(index, rest.length));
  return [...rest.slice(0, at), path, ...rest.slice(at)];
}

/** The favourites after a note or folder moved: each one moved keeps its place in the list. */
export function favoritesAfterMove(favorites: Favorites, move: PathMove): Favorites {
  return [...new Set(favorites.map((path) => pathAfterMove(path, move) ?? path))];
}

/** The favourites without a note that was deleted. */
export function favoritesAfterDelete(favorites: Favorites, path: VaultPath): Favorites {
  return favorites.filter((favorite) => favorite !== path);
}
