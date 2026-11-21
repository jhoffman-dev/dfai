import { useCallback, useEffect, useRef, useState } from 'react';

/** What a sync the person asked for said, and how many toasts have been shown. */
export interface KindleToast {
  /** What was said; null when nothing is to be said. */
  readonly message: string | null;
  /** How many toasts have been shown: the Toast's `key`, so the same words again start its time afresh. */
  readonly shown: number;
  readonly say: (message: string) => void;
  readonly dismiss: (shown: number) => void;
}

/**
 * Kindle's toast. While Kindle is switched off (`enabled` false, #901) the
 * toast up is put away, not hidden, and nothing is said — not even by a sync
 * asked for before the switch that ends after it — so switching Kindle on
 * again brings back no old words.
 */
export function useKindleToast(enabled: boolean): KindleToast {
  const [toast, setToast] = useState<{ message: string | null; shown: number }>({
    message: null,
    shown: 0,
  });
  // Read when a sync ends, which may be after the switch: the value as last committed.
  const saying = useRef(enabled);
  useEffect(() => {
    saying.current = enabled;
    if (!enabled) setToast((now) => (now.message === null ? now : { ...now, message: null }));
  }, [enabled]);
  const say = useCallback((message: string) => {
    if (saying.current) setToast(({ shown }) => ({ message, shown: shown + 1 }));
  }, []);
  const dismiss = useCallback(
    (shown: number) =>
      setToast((now) => (now.shown === shown ? { message: null, shown: now.shown } : now)),
    [],
  );
  return { message: toast.message, shown: toast.shown, say, dismiss };
}
