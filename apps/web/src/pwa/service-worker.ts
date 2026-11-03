import {
  fetchPlan,
  shellCacheName,
  SHELL_PAGE,
  SKIP_WAITING,
  staleShellCaches,
} from './shell-rules.ts';

/**
 * The web build's service worker (#668): keeps the app shell so it opens
 * from the Home Screen with no network, and nothing else — the rules are in
 * shell-rules.ts. Built by tools/vite/service-worker.ts, which fills in the
 * build's file list and version; never served by `pnpm dev`.
 *
 * Typed by hand: the project compiles against the DOM, not the worker
 * library, and the worker uses only this much of its own.
 */

/** The build's file list, as JSON (tools/vite/service-worker.ts). */
declare const __DFAI_PRECACHE__: string;
declare const __DFAI_SHELL_VERSION__: string;

interface ExtendableEvent extends Event {
  waitUntil(work: Promise<unknown>): void;
}
interface FetchEvent extends ExtendableEvent {
  readonly request: Request;
  respondWith(answer: Promise<Response>): void;
}
interface WorkerMessageEvent extends ExtendableEvent {
  readonly data: unknown;
}
interface WorkerScope {
  readonly location: { readonly origin: string };
  readonly caches: CacheStorage;
  readonly clients: { claim(): Promise<void> };
  skipWaiting(): Promise<void>;
  fetch(input: Request | string): Promise<Response>;
  addEventListener(type: 'install' | 'activate', listener: (event: ExtendableEvent) => void): void;
  addEventListener(type: 'fetch', listener: (event: FetchEvent) => void): void;
  addEventListener(type: 'message', listener: (event: WorkerMessageEvent) => void): void;
}

const worker = self as unknown as WorkerScope;
const precached: ReadonlySet<string> = new Set(JSON.parse(__DFAI_PRECACHE__) as string[]);
const CACHE = shellCacheName(__DFAI_SHELL_VERSION__);

worker.addEventListener('install', (event) => {
  event.waitUntil(worker.caches.open(CACHE).then((cache) => cache.addAll([...precached])));
});

// Every other build's shell goes, so no stale shell is served for good; this page is then claimed.
worker.addEventListener('activate', (event) => {
  event.waitUntil(
    worker.caches
      .keys()
      .then((names) =>
        Promise.all(staleShellCaches(names, CACHE).map((name) => worker.caches.delete(name))),
      )
      .then(() => worker.clients.claim()),
  );
});

worker.addEventListener('message', (event) => {
  if (event.data === SKIP_WAITING) event.waitUntil(worker.skipWaiting());
});

// A request the worker does not answer is left alone: no respondWith, so the browser fetches it as if there were no worker.
worker.addEventListener('fetch', (event) => {
  const { request } = event;
  const plan = fetchPlan(request, { origin: worker.location.origin, precached });
  if (plan === 'shell') event.respondWith(fromCacheOrNetwork(request));
  else if (plan === 'page') event.respondWith(pageNetworkFirst());
});

/** A built file: kept under its hashed name, so once seen it never needs the network again. */
async function fromCacheOrNetwork(request: Request): Promise<Response> {
  const cache = await worker.caches.open(CACHE);
  const kept = await cache.match(request);
  if (kept !== undefined) return kept;
  const fresh = await worker.fetch(request);
  if (fresh.ok) await cache.put(request, fresh.clone());
  return fresh;
}

/** The page: fresh when the network answers, so a deploy is seen; the kept copy when it does not. */
async function pageNetworkFirst(): Promise<Response> {
  const cache = await worker.caches.open(CACHE);
  try {
    const fresh = await worker.fetch(SHELL_PAGE);
    if (fresh.ok) await cache.put(SHELL_PAGE, fresh.clone());
    return fresh;
  } catch (error) {
    const kept = await cache.match(SHELL_PAGE);
    if (kept !== undefined) return kept;
    throw error;
  }
}
