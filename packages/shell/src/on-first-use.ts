import {
  createElement,
  lazy,
  useState,
  useSyncExternalStore,
  type ComponentType,
  type LazyExoticComponent,
} from 'react';

/**
 * One chunk of code, shared by every part drawn from it: imported once however
 * many parts want it, and, when an import fails, imported again by the next
 * part that asks — a failure is never kept. Once any import succeeds, every
 * part from the chunk can draw.
 */
export interface Chunk<M> {
  /** The chunk's module once it has loaded; null until then. */
  readonly current: () => M | null;
  /**
   * Imports the chunk, or joins the import already under way. `fresh` asks for
   * a copy under a new address when the last import failed on the module
   * itself, which the browser would otherwise answer with the same failure.
   */
  readonly load: (options?: { fresh?: boolean }) => Promise<M>;
  /** Called once the chunk has loaded. Returns the way to stop listening. */
  readonly subscribe: (listener: () => void) => () => void;
}

/** A browser's words for "the file could not be fetched", as against "it would not run". */
const FETCH_FAILED =
  /Importing a module script failed|Failed to fetch dynamically imported module|error loading dynamically imported module/i;

const warnUnloaded = (cause: unknown) => console.warn('A part of DFAI could not load:', cause);

export function chunkOf<M>({
  load,
  loadAgain,
}: {
  load: () => Promise<M>;
  /** The chunk under a new address for attempt `n`, or null where its file is not known. */
  loadAgain: (attempt: number) => Promise<unknown> | null;
}): Chunk<M> {
  let loaded: M | null = null;
  let pending: Promise<M> | null = null;
  let attempts = 0;
  let failedOnModule = false;
  const listeners = new Set<() => void>();

  const importOnce = (fresh: boolean): Promise<M> => {
    attempts += 1;
    // The same module under another address: its exports are the chunk's own.
    const again = fresh && failedOnModule ? (loadAgain(attempts) as Promise<M> | null) : null;
    return again ?? load();
  };

  return {
    current: () => loaded,
    load: ({ fresh = false } = {}) => {
      if (loaded !== null) return Promise.resolve(loaded);
      pending ??= importOnce(fresh).then(
        (module) => {
          loaded = module;
          pending = null;
          for (const listener of listeners) listener();
          return module;
        },
        (cause: unknown) => {
          pending = null;
          // Sticky: the browser keeps a module that failed to parse or run failed under its
          // address for good, whatever a later import fails on.
          failedOnModule ||= !(cause instanceof Error && FETCH_FAILED.test(cause.message));
          warnUnloaded(cause);
          throw cause;
        },
      );
      return pending;
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** A component whose code is in a chunk of its own, fetched the first time it is wanted. */
export interface OnFirstUse<P extends object> {
  /** Render inside a `Suspense`: before its chunk has loaded, it suspends. */
  readonly Component: LazyExoticComponent<ComponentType<P>>;
  /**
   * Fetches the chunk and readies the component, so that its first render
   * draws it straight away. A chunk that cannot be fetched leaves the
   * component as it was, to be imported again when it is first drawn.
   */
  readonly preload: () => Promise<void>;
}

/** What a part whose chunk could not be loaded is drawn with, in its place. */
export interface FailedPartProps<P> {
  /** What the part was given: its frame, and the way to close it. */
  readonly props: P;
  readonly retrying: boolean;
  /** Imports the chunk again, and draws the part if it arrives. */
  readonly onRetry: () => void;
  /** Offered once trying again has failed: loads the whole window again. */
  readonly onReloadWindow: (() => void) | null;
}

/**
 * React's own handle on a lazy component: `_init(_payload)` returns the loaded
 * component, or throws the promise of it while it loads. It is the only way to
 * settle a lazy component before it renders, and without it a page preloaded
 * long ago still commits its fallback once on first open (`on-first-use.test.tsx`).
 */
interface LazyHandle {
  readonly _init: (payload: unknown) => unknown;
  readonly _payload: unknown;
}

const isThenable = (value: unknown): value is PromiseLike<unknown> =>
  typeof value === 'object' && value !== null && 'then' in value;

/**
 * A part of `chunk`. When the chunk fails to import, or throws as it is
 * evaluated, the failure never reaches React as an error, which would unmount
 * the whole app: the part is drawn as `Failed`, which can import it again.
 */
export function onFirstUse<M, P extends object>({
  chunk,
  pick,
  Failed,
  reloadWindow,
}: {
  chunk: Chunk<M>;
  /** The part's component, out of the chunk's module. */
  pick: (module: M) => ComponentType<P>;
  Failed: ComponentType<FailedPartProps<P>>;
  reloadWindow: () => void;
}): OnFirstUse<P> {
  const Unloaded = unloadedPart({ chunk, pick, Failed, reloadWindow });
  const Component = lazy(() =>
    chunk.load().then(
      (module) => ({ default: pick(module) }),
      () => ({ default: Unloaded }),
    ),
  );
  const handle = Component as unknown as LazyHandle;
  return {
    Component,
    preload: async () => {
      try {
        await chunk.load();
      } catch {
        // Warned of by the chunk; the part is left to import it again when drawn.
        return;
      }
      try {
        handle._init(handle._payload);
      } catch (thrown) {
        // Pending: React settles the component as this promise does, before any later await.
        if (!isThenable(thrown)) throw thrown;
        await thrown;
      }
    },
  };
}

/**
 * What a part resolves to when its chunk failed as it was first drawn: `Failed`
 * until the chunk loads — by its Reload, or by any other part's import — and
 * then the part. React keeps a lazy component's first answer for good, so the
 * recovery is made here.
 */
function unloadedPart<M, P extends object>({
  chunk,
  pick,
  Failed,
  reloadWindow,
}: {
  chunk: Chunk<M>;
  pick: (module: M) => ComponentType<P>;
  Failed: ComponentType<FailedPartProps<P>>;
  reloadWindow: () => void;
}): ComponentType<P> {
  return function UnloadedPart(props: P) {
    const module = useSyncExternalStore(chunk.subscribe, chunk.current);
    const [retrying, setRetrying] = useState(false);
    const [retryFailed, setRetryFailed] = useState(false);
    if (module !== null) return createElement(pick(module), props);
    const onRetry = () => {
      setRetrying(true);
      chunk.load({ fresh: true }).catch(() => {
        setRetrying(false);
        setRetryFailed(true);
      });
    };
    return createElement(Failed, {
      props,
      retrying,
      onRetry,
      onReloadWindow: retryFailed ? reloadWindow : null,
    });
  };
}
