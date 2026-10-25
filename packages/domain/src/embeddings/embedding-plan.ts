import { isUserSpaceNote } from '../vault/vault-visibility.ts';
import { createVaultPath } from '../vault/vault-path.ts';

/**
 * Which notes are embedded: the notes of the user's own space, the Archive
 * among them. DFAI's own files under `.atlas` — templates, automations,
 * proposals waiting in the Inbox — and hidden folders are not: none of them
 * is something the user wrote to find again by meaning.
 */
export function isEmbeddableNote(path: string): boolean {
  return isUserSpaceNote(createVaultPath(path));
}

/** What the cache must do to hold the vault as it is now. */
export interface EmbeddingWork {
  /** Notes to cut into chunks and embed, new or changed since the cache saw them, in path order. */
  readonly embed: readonly string[];
  /** Notes the cache holds that the vault no longer has, or no longer embeds, in path order. */
  readonly forget: readonly string[];
}

/**
 * The work between the cache and the vault, each named by note path to the
 * digest of its text: a note the cache holds at the digest it has now is left
 * alone. What a build that was stopped — by a quit, a crash, a switch of
 * vault — left undone is exactly this, so the next build resumes from it.
 */
export function embeddingWork({
  vault,
  cached,
}: {
  vault: ReadonlyMap<string, string>;
  cached: ReadonlyMap<string, string>;
}): EmbeddingWork {
  const embed = [...vault]
    .filter(([path, digest]) => isEmbeddableNote(path) && cached.get(path) !== digest)
    .map(([path]) => path);
  const forget = [...cached.keys()].filter((path) => !vault.has(path) || !isEmbeddableNote(path));
  return { embed: embed.sort(byPath), forget: forget.sort(byPath) };
}

/** Plain code-unit order: the same on every machine, whatever its locale. */
const byPath = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);
