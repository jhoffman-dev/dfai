import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  granolaFailureWords,
  granolaIndexWaitReport,
  parseGranolaSettings,
  type GranolaPullMode,
} from '@dfai/domain';
import {
  createGranolaPuller,
  GranolaError,
  type ActivityLog,
  type Clock,
  type GranolaKeyStatus,
  type GranolaPort,
  type GranolaPullRecords,
  type GranolaPullReport,
  type IndexPort,
  type MarkdownPort,
  type VaultFsPort,
} from '@dfai/application';
import { errorMessage } from '../query/error-message.ts';
import { useVaultSettingsRead } from '../settings/use-vault-settings-read.ts';

/** How often an open vault is pulled while its settings allow it (`granola_periodic`). */
export const GRANOLA_PULL_INTERVAL_MS = 15 * 60_000;

/** How long a pull waits for one catch-up of the index before it gives up and does not start. */
export const INDEX_WAIT_MS = 2 * 60_000;

export interface GranolaPullOptions {
  readonly granola: GranolaPort;
  /** This Mac's record of each vault's pulls. */
  readonly records: GranolaPullRecords;
  /** The open vault's files, notes and index, bound to it. */
  readonly fs: VaultFsPort;
  readonly markdown: MarkdownPort;
  readonly index: IndexPort;
  /** The open vault's root; null with none open. */
  readonly vaultKey: string | null;
  /** The vaults sync has pulled this session, or found not to sync (ADR-0034). */
  readonly syncedThisSession: ReadonlySet<string>;
  /** How many syncs this session have brought other Macs' files into each vault. */
  readonly syncPulls: ReadonlyMap<string, number>;
  /**
   * Brings the index of the open vault up to date; true once it holds the
   * files as they are now. Until then a meeting the import has moved out of
   * `Inbox/Meetings/` on another Mac is not found where it now is. Asked as
   * the vault opens once it has synced, and again after each sync that
   * brings files in. It waits for a build or refresh already under way —
   * the vault's first build, or the one a sync asks as it brings files in —
   * rather than reading the vault again behind it.
   */
  readonly catchUpIndex: () => Promise<boolean>;
  readonly clock: Pick<Clock, 'now'>;
  readonly activity: ActivityLog;
  /** Re-reads the tree and the index once a pull has written meetings into the vault. */
  readonly onWrote: () => void;
}

export interface GranolaPullController {
  /** Whether this Mac holds a key for the open vault, and Granola's last word on it; null while asked. */
  readonly key: GranolaKeyStatus | null;
  /** Why whether a key is held could not be asked. */
  readonly keyProblem: string | null;
  /**
   * Whether the open vault may be pulled into: it has synced this session, or
   * does not sync, and the index has caught up with what every sync brought in.
   */
  readonly ready: boolean;
  /** Whether a pull of the open vault is under way. */
  readonly pulling: boolean;
  /** How the last pull of the open vault this session ended. */
  readonly report: GranolaPullReport | null;
  /** When this Mac last finished a pull of the open vault, as its record keeps it. */
  readonly lastPullAt: number | null;
  /** What to tell the person at once: a Sync now that failed, or a key Granola has just refused. */
  readonly toast: string | null;
  /** How many times a toast has been shown: the Toast's `key`, so the same words again start its time afresh. */
  readonly toastShown: number;
  /**
   * Lets the showing counted `shown` go. A later showing is left up: the Toast
   * it replaces can time out before the window draws the new one.
   */
  readonly dismissToast: (shown: number) => void;
  readonly syncNow: () => void;
  /**
   * Sync now for `vault`, settling to its report: the local API's pull
   * (P28-13). It shows on the card, never as a toast, since no one in the
   * window asked for it. A vault that is not open is not pulled: what was
   * synced and caught up is the open vault's, so its report ends `not-synced`.
   */
  readonly syncNowFor: (vault: string) => Promise<GranolaPullReport>;
  /**
   * Whether `vault` may be pulled into now, as the puller judges it: it is
   * open, has synced this session (or does not sync), and the index has caught
   * up with every sync into it. Read as it is asked, never a render behind.
   */
  readonly readyFor: (vault: string) => boolean;
  /** Takes the key's status the host answered a change of key with. */
  readonly knowKey: (status: GranolaKeyStatus) => void;
}

