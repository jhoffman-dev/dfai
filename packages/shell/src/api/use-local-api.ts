import { useEffect, useRef } from 'react';
import { serveApi, type ApiBridgePort, type ApiRouterDeps } from '@dfai/application';
import type { SettingsPorts } from '../settings/settings-panel.tsx';

/** The local API as the app is given it: the bridge it answers on, and what Settings needs. */
export interface LocalApiPorts extends SettingsPorts {
  readonly bridge: ApiBridgePort;
}

/**
 * Answers the local API for as long as the app is up.
 *
 * Listening costs nothing while the API is off: the host only forwards requests
 * while it is serving. `onWrote` is read when a write lands rather than when
 * listening began, so it always refreshes the vault that is open now.
 */
export function useLocalApi({
  bridge,
  deps,
  onWrote,
}: {
  bridge: ApiBridgePort;
  /** Stable for the life of the app; the parts that change are read through it at call time. */
  deps: ApiRouterDeps;
  onWrote: () => void;
}): void {
  const wrote = useRef(onWrote);
  wrote.current = onWrote;

  useEffect(() => {
    let stop: (() => void) | null = null;
    let cancelled = false;

    serveApi({ bridge, deps, onWrote: () => wrote.current() })
      .then((unlisten) => {
        if (cancelled) unlisten();
        else stop = unlisten;
      })
      .catch(() => {
        // Outside Tauri — `pnpm dev` in a plain browser — there is no host to
        // listen to, and so no request that could go unanswered.
      });

    return () => {
      cancelled = true;
      stop?.();
    };
  }, [bridge, deps]);
}
