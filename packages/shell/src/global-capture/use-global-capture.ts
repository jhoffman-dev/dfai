import { useCallback, useEffect, useRef, useState } from 'react';
import type { GlobalCapturePort, GlobalCaptureShortcut } from '@dfai/application';
import type { GlobalCaptureStore } from './browser-global-capture-store.ts';

/** The global capture shortcut as Settings shows it, and a way to change it. */
export interface GlobalCapture {
  /** Null until the host has answered once. */
  readonly status: GlobalCaptureShortcut | null;
  readonly change: (shortcut: string | null) => void;
}

/**
 * The system-wide shortcut that opens quick capture (#81): handed to the host
 * as the app starts, so it works from the moment the window is up, and heard
 * back from it each time it is pressed. `pressed` is read when the press
 * arrives, so it always acts on the vault open then.
 */
export function useGlobalCapture({
  port,
  store,
  pressed,
}: {
  port: GlobalCapturePort;
  store: GlobalCaptureStore;
  pressed: () => void;
}): GlobalCapture {
  const [status, setStatus] = useState<GlobalCaptureShortcut | null>(null);
  const latest = useRef(pressed);
  useEffect(() => {
    latest.current = pressed;
  });

  const register = useCallback(
    async (shortcut: string | null) => {
      try {
        setStatus(await port.set(shortcut));
      } catch (cause) {
        // Refused by the host: nothing is registered, and Settings says why.
        setStatus({ shortcut, registered: false, problem: reasonOf(cause) });
      }
    },
    [port],
  );

  // Once per host, as the app starts: a store handed in afresh on each render
  // is no reason to register the shortcut again.
  const chosen = useRef(store);
  useEffect(() => {
    void register(chosen.current.read());
  }, [register]);

  useEffect(() => {
    let stop: (() => void) | null = null;
    let cancelled = false;
    port
      .listen(() => latest.current())
      .then((unlisten) => {
        if (cancelled) unlisten();
        else stop = unlisten;
      })
      .catch(() => {
        // Outside Tauri — `pnpm dev` in a plain browser — there is no host,
        // so there is no shortcut to hear.
      });
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [port]);

  const change = useCallback(
    (shortcut: string | null) => {
      store.write(shortcut);
      void register(shortcut);
    },
    [store, register],
  );

  return { status, change };
}

const reasonOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);
