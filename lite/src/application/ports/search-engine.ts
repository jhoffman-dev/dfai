import type { VaultPath } from '../../domain/vault/index.ts';

/** A note that matches a search, best first. */
export interface SearchHit {
  readonly path: VaultPath;
  readonly title: string;
  /** A short piece of the text around the match, plain text (no markup to render). */
  readonly snippet: string;
}

/**
 * Full-text search over the vault's visible notes (MiniSearch in the app).
 * In memory and synchronous, kept up to date one note at a time; the app
 * feeds it from `VaultSession` changes. Titles weigh more than body text.
 */
export interface SearchEngine {
  /** Replaces everything indexed with these notes. */
  index(notes: readonly { readonly path: VaultPath; readonly text: string }[]): void;
  /** Adds the note, or re-reads it if it is already indexed. */
  update(path: VaultPath, text: string): void;
  remove(path: VaultPath): void;
  /** The best matches for `query`, at most `limit` (default 20). Empty for a blank query. */
  search(query: string, options?: { readonly limit?: number }): SearchHit[];
}
