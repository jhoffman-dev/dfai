import { TaskRuleRefusedError } from '../gtd/task-rules.ts';
import {
  API_ERROR_STATUS,
  type ApiErrorBody,
  type ApiErrorCode,
  type ApiSpecProblem,
  type ApiTextPosition,
} from './contract.ts';

export { messageOf, messageWithoutPaths } from '@dfai/domain';

/**
 * A request refused for a reason the caller can act on.
 *
 * Handlers throw this; the router turns it into the error body. Anything else
 * thrown is a fault of ours, and is answered as `internal` without its details.
 */
export class ApiError extends Error {
  readonly code: ApiErrorCode;
  /** Seconds before asking again is worth it, when that is known. */
  readonly retryAfter: number | undefined;
  /** Where in a query's text the problem is, when the request sent one. */
  readonly at: ApiTextPosition | undefined;
  /** What a checker found wrong with a spec the request sent, when it sent one. */
  readonly problems: readonly ApiSpecProblem[] | undefined;

  constructor(
    code: ApiErrorCode,
    message: string,
    {
      retryAfter,
      at,
      problems,
    }: { retryAfter?: number; at?: ApiTextPosition; problems?: readonly ApiSpecProblem[] } = {},
  ) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.retryAfter = retryAfter;
    this.at = at;
    this.problems = problems;
  }
}

/** What the caller is told when something failed that it cannot act on. */
export const INTERNAL_MESSAGE = 'DFAI could not answer this request';

/** The status and body for anything a handler threw. */
export function failureOf(error: unknown): { status: number; body: ApiErrorBody } {
  // A task the rules refuse, from whichever write: the caller's to fix, so it says why.
  if (error instanceof TaskRuleRefusedError)
    return failureOf(new ApiError('invalid', error.message));
  if (!(error instanceof ApiError)) {
    const internal = { code: 'internal' as const, message: INTERNAL_MESSAGE };
    return { status: API_ERROR_STATUS.internal, body: { error: internal } };
  }
  const { code, message, retryAfter, at, problems } = error;
  const body = {
    error: {
      code,
      message,
      ...(retryAfter !== undefined && { retryAfter }),
      ...(at !== undefined && { at }),
      ...(problems !== undefined && { problems }),
    },
  };
  return { status: API_ERROR_STATUS[code], body };
}
