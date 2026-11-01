import { useEffect, useMemo, useRef } from 'react';
import { noticeReport, newlyShownNotices, type ActivityLevel } from '@dfai/domain';
import {
  createActivityLog,
  type ActivityLog,
  type ActivityStore,
  type WindowClosingPort,
} from '@dfai/application';
import { localClock } from '../today.ts';

/** How long lines wait to be written together: long enough to batch a burst, short enough to read back at once. */
export const ACTIVITY_WRITE_DELAY_MS = 300;

/** The longest closing the window waits for the last lines to be written. */
const CLOSE_WAIT_MS = 1000;

/**
 * The window's one Activity log (U-28), keeping each line for the vault its
 * recorder names. What waits to be written is written when the window closes
 * or the page unloads, rather than lost with the timer.
 */
export function useActivityLog({
  store,
  vaultKey,
  closing,
}: {
  store: ActivityStore;
  vaultKey: string | null;
  closing: WindowClosingPort;
}): ActivityLog {
  const open = useRef(vaultKey);
  open.current = vaultKey;
  const log = useMemo(
    () =>
      createActivityLog({
        store,
        clock: localClock,
        vault: () => open.current,
        schedule: (write) => void window.setTimeout(write, ACTIVITY_WRITE_DELAY_MS),
        onError: (cause) => console.error('The Activity log could not be written:', cause),
      }),
    [store],
  );
  useFlushOnClose(log, closing);
  return log;
}

function useFlushOnClose(log: { flush(): Promise<void> }, closing: WindowClosingPort): void {
  useEffect(() => {
    // An unload cannot wait: the write is started, and the host finishes it.
    const onUnload = () => void log.flush();
    window.addEventListener('beforeunload', onUnload);
    let stop: (() => void) | null = null;
    let live = true;
    void closing
      .beforeClose(() => withinCloseWait(log.flush()))
      .then(
        (stopListening) => {
          if (live) stop = stopListening;
          else stopListening();
        },
        // The unload above still writes what waits; only the close button's wait is lost.
        (cause: unknown) => console.error("The window's close cannot be watched:", cause),
      );
    return () => {
      live = false;
      window.removeEventListener('beforeunload', onUnload);
      stop?.();
    };
  }, [log, closing]);
}

/** The write, or the wait's end, whichever comes first: a hung disk must not keep the window open. */
function withinCloseWait(write: Promise<void>): Promise<void> {
  return Promise.race([
    write,
    new Promise<void>((resolve) => void window.setTimeout(resolve, CLOSE_WAIT_MS)),
  ]);
}

/** The red and amber notices on screen, each a line when it appears. */
export interface ShownNotices {
  readonly errors: readonly (string | null)[];
  readonly warnings: readonly (string | null)[];
}

/**
 * Records each notice the window shows, once, as it appears (U-28): not again
 * while it stays, and again if it goes and comes back. The caller leaves out
 * a notice whose failure its source has recorded already.
 */
export function useNoticeActivity(notices: ShownNotices, log: Pick<ActivityLog, 'record'>): void {
  useShownNotices(notices.errors, 'error', log);
  useShownNotices(notices.warnings, 'warning', log);
}

function useShownNotices(
  notices: readonly (string | null)[],
  level: ActivityLevel,
  log: Pick<ActivityLog, 'record'>,
): void {
  const shown = useRef<readonly (string | null)[]>([]);
  const key = JSON.stringify(notices);
  useEffect(() => {
    const now: readonly (string | null)[] = JSON.parse(key);
    for (const notice of newlyShownNotices(shown.current, now)) {
      log.record(noticeReport(notice, level));
    }
    shown.current = now;
  }, [key, level, log]);
}
