import { offersUpdate, SKIP_WAITING } from './shell-rules.ts';

/**
 * The page's side of the service worker (#668): registers the build's
 * worker and says when a newer one is waiting, so the app can offer a
 * reload. The rules are in shell-rules.ts; this only listens.
 */

/** Where the build writes the worker (tools/vite/service-worker.ts); its scope is the site. */
export const WORKER_PATH = '/sw.js';

/** As much of `navigator.serviceWorker` as the page uses. */
export interface WorkerContainer {
  readonly controller: Pick<ServiceWorker, 'state'> | null;
  register(path: string): Promise<WorkerRegistration>;
  addEventListener(type: 'controllerchange', listener: () => void): void;
}

export interface WorkerRegistration {
  readonly installing: InstallingWorker | null;
  readonly waiting: InstallingWorker | null;
  addEventListener(type: 'updatefound', listener: () => void): void;
}

export interface InstallingWorker {
  readonly state: string;
  postMessage(message: unknown): void;
  addEventListener(type: 'statechange', listener: () => void): void;
}

export interface UpdateReady {
  /**
   * Has the waiting worker take over, then reloads the page under it. The
   * caller writes what the panes hold first, so nothing typed is lost; the
   * save queue is on disk and outlives the reload (#667).
   */
  readonly reload: () => void;
}

/**
 * Registers the worker and calls `onUpdateReady` once a newer build's
 * worker is installed behind the one running this page — on the first
 * visit, never: nothing is running to update from. Registration failing
 * (an old browser, a private window) leaves the app as it was.
 */
export async function registerShellWorker({
  workers,
  onUpdateReady,
  reloadPage,
}: {
  workers: WorkerContainer;
  onUpdateReady: (update: UpdateReady) => void;
  reloadPage: () => void;
}): Promise<void> {
  const registration = await workers.register(WORKER_PATH);
  // Only after Reload: the first worker claims the page too, as it activates, and a reload
  // then would restart the page mid-sign-in and leave the worker's activation waiting on it.
  let reloadAsked = false;
  workers.addEventListener('controllerchange', () => {
    if (reloadAsked) reloadPage();
  });
  const offer = (worker: InstallingWorker) => {
    if (
      offersUpdate({
        controlled: workers.controller !== null,
        waiting: worker.state === 'installed',
      })
    )
      onUpdateReady({
        reload: () => {
          reloadAsked = true;
          worker.postMessage(SKIP_WAITING);
        },
      });
  };
  const watch = (worker: InstallingWorker) =>
    worker.addEventListener('statechange', () => offer(worker));
  if (registration.waiting !== null) offer(registration.waiting);
  if (registration.installing !== null) watch(registration.installing);
  registration.addEventListener('updatefound', () => {
    if (registration.installing !== null) watch(registration.installing);
  });
}
