import { useCallback, useState } from 'react';

/** What a sync the person asked for said, and how many toasts have been shown. */
export interface KindleToast {
  /** What was said; null when nothing is to be said. */
  readonly message: string | null;
  /** How many toasts have been shown: the Toast's `key`, so the same words again start its time afresh. */
  readonly shown: number;
  readonly say: (message: string) => void;
  readonly dismiss: (shown: number) => void;
}

export function useKindleToast(): KindleToast {
  const [toast, setToast] = useState<{ message: string | null; shown: number }>({
    message: null,
    shown: 0,
  });
  const say = useCallback(
    (message: string) => setToast(({ shown }) => ({ message, shown: shown + 1 })),
    [],
  );
  const dismiss = useCallback(
    (shown: number) =>
      setToast((now) => (now.shown === shown ? { message: null, shown: now.shown } : now)),
    [],
  );
  return { message: toast.message, shown: toast.shown, say, dismiss };
}
