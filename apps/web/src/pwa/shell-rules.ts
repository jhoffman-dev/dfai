/**
 * What the web build's service worker may keep, and when the app offers an
 * update (#668). Pure: the worker (service-worker.ts) and the page
 * (register.ts) only carry these answers out.
 *
 * The worker caches the app shell and nothing else: the built files, by
 * their hashed names, and the page itself. Never the sign-in function's
 * routes, never GitHub's API, never another origin — what a person's data
 * passes through stays with the read cache and the save queue (Web 6).
 */

/** Every shell cache's name starts with this, so a worker can tell its own from the rest. */
export const SHELL_CACHE_PREFIX = 'dfai-shell-';

/** What the page sends a waiting worker to have it take over now (register.ts, service-worker.ts). */
export const SKIP_WAITING = 'dfai-skip-waiting';

/** The page's path, as the worker precaches and serves it. */
export const SHELL_PAGE = '/index.html';

/** The routes the sign-in function answers: a session's cookies pass here, so never cached. */
const API_PREFIX = '/api/';

/** The cache holding one build's shell: a new build is a new name, so an old shell is never served under it. */
export const shellCacheName = (version: string) => `${SHELL_CACHE_PREFIX}${version}`;

/** The shell caches an activating worker deletes: every other build's, and nothing not the worker's. */
export const staleShellCaches = (names: readonly string[], current: string): string[] =>
  names.filter((name) => name.startsWith(SHELL_CACHE_PREFIX) && name !== current);

/** What the worker is asked for, as far as the rules need. */
export interface AskedFor {
  readonly url: string;
  readonly method: string;
  /** `navigate` for a page load; a script, style, worker or fetch otherwise. */
  readonly mode: string;
}

/**
 * How the worker answers one request:
 * - `bypass`: not the worker's business; the browser fetches as if there were no worker.
 * - `shell`: a built file, by its hashed name: from the cache, or the network once and kept.
 * - `page`: the page: the network first, so a deploy shows at once, and the kept copy when it is away.
 */
export type FetchPlan = 'bypass' | 'shell' | 'page';

export function fetchPlan(
  asked: AskedFor,
  { origin, precached }: { origin: string; precached: ReadonlySet<string> },
): FetchPlan {
  if (asked.method !== 'GET') return 'bypass';
  const url = new URL(asked.url);
  if (url.origin !== origin) return 'bypass';
  if (url.pathname.startsWith(API_PREFIX)) return 'bypass';
  if (asked.mode === 'navigate' || url.pathname === SHELL_PAGE) return 'page';
  return precached.has(url.pathname) ? 'shell' : 'bypass';
}

/**
 * The files a build's worker keeps, from what the build wrote: everything
 * under the hashed assets folder, and the page. Not the worker itself, which
 * the browser fetches afresh to find an update, and not the manifest or the
 * icons, which the browser asks for only to install.
 */
export function precacheList(builtFiles: readonly string[]): string[] {
  return (
    builtFiles
      .filter((file) => file.startsWith('assets/'))
      // As the browser asks for it: a space or a letter past ASCII in a name reaches `fetchPlan` percent-encoded.
      .map((file) => new URL(`/${file}`, 'http://precache.invalid').pathname)
      .concat(SHELL_PAGE)
      .sort()
  );
}

/**
 * Whether to say "Update ready": a worker has installed behind the one
 * running this page. On the first visit a worker installs with no page
 * under another's control, and there is nothing to update to.
 */
export const offersUpdate = ({ controlled, waiting }: { controlled: boolean; waiting: boolean }) =>
  controlled && waiting;