/** A pull asked for, and whether the window may say how it ended as a toast. */
interface PullAsked {
  readonly vault: string;
  readonly mode: GranolaPullMode;
  /** False for the API's pull: no one in the window asked for it, so the card alone says it. */
  readonly toasts: boolean;
}

/** One pull under way, told apart from another of the same vault by its identity. */
interface Flight {
  readonly vault: string;
}

/** What is known of one vault's pulls, kept with the vault it belongs to. */
interface VaultPulls {
  readonly vault: string | null;
  readonly key: GranolaKeyStatus | null;
  readonly keyProblem: string | null;
  /** `granola_periodic` as the settings say; null until they are read. */
  readonly periodic: boolean | null;
  readonly report: GranolaPullReport | null;
  readonly lastPullAt: number | null;
  readonly toast: string | null;
  readonly toastShown: number;
}

const nothingFor = (vault: string | null): VaultPulls => ({
  vault,
  key: null,
  keyProblem: null,
  periodic: null,
  report: null,
  lastPullAt: null,
  toast: null,
  toastShown: 0,
});

const wait = (milliseconds: number) =>
  new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds));

const problemOf = (cause: unknown) =>
  cause instanceof GranolaError ? granolaFailureWords(cause.failure) : errorMessage(cause);

/**
 * What a pull that ended should say at once, beside its line in Activity: a
 * key Granola refused, and a Sync now that failed, which the person is
 * waiting on. A pull that started by itself and failed for another reason
 * says so in Activity and on the card only. A refused key is said once,
 * since nothing is pulled by itself with a key Granola refused.
 */
function toastOf(report: GranolaPullReport): string | null {
  if (report.keyRefused) return report.problem;
  const failed = report.ended === 'stopped' || report.ended === 'failed';
  return report.mode === 'sync-now' && failed ? report.problem : null;
}

/**
 * Pulls Granola's meetings into the open vault (ADR-0034): once as it opens,
 * every 15 minutes while its settings allow, and on Sync now — and only once
 * a sync has pulled the vault this session, and while this Mac holds a key
 * Granola has not refused. Sync now asks whatever the key's last answer was.
 * One puller for the window, so a pull of a vault never runs twice at once.
 */
