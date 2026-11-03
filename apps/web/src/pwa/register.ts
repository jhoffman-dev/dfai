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
   * Has the newest worker take over, and is done once it controls this
   * page — at once when it already does, as after another tab's Reload.
   * The caller then reloads under it; it writes what the panes hold first,
   * and the save queue is on disk and outlives the reload (#667).
   */
  readonly takeOver: () => Promise<void>;
}

/**
 * Registers the worker and calls `onUpdateReady`, once, when a newer
 * build's worker is installed behind the one running this page — on the
 * first visit, never: nothing is running to update from. A takeover this
 * tab did not ask for (another tab's Reload) is offered too, since the
 * shell under the page is no longer the one it loaded, and its old chunks
 * are gone. Registration failing (an old browser, a private window) leaves
 * the app as it was.
 */
export async function registerShellWorker({
  workers,
  onUpdateReady,
}: {
  workers: WorkerContainer;
  onUpdateReady: (update: UpdateReady) => void;
}): Promise<void> {
  const registration = await workers.register(WORKER_PATH);
  const takeovers = new Set<() => void>();
  let offered = false;
  // The first worker claims the page as it activates: a change of controller, but no update.
  let wasControlled = workers.controller !== null;

  const takeOver = (): Promise<void> => {
    const waiting = registration.waiting;
    // Nothing waiting, or already on its way in (another tab asked): this page is its already.
    if (waiting === null || waiting.state !== 'installed') return Promise.resolve();
    return new Promise((done) => {
      takeovers.add(done);
      waiting.postMessage(SKIP_WAITING);
    });
  };
  const offer = () => {
    if (offered) return;
    offered = true;
    onUpdateReady({ takeOver });
  };

  workers.addEventListener('controllerchange', () => {
    takeovers.forEach((done) => done());
    takeovers.clear();
    // Not this tab's doing: the bar stays, or goes up, so it can reload safely in its own time.
    if (wasControlled) offer();
    wasControlled = true;
  });
  const watch = (worker: InstallingWorker) =>
    worker.addEventListener('statechange', () => {
      if (
        offersUpdate({
          controlled: workers.controller !== null,
          waiting: worker.state === 'installed',
        })
      )
        offer();
    });
  if (registration.waiting !== null && workers.controller !== null) offer();
  if (registration.installing !== null) watch(registration.installing);
  registration.addEventListener('updatefound', () => {
    if (registration.installing !== null) watch(registration.installing);
  });
}
