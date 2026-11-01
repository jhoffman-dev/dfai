import { useEffect, useRef } from 'react';
import type { VaultWatchPort } from '@dfai/application';

/**
 * Runs `onChange` when the vault is changed by anything other than this app.
 *
 * The handler is kept in a ref and read when an event arrives, so the
 * subscription survives re-renders while still calling the current handler —
 * listing it as a dependency would tear the watch down on every render, and
 * capturing it once would leave the handler looking at stale state.
 */
export function useVaultWatch({
  watch,
  vaultKey,
  onChange,
}: {
  watch: VaultWatchPort;
  vaultKey: string | null;
  onChange: (paths: readonly string[]) => void;
}): void {
  const handler = useRef(onChange);
  handler.current = onChange;

  useEffect(() => {
    if (vaultKey === null) return;

    let stop: (() => void) | null = null;
    let cancelled = false;

    void (async () => {
      try {
        await watch.start();
        const unsubscribe = await watch.onChange((paths) => handler.current(paths));
        if (cancelled) unsubscribe();
        else stop = unsubscribe;
      } catch {
        // Without a watcher the app still works; it just will not notice
        // changes made elsewhere until the next refresh.
      }
    })();

    return () => {
      cancelled = true;
      stop?.();
    };
  }, [watch, vaultKey]);
}
