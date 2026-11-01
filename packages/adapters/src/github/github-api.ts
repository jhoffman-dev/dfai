import { VaultAccessError, type AuthPort, type Clock } from '@dfai/application';

/**
 * GitHub's REST API, as the GitHub vault speaks it (#664): one request at a
 * time with the sign-in's token, and only what the transport itself must
 * answer — a 401 met with one refresh (ADR-0052), a rate limit waited out
 * when it lifts soon, a request given up when it hangs, an answer that is not
 * JSON refused. Anything else GitHub refuses comes back as a
 * {@link GitHubRefusedError} with its status, for the vault to say what it means.
 */

/** The sign-in, as far as a request needs it: a token to send, and a 401 to report. */
export type GitHubToken = Pick<AuthPort, 'tokenForRequest' | 'rejected'>;

export interface GitHubApiDeps {
  readonly fetch: typeof globalThis.fetch;
  readonly token: GitHubToken;
  /** When a rate limit lifts is measured against it. */
  readonly clock: Pick<Clock, 'now'>;
  /** Resolves once `ms` have passed: how a rate limit is waited out. setTimeout by default. */
  readonly wait?: (ms: number) => Promise<void>;
  /** Resolves once a request has run `ms`, when it is given up. setTimeout by default. */
  readonly timeout?: (ms: number) => Promise<void>;
  /** `https://api.github.com` by default. */
  readonly origin?: string;
}

export interface GitHubCall {
  readonly method: 'GET' | 'POST' | 'PATCH';
  /** From the API's root, e.g. `/repos/o/r/git/blobs`. */
  readonly path: string;
  readonly body?: unknown;
}

export interface GitHubApi {
  /** The answer's JSON when GitHub says yes; otherwise a {@link VaultAccessError}. */
  send(call: GitHubCall): Promise<unknown>;
}

export const GITHUB_API_ORIGIN = 'https://api.github.com';
/** Long enough for a commit of a large tree, short enough that a dropped network is said. */
export const GITHUB_REQUEST_TIMEOUT_MS = 20_000;
/** The longest a rate limit is waited out; past it, the person is told when to try again. */
export const MAX_RATE_LIMIT_WAIT_MS = 60_000;
/** How many rate limits one request waits out before it gives up. */
export const MAX_RATE_LIMIT_WAITS = 2;
/** GitHub's advice for a 429 that says nothing of when: wait at least a minute. */
const UNSAID_RATE_LIMIT_WAIT_MS = 60_000;

/** GitHub said no, with this status: the vault decides what that means for the write. */
export class GitHubRefusedError extends VaultAccessError {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'GitHubRefusedError';
  }
}

/** GitHub's rate limit holds for longer than is worth waiting; `retryAt` is when it lifts, in ms. */
export class GitHubRateLimitedError extends VaultAccessError {
  constructor(readonly retryAt: number) {
    super('GitHub is limiting how often DFAI may ask; try again in a little while');
    this.name = 'GitHubRateLimitedError';
  }
}

export const GITHUB_MALFORMED = 'GitHub sent an answer DFAI cannot read';

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** An answer as it came, its body parsed when it is JSON. */
interface Arrived {
  readonly status: number;
  readonly headers: Headers;
  readonly body: unknown;
  readonly json: boolean;
}

export function gitHubApi(deps: GitHubApiDeps): GitHubApi {
  const send = sending({
    fetch: deps.fetch,
    timeout: deps.timeout ?? wait,
    origin: deps.origin ?? GITHUB_API_ORIGIN,
  });
  return {
    async send(call) {
      let rejected = false;
      let waits = 0;
      for (;;) {
        const token = await deps.token.tokenForRequest();
        const arrived = await send(call, token);
        if (arrived.status === 401 && !rejected) {
          rejected = true;
          await deps.token.rejected(token);
          continue;
        }
        const pause = rateLimitPause(arrived, deps.clock.now());
        if (pause === null) return answerOf(arrived);
        if (waits >= MAX_RATE_LIMIT_WAITS || pause > MAX_RATE_LIMIT_WAIT_MS)
          throw new GitHubRateLimitedError(deps.clock.now() + pause);
        waits++;
        await (deps.wait ?? wait)(pause);
      }
    },
  };
}

type Sender = (call: GitHubCall, token: string) => Promise<Arrived>;

function sending({
  fetch,
  timeout,
  origin,
}: {
  fetch: typeof globalThis.fetch;
  timeout: (ms: number) => Promise<void>;
  origin: string;
}): Sender {
  return async (call, token) => {
    const controller = new AbortController();
    // Aborting a request that has already answered does nothing.
    void timeout(GITHUB_REQUEST_TIMEOUT_MS).then(() => controller.abort());
    try {
      const response = await fetch(`${origin}${call.path}`, requestOf(call, token, controller));
      const text = await response.text();
      return { status: response.status, headers: response.headers, ...parsed(text) };
    } catch (error) {
      if (controller.signal.aborted)
        throw new VaultAccessError('GitHub did not answer in time; nothing was changed by DFAI');
      throw new VaultAccessError(`GitHub could not be reached: ${String(error)}`);
    }
  };
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

function answerOf({ status, body, json }: Arrived): unknown {
  if (status >= 200 && status < 300) {
    if (!json) throw new VaultAccessError(GITHUB_MALFORMED);
    return body;
  }
  const said = (body as { message?: unknown } | null)?.message;
  const reason = typeof said === 'string' ? `: ${said}` : '';
  if (status === 401) return refused(401, 'GitHub refused the sign-in; sign in again');
  return refused(status, `GitHub refused the request (${status})${reason}`);
}

const refused = (status: number, message: string): never => {
  throw new GitHubRefusedError(status, message);
};