export function useGranolaPull(options: GranolaPullOptions): GranolaPullController {
  const { granola, records, fs, markdown, vaultKey } = options;
  const latest = useRef(options);
  latest.current = options;
  const caughtUp = useCaughtUp(options);
  const puller = useMemo(
    () =>
      createGranolaPuller({
        ports: () => {
          const { fs: files, markdown: notes, index, granola: api, records: kept } = latest.current;
          return { fs: files, markdown: notes, index, granola: api, records: kept };
        },
        clock: { now: () => latest.current.clock.now() },
        wait,
        activity: options.activity,
        openVault: () => latest.current.vaultKey,
        syncedThisSession: caughtUp.has,
      }),
    [options.activity, caughtUp.has],
  );

  const [held, setHeld] = useState<VaultPulls>(() => nothingFor(vaultKey));
  const mine = held.vault === vaultKey ? held : nothingFor(vaultKey);
  /** Changes what is known of `vault`, unless another vault has opened since. */
  const update = useCallback(
    (vault: string, change: (known: VaultPulls) => Partial<VaultPulls>) =>
      setHeld((known) => (known.vault === vault ? { ...known, ...change(known) } : known)),
    [],
  );

  // Answers about the key land out of order: only the one asked for, or told, last may say what it is.
  const keyTicket = useRef(0);
  const readKey = useCallback(
    (vault: string) => {
      keyTicket.current += 1;
      const ticket = keyTicket.current;
      const ifLatest = (change: () => Partial<VaultPulls>) => {
        if (ticket === keyTicket.current) update(vault, change);
      };
      return granola.status({ vault }).then(
        (key) => ifLatest(() => ({ key, keyProblem: null })),
        (cause: unknown) => ifLatest(() => ({ keyProblem: problemOf(cause) })),
      );
    },
    [granola, update],
  );

  useEffect(() => {
    setHeld({
      ...nothingFor(vaultKey),
      lastPullAt: vaultKey === null ? null : records.read(vaultKey).lastPullAt,
    });
    if (vaultKey !== null) void readKey(vaultKey);
  }, [vaultKey, records, readKey]);

  const { settings, unreadable } = useVaultSettingsRead({ fs, markdown, vaultKey });
  useEffect(() => {
    if (vaultKey === null) return;
    if (unreadable !== null) {
      // The pull reads the settings too, and records in Activity why it could not.
      console.error('The vault’s Granola settings could not be read:', unreadable);
      update(vaultKey, () => ({ periodic: null }));
      return;
    }
    if (settings === undefined) return;
    const { periodic } = parseGranolaSettings(settings);
    update(vaultKey, () => ({ periodic }));
  }, [settings, unreadable, vaultKey, update]);

  // Each pull under way, by the vault it pulls: Sync now asked for during another pull runs after it.
  const [flights, setFlights] = useState<readonly Flight[]>([]);
  const { settled, openedReady } = caughtUp;
  /** One pull of `vault`, once its index has caught up, with what it did known to the card. */
  const pullAndKnow = useCallback(
    async ({ vault, mode, toasts }: PullAsked): Promise<GranolaPullReport> => {
      const caughtUpInTime = await settled(vault);
      const report = await puller.pull({ vault, mode });
      if (!caughtUpInTime && report.ended === 'not-synced') {
        latest.current.activity.inVault(vault).record(granolaIndexWaitReport());
      }
      if (report.written.length > 0 && latest.current.vaultKey === vault) {
        latest.current.onWrote();
      }
      update(vault, (known) => {
        const toast = toasts ? toastOf(report) : null;
        return {
          report,
          lastPullAt: latest.current.records.read(vault).lastPullAt,
          toast: toast ?? known.toast,
          toastShown: toast === null ? known.toastShown : known.toastShown + 1,
        };
      });
      return report;
    },
    [puller, update, settled],
  );
  const pullVault = useCallback(
    async (asked: PullAsked): Promise<GranolaPullReport> => {
      const { vault } = asked;
      const flight: Flight = { vault };
      setFlights((under) => [...under, flight]);
      const report = await pullAndKnow(asked).finally(() =>
        setFlights((under) => under.filter((each) => each !== flight)),
      );
      await readKey(vault);
      return report;
    },
    [pullAndKnow, readKey],
  );
  const pull = useCallback(
    async (mode: GranolaPullMode) => {
      const vault = latest.current.vaultKey;
      if (vault !== null) await pullVault({ vault, mode, toasts: true });
    },
    [pullVault],
  );

  const usable = mine.key?.hasKey === true && mine.key.lastRefusal === null;
  const periodic = mine.periodic === true;

  // Once per open, once the index has first caught up: a later sync's catch-up does not start another.
  useEffect(() => {
    if (openedReady && usable) void pull('startup');
  }, [vaultKey, openedReady, usable, pull]);

  useEffect(() => {
    if (!openedReady || !usable || !periodic) return;
    const timer = window.setInterval(() => void pull('periodic'), GRANOLA_PULL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [vaultKey, openedReady, usable, periodic, pull]);

  return {
    key: mine.key,
    keyProblem: mine.keyProblem,
    ready: caughtUp.ready,
    pulling: vaultKey !== null && flights.some((flight) => flight.vault === vaultKey),
    report: mine.report,
    lastPullAt: mine.lastPullAt,
    toast: mine.toast,
    toastShown: mine.toastShown,
    dismissToast: useCallback(
      (shown: number) => {
        if (vaultKey === null) return;
        update(vaultKey, (known) => (known.toastShown === shown ? { toast: null } : {}));
      },
      [vaultKey, update],
    ),
    syncNow: useCallback(() => void pull('sync-now'), [pull]),
    syncNowFor: useCallback(
      (vault: string) => pullVault({ vault, mode: 'sync-now', toasts: false }),
      [pullVault],
    ),
    readyFor: caughtUp.has,
    knowKey: useCallback(
      (key: GranolaKeyStatus) => {
        // Newer than any read still out: that read's answer is set aside when it lands.
        keyTicket.current += 1;
        if (vaultKey !== null) update(vaultKey, () => ({ key, keyProblem: null }));
      },
      [vaultKey, update],
    ),
  };
}

/** One open of a vault: a vault closed and opened again is a new one. */
interface Opening {
  readonly vault: string;
}

/** One request that the index catch up, for an open of a vault and the syncs into it so far. */
interface CatchUp {
  readonly opening: Opening;
  readonly syncPulls: number;
  /** Settles, never rejecting, once the index has answered. */
  readonly done: Promise<void>;
  /** Settles once a newer catch-up is asked for: one waiting for this one waits for that instead. */
  readonly superseded: Promise<void>;
  readonly supersede: () => void;
}

/** Whether `promise` settled within `milliseconds`; the timer is cleared either way. */
async function settlesWithin(promise: Promise<void>, milliseconds: number): Promise<boolean> {
  let timer = 0;
  const timedOut = new Promise<false>((resolve) => {
    timer = window.setTimeout(() => resolve(false), milliseconds);
  });
  try {
    return await Promise.race([promise.then(() => true as const), timedOut]);
  } finally {
    window.clearTimeout(timer);
  }
}

/**
 * Whether the index of the open vault has caught up with what sync brought
 * in (ADR-0034). Once sync has pulled the vault this session, or found it
 * does not sync, the index is asked to catch up as the vault opens, and again
 * after each later sync that brings files in; the vault is ready while the
 * last of these has caught up. One that fails leaves it waiting and says why
 * in Activity; the next sync, or the vault opened again, asks again. Each is
 * asked once: nothing asks again in a loop. A pull waits for the last one
 * asked, and for any asked while it waits, but for no one of them longer
 * than {@link INDEX_WAIT_MS}.
 */
function useCaughtUp({
  vaultKey,
  syncedThisSession,
  syncPulls,
  catchUpIndex,
}: Pick<GranolaPullOptions, 'vaultKey' | 'syncedThisSession' | 'syncPulls' | 'catchUpIndex'>) {
  const synced = vaultKey !== null && syncedThisSession.has(vaultKey);
  const pulls = vaultKey === null ? 0 : (syncPulls.get(vaultKey) ?? 0);
  const catchUp = useRef(catchUpIndex);
  catchUp.current = catchUpIndex;
  // Read by the puller as it starts, and by a pull waiting to, so neither waits for a render.
  const opening = useRef<Opening | null>(null);
  const asked = useRef<CatchUp | null>(null);
  const caught = useRef<CatchUp | null>(null);
  const syncPullsNow = useRef(syncPulls);
  syncPullsNow.current = syncPulls;
  // The same two, for the render.
  const [askedShown, setAsked] = useState<CatchUp | null>(null);
  const [caughtShown, setCaught] = useState<CatchUp | null>(null);

  useEffect(() => {
    if (opening.current?.vault !== vaultKey) {
      opening.current = vaultKey === null ? null : { vault: vaultKey };
    }
    const open = opening.current;
    if (open === null || !synced) return;
    if (asked.current?.opening === open && asked.current.syncPulls === pulls) return;
    let supersede = () => {};
    const superseded = new Promise<void>((resolve) => (supersede = resolve));
    const ask: CatchUp = {
      opening: open,
      syncPulls: pulls,
      superseded,
      supersede,
      done: catchUp.current().then(
        (held) => {
          if (!held || asked.current !== ask) return;
          caught.current = ask;
          setCaught(ask);
        },
        // Says why in Activity itself; the vault waits for the next sync or open.
        () => undefined,
      ),
    };
    const previous = asked.current;
    asked.current = ask;
    previous?.supersede();
    setAsked(ask);
  }, [vaultKey, synced, pulls]);

  const has = useCallback((vault: string) => {
    const last = asked.current;
    return (
      last !== null &&
      caught.current === last &&
      last.opening === opening.current &&
      last.opening.vault === vault &&
      last.syncPulls === (syncPullsNow.current.get(vault) ?? 0)
    );
  }, []);
  /**
   * Settles once the catch-up asked for last has, and no newer one was asked
   * for meanwhile, so a pull waits for every sync that lands while it waits;
   * true then, and false when one of them has not answered in
   * {@link INDEX_WAIT_MS}. Waits for no catch-up of another vault.
   */
  const settled = useCallback(async (vault: string): Promise<boolean> => {
    for (;;) {
      const ask = asked.current;
      if (ask?.opening.vault !== vault) return true;
      const answered = await settlesWithin(Promise.race([ask.done, ask.superseded]), INDEX_WAIT_MS);
      if (asked.current === ask) return answered;
    }
  }, []);

  const thisOpen = askedShown !== null && askedShown.opening.vault === vaultKey && synced;
  const openedReady =
    thisOpen && caughtShown !== null && caughtShown.opening === askedShown.opening;
  const ready = openedReady && caughtShown === askedShown && askedShown.syncPulls === pulls;
  return useMemo(() => ({ has, settled, ready, openedReady }), [has, settled, ready, openedReady]);
}
