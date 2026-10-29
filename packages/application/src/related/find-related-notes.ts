import { linkedEitherWay, type VaultGraph } from '@dfai/domain';
import type { BuildProgress } from '../embeddings/embedding-build.ts';
import type { RelatedSuggestion } from '../embeddings/related-by-meaning.ts';
import type { SemanticAccess } from '../embeddings/semantic-search.ts';

/**
 * What the Related notes of a note are, as the panel and the API tell them:
 * `unavailable` where this app offers no search by meaning; `off` where it has
 * not been turned on on this Mac; `not-built` while the note has no vectors
 * yet; else the notes offered, best first.
 */
export type RelatedNotesState =
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'off' }
  | { readonly kind: 'not-built'; readonly progress: BuildProgress }
  | {
      readonly kind: 'ready';
      readonly notes: readonly RelatedSuggestion[];
      readonly progress: BuildProgress;
    };

/**
 * The notes close in meaning to `path` that are not joined to it yet, either
 * way, by a link or a relation — the graph says which are — nor dismissed.
 * A suggestion is only that: nothing is written until one is accepted.
 */
export async function findRelatedNotes({
  semantic,
  graph,
  dismissed,
  path,
  limit,
}: {
  semantic: Pick<SemanticAccess, 'isOn' | 'related'> | null;
  graph: VaultGraph;
  dismissed: ReadonlySet<string>;
  path: string;
  limit?: number;
}): Promise<RelatedNotesState> {
  if (semantic === null) return { kind: 'unavailable' };
  if (!semantic.isOn()) return { kind: 'off' };
  const answer = await semantic.related({
    path,
    exclude: { linked: linkedEitherWay(graph, path), dismissed },
    ...(limit !== undefined && { limit }),
  });
  if (!answer.embedded) return { kind: 'not-built', progress: answer.progress };
  return { kind: 'ready', notes: answer.notes, progress: answer.progress };
}
