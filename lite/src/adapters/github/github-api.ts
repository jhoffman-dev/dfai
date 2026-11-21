import { RemoteAuthError, RemoteUnreachableError, type Clock } from '../../application/index.ts';
import { GITHUB_MALFORMED } from './github-answers.ts';

/**
 * GitHub's REST API, one request at a time with the person's token, and
 * only what the transport itself must answer: a rate limit waited out when
 * it lifts soon, a request given up when it hangs, a refused token said as
 * {@link RemoteAuthError}. Anything else GitHub refuses comes back as a
 * {@link GitHubRefusedError} with its status, for the remote to interpret.
 * Lifted from DFAI's adapter, without its OAuth refresh: the token here is
 * a personal access token the person pasted in.
 */

export interface GitHubApiDeps {
  readonly fetch: typeof globalThis.fetch;
  /** A secret: sent in the Authorization header only, never in a URL or a message. */
  readonly token: string;
  /** When a rate limit lifts is measured against it. */
  readonly clock: Clock;
  /** Resolves once `ms` have passed: how a rate limit is waited out. */
  readonly wait: (ms: number) => Promise<void>;
  /** Resolves once a request has run `ms`, when it is given up. */
  readonly timeout: (ms: number) => Promise<void>;
  readonly origin?: string;
}

export interface GitHubCall {
  readonly method: 'GET' | 'POST' | 'PATCH' | 'PUT';
  /** From the API's root, e.g. `/repos/o/r/git/blobs`. */
  readonly path: string;
  readonly body?: unknown;
}

export interface GitHubApi {
  /** The answer's JSON when GitHub says yes. */
  send(call: GitHubCall): Promise<unknown>;
}

export const GITHUB_API_ORIGIN = 'https://api.github.com';
/** Long enough for a commit of a large tree, short enough that a dropped network is said. */
export const GITHUB_REQUEST_TIMEOUT_MS = 20_000;
/** The longest a rate limit is waited out; past it, the sync fails as unreachable. */
export const MAX_RATE_LIMIT_WAIT_MS = 60_000;
/** How many rate limits one request waits out before it gives up. */
const MAX_RATE_LIMIT_WAITS = 2;
/** GitHub's advice for a 429 that says nothing of when: wait at least a minute. */
const UNSAID_RATE_LIMIT_WAIT_MS = 60_000;

/** GitHub said no, with this status: the remote decides what that means. */
export class GitHubRefusedError extends Error {
  override readonly name = 'GitHubRefusedError';
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** An answer as it came, its body parsed when it is JSON. */
interface Arrived {
  readonly status: number;
  readonly headers: Headers;
  readonly body: unknown;
  readonly json: boolean;
}

export function gitHubApi(deps: GitHubApiDeps): GitHubApi {
  const origin = deps.origin ?? GITHUB_API_ORIGIN;
  return {
    async send(call) {
      for (let waits = 0; ; waits++) {
        const arrived = await sendOnce(deps, origin, call);
        const pause = rateLimitPause(arrived, deps.clock.now().getTime());
        if (pause === null) return answerOf(arrived);
        if (waits >= MAX_RATE_LIMIT_WAITS || pause > MAX_RATE_LIMIT_WAIT_MS)
          throw new RemoteUnreachableError(
            'GitHub is limiting requests; sync will try again later.',
          );
        await deps.wait(pause);
      }
    },
  };
}

async function sendOnce(deps: GitHubApiDeps, origin: string, call: GitHubCall): Promise<Arrived> {
  const controller = new AbortController();
  // Aborting a request that has already answered does nothing.
  void deps.timeout(GITHUB_REQUEST_TIMEOUT_MS).then(() => controller.abort());
  try {
    const response = await deps.fetch(
      `${origin}${call.path}`,
      requestOf(call, deps.token, controller),
    );
    const text = await response.text();
    return { status: response.status, headers: response.headers, ...parsed(text) };
  } catch {
    // The cause is not kept: a network error's text can echo the request.
    if (controller.signal.aborted)
      throw new RemoteUnreachableError('GitHub did not answer in time.');
    throw new RemoteUnreachableError();
  }
}

function requestOf(call: GitHubCall, token: string, controller: AbortController): RequestInit {
  return {
    method: call.method,
    // GitHub answers with max-age=60: a cached branch head would hide another device's commit.
    cache: 'no-store',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(call.body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(call.body === undefined ? {} : { body: JSON.stringify(call.body) }),
    signal: controller.signal,
  };
}

function parsed(text: string): { body: unknown; json: boolean } {
  try {
    return { body: JSON.parse(text) as unknown, json: true };
  } catch {
    // Not JSON: a yes is refused as malformed below, a no keeps its status.
    return { body: null, json: false };
  }
}

/** How long to wait out a rate limit this answer is, or null when it is none. */
function rateLimitPause({ status, headers }: Arrived, now: number): number | null {
  if (status !== 403 && status !== 429) return null;
  const after = headers.get('retry-after')?.trim();
  if (after !== undefined && /^\d+$/.test(after)) return Number(after) * 1000;
  const reset = Number(headers.get('x-ratelimit-reset'));
  if (headers.get('x-ratelimit-remaining') === '0' && Number.isFinite(reset) && reset > 0)
    return Math.max(0, reset * 1000 - now);
  return status === 429 ? UNSAID_RATE_LIMIT_WAIT_MS : null;
}

const THROTTLED = /rate limit|abuse/i;

function answerOf({ status, body, json }: Arrived): unknown {
  if (status >= 200 && status < 300) {
    if (!json) throw new Error(GITHUB_MALFORMED);
    return body;
  }
  if (status === 401) throw new RemoteAuthError();
  const said = (body as { message?: unknown } | null)?.message;
  // A secondary rate limit is a 403 that may carry no rate-limit headers: say it as "try later".
  if (status === 403 && typeof said === 'string' && THROTTLED.test(said))
    throw new RemoteUnreachableError('GitHub is limiting requests; sync will try again later.');
  if (status === 403) throw new RemoteAuthError('GitHub refused the token for this repository.');
  if (status >= 500) throw new RemoteUnreachableError(`GitHub is not answering (${status}).`);
  const reason = typeof said === 'string' ? `: ${said}` : '';
  throw new GitHubRefusedError(status, `GitHub refused the request (${status})${reason}`);
}
