import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';
import {
  EVERY_ACTIVITY,
  activityMatches,
  activitySeenAt,
  filterActivity,
  unseenErrorCount,
  type ActivityEvent,
  type ActivityQuery,
} from '@dfai/domain';
import type { ActivityLog, ActivityNews, Clock } from '@dfai/application';
import { errorMessage } from '../query/error-message.ts';
import type { ActivitySeenStore } from './browser-activity-seen-store.ts';

/** The open vault's lines as last read, and which vault they were read from. */
interface Read {
  readonly vault: string;
  readonly events: readonly ActivityEvent[];
}

/**
 * The Activity page's state (U-28): the open vault's lines, read when it
 * opens and added to as the log keeps more; the filters and search over them; and how many errors
 * arrived since the page was last open, for the sidebar's badge. Opening the
 * page — and new lines arriving while it is open — counts as seeing them.
 */
export function useActivity({
  log,
  vaultKey,
  open,
  seen,
  clock,
}: {
  log: ActivityLog;
  vaultKey: string | null;
  /** Whether the page is on screen. */
  open: boolean;
  seen: ActivitySeenStore;
  clock: Pick<Clock, 'now'>;
}) {
  const [read, setRead] = useState<Read | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState<ActivityQuery>(EVERY_ACTIVITY);
  const [seenAt, setSeenAt] = useState<{ vault: string; at: number | null } | null>(null);

  useLines({ log, vaultKey, setRead, setError });

  const events = read !== null && read.vault === vaultKey ? read.events : null;
  const lastSeen =
    vaultKey === null ? null : seenAt?.vault === vaultKey ? seenAt.at : seen.read(vaultKey);

  useEffect(() => {
    if (!open || vaultKey === null) return;
    // Past the newest line, too: one dated while the clock ran ahead is seen now, not once it catches up.
    const at = activitySeenAt(events ?? [], clock.now());
    seen.write(vaultKey, at);
    setSeenAt({ vault: vaultKey, at });
  }, [open, vaultKey, events, seen, clock]);

  // Read newest first; narrowing keeps that order.
  const shown = useMemo(
    () => events?.filter((event) => activityMatches(event, query)) ?? null,
    [events, query],
  );
  return {
    /** The lines the filters let through, newest first; null until first read. */
    shown,
    /** How many lines the vault's log holds, whatever the filters. */
    total: events?.length ?? 0,
    error,
    query,
    setQuery: useCallback((next: ActivityQuery) => setQuery(next), []),
    /** Errors since the page was last open; none while it is. */
    unseenErrors: open || events === null ? 0 : unseenErrorCount(events, lastSeen),
  };
}

/** Reads the open vault's lines when it opens, then adds those the log keeps for it. */
function useLines({
  log,
  vaultKey,
  setRead,
  setError,
}: {
  log: ActivityLog;
  vaultKey: string | null;
  setRead: Dispatch<SetStateAction<Read | null>>;
  setError: (error: string | null) => void;
}) {
  useEffect(() => {
    if (vaultKey === null) return;
    let live = true;
    let landed = false;
    const added = ({ vault, events }: ActivityNews) => {
      if (vault !== vaultKey) return;
      // Kept while the first read was under way: whether that read holds them is a race, so read again.
      if (!landed) return reload();
      setRead((was) => (was?.vault === vaultKey ? withNews(was, events) : was));
    };
    const reload = () => {
      log
        .read()
        .then((events) => {
          if (!live) return;
          landed = true;
          setRead({ vault: vaultKey, events });
          setError(null);
        })
        .catch((cause: unknown) => {
          if (live) setError(`The Activity log could not be read: ${errorMessage(cause)}`);
        });
    };
    reload();
    const stop = log.subscribe(added);
    return () => {
      live = false;
      stop();
    };
  }, [log, vaultKey, setRead, setError]);
}

/** The lines read, with those just kept added, newest first as a read gives them. */
function withNews(read: Read, events: readonly ActivityEvent[]): Read {
  const newestFirst = filterActivity(events, EVERY_ACTIVITY);
  return { vault: read.vault, events: [...newestFirst, ...read.events] };
}
