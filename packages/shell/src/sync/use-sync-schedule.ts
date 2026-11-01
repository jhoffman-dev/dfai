import { useEffect, useRef, type MutableRefObject } from 'react';
import {
  DEFAULT_PULL_INTERVAL_MINUTES,
  DEFAULT_PUSH_DELAY_SECONDS,
  syncAfterLook,
  dueSync,
  firstUnsyncedAfterEdit,
} from '@dfai/domain';
import type { Clock, WindowClosingPort } from '@dfai/application';
import type { IndexNewsFeed } from '../reads/use-scoped-index-news.ts';

/** How often the clock is checked for a sync, or a look at GitHub, that has come due. */
export const SYNC_TICK_MS = 5_000;
/** The longest the window's close waits for the last sync: a slow network must not hold it open. */
export const QUIT_SYNC_WAIT_MS = 20_000;

/**
 * The timers of a synced vault (U-29, A29-01): a sync once changes have
 * settled (and at least every few minutes while they keep coming), a look
 * at GitHub every minute or so, and a last sync as the window closes —
 * none of it while sync is paused on this Mac. Whether anything is due is
 * the domain's to say (`dueSync`); this only keeps the time.
 */
export function useSyncSchedule({
  enabled,
  paused,
  pushDelaySeconds,
  pullIntervalMinutes,
  edits,
  clock,
  lastSyncAt,
  lastCheckAt,
  closing,
  run,
  check,
}: {
  enabled: boolean;
  paused: boolean;
  pushDelaySeconds: number | null;
  pullIntervalMinutes: number | null;
  edits: IndexNewsFeed;
  clock: Pick<Clock, 'now'>;
  lastSyncAt: MutableRefObject<number | null>;
  lastCheckAt: MutableRefObject<number | null>;
  closing: WindowClosingPort;
  run: () => Promise<unknown>;
  check: () => Promise<{ behind: number; ahead: number }>;
}): void {
  const lastEditAt = useRef<number | null>(null);
  const firstUnsyncedEditAt = useRef<number | null>(null);
  const latest = useRef({ run, check });
  latest.current = { run, check };

  // Every change counts, one made while a sync runs included: that one is not
  // in it, and is sent in turn. What a sync brings in counts too, which costs
  // one more sync that finds nothing to send.
  useEffect(
    () =>
      edits.subscribe(() => {
        const now = clock.now();
        firstUnsyncedEditAt.current = firstUnsyncedAfterEdit({
          now,
          firstUnsyncedEditAt: firstUnsyncedEditAt.current,
          lastSyncAt: lastSyncAt.current,
        });
        lastEditAt.current = now;
      }),
    [edits, clock, lastSyncAt],
  );

  useEffect(() => {
    if (!enabled || paused) return;
    const lookThenBringIn = async () => {
      const found = await latest.current.check();
      const since = { lastSyncAt: lastSyncAt.current, lastEditAt: lastEditAt.current };
      if (syncAfterLook({ ...found, ...since })) await latest.current.run();
    };
    const timer = setInterval(() => {
      const due = dueSync({
        now: clock.now(),
        paused,
        lastSyncAt: lastSyncAt.current,
        lastCheckAt: lastCheckAt.current,
        lastEditAt: lastEditAt.current,
        firstUnsyncedEditAt: firstUnsyncedEditAt.current,
        pushDelaySeconds: pushDelaySeconds ?? DEFAULT_PUSH_DELAY_SECONDS,
        pullIntervalMinutes: pullIntervalMinutes ?? DEFAULT_PULL_INTERVAL_MINUTES,
      });
      if (due === 'push') void latest.current.run();
      if (due === 'check') void lookThenBringIn();
    }, SYNC_TICK_MS);
    return () => clearInterval(timer);
  }, [enabled, paused, pushDelaySeconds, pullIntervalMinutes, clock, lastSyncAt, lastCheckAt]);

  useSyncBeforeClose({ enabled: enabled && !paused, closing, latest });
}

function useSyncBeforeClose({
  enabled,
  closing,
  latest,
}: {
  enabled: boolean;
  closing: WindowClosingPort;
  latest: MutableRefObject<{ run: () => Promise<unknown> }>;
}) {
  useEffect(() => {
    if (!enabled) return;
    let stop: (() => void) | null = null;
    let live = true;
    void closing
      .beforeClose(() => withinQuitWait(latest.current.run()))
      .then(
        (stopListening) => {
          if (live) stop = stopListening;
          else stopListening();
        },
        // Without the close watched, the vault syncs again when it next opens.
        (cause: unknown) => console.error("The window's close cannot be watched:", cause),
      );
    return () => {
      live = false;
      stop?.();
    };
  }, [enabled, closing, latest]);
}

function withinQuitWait(sync: Promise<unknown>): Promise<void> {
  return Promise.race([
    sync.then(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, QUIT_SYNC_WAIT_MS)),
  ]);
}
