import { RELATED_NOTES } from '@dfai/domain';
import { readVaultGraph } from '../graph/load-graph.ts';
import { findRelatedNotes, type RelatedNotesState } from '../related/find-related-notes.ts';
import { ApiError, messageWithoutPaths } from './api-error.ts';
import type { ApiRelatedNote } from './contract.ts';
import { countOf } from './fields.ts';
import { notePathOf, readNote } from './note-io.ts';
import type { RouteResult, VaultRequest } from './vault-request.ts';

/**
 * The notes close in meaning to one that are not linked to it yet, either way
 * (P32-03), from the app's own cache of meanings: read-only, and never the
 * first use of search by meaning — that fetches a 91 MB model, which is the
 * person's to ask for from ⌘K. Dismissals are not applied: they are kept per
 * Mac by the window, as how its panel reads a note, not in the vault.
 */
export async function relatedRoute(request: VaultRequest): Promise<RouteResult> {
  const limit = countOf(request.query['limit'], { field: 'limit', ...RELATED_NOTES });
  const path = await notePathOf(request);
  await readNote(request, path);
  const state = await relatedState(request, { path, limit });
  if (state.kind === 'unavailable')
    throw new ApiError('query_failed', 'Search by meaning is not available in this vault');
  if (state.kind === 'off')
    throw new ApiError('semantic_off', 'Search by meaning is off on this Mac — turn it on from ⌘K');
  if (state.kind === 'not-built')
    return { status: 200, body: { related: [], embedded: false, progress: state.progress } };
  // Only notes of the person's own space are ever offered (`isOfferedAsRelated`), all readable here.
  const related = state.notes.map(toApiRelated);
  return { status: 200, body: { related, embedded: true, progress: state.progress } };
}

async function relatedState(
  request: VaultRequest,
  { path, limit }: { path: string; limit: number },
): Promise<RelatedNotesState> {
  const { semantic } = request;
  // Asked before the graph is read: where it is off, the answer needs nothing of the index.
  if (semantic === null) return { kind: 'unavailable' };
  if (!semantic.isOn()) return { kind: 'off' };
  try {
    const graph = await readVaultGraph({ index: request.index });
    return await findRelatedNotes({ semantic, graph, dismissed: new Set(), path, limit });
  } catch (error) {
    throw new ApiError(
      'query_failed',
      `Related notes could not be found: ${messageWithoutPaths(error)}`,
    );
  }
}

function toApiRelated({
  path,
  title,
  target,
  score,
}: {
  path: string;
  title: string;
  target: string;
  score: number;
}): ApiRelatedNote {
  return { path, title, link: `[[${target}]]`, score };
}
