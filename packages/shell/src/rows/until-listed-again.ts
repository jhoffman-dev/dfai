import { useCallback, useEffect, useRef } from 'react';

/**
 * The longest U waits for the row it took back to be listed again before it
 * says where the row is anyway: a refresh that failed is never answered for.
 */
export const LISTED_AGAIN_LIMIT_MS = 5_000;

/**
 * Waits, after an undo (#109), until `settled` says the row it took back is
 * listed again or will not be — reads begun before the index caught up do
 * not count — so the page's focus watch, which gives a row up after a few
 * lists without it, is not run down by them. `settled` is asked again each
 * time it changes. A wait also ends as the page goes or another vault opens,
 * when nothing will list the row here, and after `LISTED_AGAIN_LIMIT_MS`.
 */
export function useUntilListedAgain<Row>(
  settled: (row: Row) => boolean,
  vaultKey: string | null,
): (row: Row) => Promise<void> {
  const waiting = useRef<{ readonly row: Row; readonly done: () => void }[]>([]);
  const settledNow = useRef(settled);
  const settle = useCallback(() => {
    for (const each of [...waiting.current]) if (settledNow.current(each.row)) each.done();
  }, []);
  useEffect(() => {
    settledNow.current = settled;
    settle();
  }, [settled, settle]);
  useEffect(
    () => () => {
      for (const each of [...waiting.current]) each.done();
    },
    [vaultKey],
  );
  return useCallback(
    (row: Row) =>
      new Promise<void>((resolve) => {
        const limit = setTimeout(done, LISTED_AGAIN_LIMIT_MS);
        function done() {
          clearTimeout(limit);
          waiting.current = waiting.current.filter((each) => each.done !== done);
          resolve();
        }
        waiting.current.push({ row, done });
        settle();
      }),
    [settle],
  );
}
