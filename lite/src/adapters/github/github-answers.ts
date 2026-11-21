/**
 * GitHub's answers, held to the shapes the remote reads. Anything else is
 * refused as malformed rather than guessed at: a tree read wrong is a push
 * made against the wrong files. Lifted from DFAI's adapter.
 */

export const GITHUB_MALFORMED = 'GitHub sent an answer the app cannot read.';

const malformed = (): never => {
  throw new Error(GITHUB_MALFORMED);
};
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
/** A git object's name: SHA-1, or SHA-256 in a repository made with it. */
const isSha = (value: unknown): value is string =>
  typeof value === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value);
const isString = (value: unknown): value is string => typeof value === 'string';
const isArray = (value: unknown): value is unknown[] => Array.isArray(value);
const isBoolean = (value: unknown): value is boolean => typeof value === 'boolean';

function field<T>(value: unknown, key: string, is: (field: unknown) => field is T): T {
  if (!isRecord(value)) return malformed();
  const found = value[key];
  return is(found) ? found : malformed();
}

/** `{ sha }` of a blob, tree or commit just made. */
export const readCreatedSha = (answer: unknown): string => field(answer, 'sha', isSha);
/** The commit a ref points at. */
export const readRefSha = (answer: unknown): string =>
  readCreatedSha(field(answer, 'object', isRecord));
/** A commit's root tree. */
export const readCommitTreeSha = (answer: unknown): string =>
  readCreatedSha(field(answer, 'tree', isRecord));

/** The commit, and its tree, a Contents API write made. */
export function readContentsCommit(answer: unknown): { commitSha: string; treeSha: string } {
  const commit = field(answer, 'commit', isRecord);
  return { commitSha: readCreatedSha(commit), treeSha: readCommitTreeSha(commit) };
}

/** One entry of a recursive tree listing. */
export interface GitTreeEntry {
  readonly path: string;
  readonly mode: string;
  readonly type: 'blob' | 'tree' | 'commit';
  readonly sha: string;
}

export interface GitTreeListing {
  readonly truncated: boolean;
  readonly entries: readonly GitTreeEntry[];
}

const isType = (value: unknown): value is GitTreeEntry['type'] =>
  value === 'blob' || value === 'tree' || value === 'commit';

const readEntry = (raw: unknown): GitTreeEntry => ({
  path: field(raw, 'path', isString),
  mode: field(raw, 'mode', isString),
  type: field(raw, 'type', isType),
  sha: field(raw, 'sha', isSha),
});

export function readTree(answer: unknown): GitTreeListing {
  return {
    truncated: field(answer, 'truncated', isBoolean),
    entries: field(answer, 'tree', isArray).map(readEntry),
  };
}

/** A blob's base64. GitHub sends `encoding: "base64"` for every blob it reads back. */
export function readBlobBase64(answer: unknown): string {
  if (field(answer, 'encoding', isString) !== 'base64') return malformed();
  return field(answer, 'content', isString);
}
