import { VaultAccessError } from '@dfai/application';
import { GITHUB_MALFORMED } from './github-api.ts';

/**
 * GitHub's answers, held to the shapes the vault reads (#664). Anything else
 * is refused as malformed rather than guessed at: a tree read wrong is a
 * write made against the wrong files.
 */

const malformed = (): never => {
  throw new VaultAccessError(GITHUB_MALFORMED);
};
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
/** A git object's name: SHA-1, or SHA-256 in a repository made with it. */
const isSha = (value: unknown): value is string =>
  typeof value === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value);

function field<T>(value: unknown, key: string, is: (field: unknown) => field is T): T {
  if (!isRecord(value)) return malformed();
  const found = value[key];
  return is(found) ? found : malformed();
}

/** `{ sha }` of a blob, tree or commit just made, or the commit a ref points at. */
export const readCreatedSha = (answer: unknown): string => field(answer, 'sha', isSha);
export const readRefSha = (answer: unknown): string =>
  readCreatedSha(field(answer, 'object', isRecord));

/** One entry of a recursive tree listing. */
export interface GitTreeEntry {
  readonly path: string;
  readonly mode: string;
  readonly type: 'blob' | 'tree' | 'commit';
  readonly sha: string;
  /** A blob's length in bytes; absent for a tree. */
  readonly size?: number;
}

export interface GitTreeListing {
  readonly sha: string;
  readonly truncated: boolean;
  readonly entries: readonly GitTreeEntry[];
}

const isString = (value: unknown): value is string => typeof value === 'string';
const isBoolean = (value: unknown): value is boolean => typeof value === 'boolean';
const isArray = (value: unknown): value is unknown[] => Array.isArray(value);
const isType = (value: unknown): value is GitTreeEntry['type'] =>
  value === 'blob' || value === 'tree' || value === 'commit';
const isSize = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

function readEntry(raw: unknown): GitTreeEntry {
  const type = field(raw, 'type', isType);
  const entry = {
    path: field(raw, 'path', isString),
    mode: field(raw, 'mode', isString),
    type,
    sha: field(raw, 'sha', isSha),
  };
  return type === 'blob' ? { ...entry, size: field(raw, 'size', isSize) } : entry;
}

export function readTree(answer: unknown): GitTreeListing {
  return {
    sha: field(answer, 'sha', isSha),
    truncated: field(answer, 'truncated', isBoolean),
    entries: field(answer, 'tree', isArray).map(readEntry),
  };
}

/** A blob's base64. GitHub sends `encoding: "base64"` for every blob it reads back. */
export function readBlobBase64(answer: unknown): string {
  if (field(answer, 'encoding', isString) !== 'base64') return malformed();
  return field(answer, 'content', isString);
}

/** The ids of the App's installations the signed-in person can reach. */
export function readInstallationIds(answer: unknown): number[] {
  return field(answer, 'installations', isArray).map((raw) => field(raw, 'id', isSize));
}

export interface ReachedRepository {
  readonly owner: string;
  readonly repo: string;
  readonly branch: string;
}

/** Every repository an installation reaches, with its default branch, and how many it says there are. */
export function readRepositories(answer: unknown): {
  total: number;
  repositories: ReachedRepository[];
} {
  return {
    total: field(answer, 'total_count', isSize),
    repositories: field(answer, 'repositories', isArray).map((raw) => ({
      owner: field(field(raw, 'owner', isRecord), 'login', isString),
      repo: field(raw, 'name', isString),
      branch: field(raw, 'default_branch', isString),
    })),
  };
}
