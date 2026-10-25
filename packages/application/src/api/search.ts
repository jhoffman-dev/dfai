import { createVaultPath, isArchivedPath, toSearchQuery } from '@dfai/domain';
import { ApiError, messageWithoutPaths } from './api-error.ts';
import { countOf, queryFlag, requiredText } from './fields.ts';
import { isApiNotePath } from './paths.ts';
import type { SearchHit, SearchScope } from '../index/ports.ts';
import { searchScope } from '../index/search-notes.ts';
import type { SemanticAccess, SemanticHit } from '../embeddings/semantic-search.ts';
import type { ApiSearchHit, ApiSemanticHit } from './contract.ts';
import type { RouteResult, VaultRequest } from './vault-request.ts';

const HITS = { fallback: 20, max: 100 };

interface Asked {
  readonly prepared: string;
  readonly limit: number;
  readonly scope: SearchScope;
}

const MODES = ['words', 'semantic'] as const;

/** The most of `q` a search by meaning takes: about what the model reads of a question. */
export const SEMANTIC_QUERY_CHARACTERS = 1_000;

/**
 * Full-text search, answered by the index as the search palette is. Hits the
 * API could not then read — DFAI's own notes in `.atlas` — are left out, and
 * so is the Archive unless `includeArchived` asks for it, when each archived
 * hit says so. With `mode=semantic`, blocks found by meaning instead (P32-02),
 * each with the link that cites it.
 */
export async function searchRoute(request: VaultRequest): Promise<RouteResult> {
  const text = requiredText(request.query, 'q');
  const limit = countOf(request.query['limit'], { field: 'limit', ...HITS });
  const includeArchived = queryFlag(request.query['includeArchived'], 'includeArchived');
  if (modeOf(request.query['mode']) === 'semantic')
    return semanticRoute(request, { query: text, limit, includeArchived });

  // A query with nothing searchable left once cleaned — only punctuation — matches nothing.
  const prepared = toSearchQuery(text);
  if (prepared === null) return { status: 200, body: { hits: [] } };

  const scope = searchScope({ includeArchived });
  const hits = await userSpaceHits(request, { prepared, limit, scope });
  return { status: 200, body: { hits: hits.map(toApiHit) } };
}

function modeOf(raw: string | undefined): (typeof MODES)[number] {
  if (raw === undefined) return 'words';
  const mode = MODES.find((each) => each === raw);
  if (mode === undefined) throw new ApiError('invalid', 'mode must be "words" or "semantic"');
  return mode;
}

/**
 * Blocks by meaning, from the app's own cache: the first search in a vault
 * starts building it, and `progress` says how much it has reached, so a
 * caller can tell an answer from a cache still being made.
 */
async function semanticRoute(
  request: VaultRequest,
  asked: { query: string; limit: number; includeArchived: boolean },
): Promise<RouteResult> {
  const answer = await semanticAnswer(request.semantic, asked);
  const hits = answer.hits.filter((hit) => isApiNotePath(createVaultPath(hit.path)));
  return { status: 200, body: { hits: hits.map(toApiSemanticHit), progress: answer.progress } };
}

async function semanticAnswer(
  semantic: SemanticAccess | null,
  asked: { query: string; limit: number; includeArchived: boolean },
) {
  if (asked.query.length > SEMANTIC_QUERY_CHARACTERS)
    throw new ApiError('invalid', `q must be at most ${SEMANTIC_QUERY_CHARACTERS} characters`);
  if (semantic === null)
    throw new ApiError('query_failed', 'Semantic search is not available in this vault');
  // Turning it on fetches a 91 MB model: the person's to ask for, from the app, never a caller's.
  if (!semantic.isOn())
    throw new ApiError('semantic_off', 'Search by meaning is off on this Mac — turn it on from ⌘K');
  try {
    return await semantic.search(asked);
  } catch (error) {
    throw new ApiError(
      'query_failed',
      `Semantic search could not run: ${messageWithoutPaths(error)}`,
    );
  }
}

function toApiSemanticHit(hit: SemanticHit): ApiSemanticHit {
  const { path, title, text, heading, block, link, score } = hit;
  return {
    path,
    title,
    text,
    heading,
    block,
    link,
    score,
    ...(isArchivedPath(path) && { archived: true as const }),
  };
}

function toApiHit({ path, title, snippet }: SearchHit): ApiSearchHit {
  return { path, title, snippet, ...(isArchivedPath(path) && { archived: true as const }) };
}

/**
 * Up to `limit` hits the API could then read. Hits in `.atlas` are dropped
 * after the index has counted them, so it is asked for twice as many until
 * enough are left or it has no more to give.
 */
async function userSpaceHits(
  request: VaultRequest,
  { prepared, limit, scope }: Asked,
): Promise<readonly SearchHit[]> {
  for (let asked = limit; ; asked *= 2) {
    const found = await searchIndex(request, { prepared, limit: asked, scope });
    const hits = found.filter((hit) => isApiNotePath(createVaultPath(hit.path)));
    if (hits.length >= limit || found.length < asked) return hits.slice(0, limit);
  }
}

async function searchIndex(
  request: VaultRequest,
  { prepared, limit, scope }: Asked,
): Promise<readonly SearchHit[]> {
  try {
    return await request.index.search(prepared, limit, scope);
  } catch (error) {
    throw new ApiError(
      'query_failed',
      `The index could not run this search: ${messageWithoutPaths(error)}`,
    );
  }
}
