import { useCallback, useMemo, useRef, useState } from 'react';
import {
  connectKindle,
  disconnectKindle,
  type Clock,
  type IndexPort,
  type KindleDelay,
  type KindleNotebookSource,
  type KindleSession,
  type KindleSync,
  type KindleSyncRecords,
  type KindleVaultChoices,
  type LiteratureNoteWritePorts,
  type MarkdownPort,
  type Rng,
  type VaultFsPort,
} from '@dfai/application';
import { useSteadyCallback, type KindleBusy, type KindleView } from '@dfai/ui';
import { errorMessage } from '../query/error-message.ts';
import { kindleViewOf } from './kindle-view.ts';
import { useKindleRuns } from './use-kindle-runs.ts';
import { useKindleToast } from './use-kindle-toast.ts';
import { useKindleVaultChoice } from './use-kindle-vault-choice.ts';

/** Kindle, through the host (ADR-0044), and this app's one sync of it. */
export interface KindleHost {
  readonly notebook: KindleNotebookSource;
  readonly session: KindleSession;
  /** The app's one `createKindleSync`: launch, the schedule, Settings and ⌘K all use it. */
  readonly sync: KindleSync;
  /** The real wait between two fetches. */
  readonly delay: KindleDelay;
  /** This Mac's record of Kindle sync, outside the vault. */
  readonly records: KindleSyncRecords;
  /** Which vaults Kindle sync writes into, outside the vault. */
  readonly vaults: KindleVaultChoices;
}

export interface KindleWindowOptions {
  readonly kindle: KindleHost;
  /** The open vault's files, notes, index and panes, bound to it. */
  readonly fs: VaultFsPort;
  readonly markdown: LiteratureNoteWritePorts['markdown'] &
    Pick<MarkdownPort, 'frontmatterProperties'>;
  readonly index: Pick<IndexPort, 'notesOfType'>;
  readonly openNotes: LiteratureNoteWritePorts['openNotes'];
  readonly rng: Rng;
  readonly clock: Pick<Clock, 'now' | 'today'>;
  /** The open vault's root; null with none open. */
  readonly vaultKey: string | null;
  /** Whether the index holds the vault as it is: the literature notes are looked up in it. */
  readonly indexReady: boolean;
  /** Re-reads the tree and the index once a sync has written into the vault. */
  readonly onWrote: () => void;
}

export interface KindleController {
  readonly view: KindleView;
  readonly connect: () => void;
  readonly syncNow: () => void;
  readonly disconnect: () => void;
  /** Turns Kindle sync into the open vault on or off. */
  readonly setIntoVault: (on: boolean) => void;
  /** What a sync the person asked for said; null when nothing is to be said. */
  readonly toast: string | null;
  /** How many toasts have been shown: the Toast's `key`. */
  readonly toastShown: number;
  readonly dismissToast: (shown: number) => void;
}

/**
 * Kindle sync for the window (#508): into a vault the person turned it on
 * for, once the vault's index is ready, then every four hours while it is
 * open, each automatic try left to `runKindleSync` (connected, not held, not
 * just synced); Connect, Sync now and Disconnect for Settings and ⌘K. An
 * automatic try that does not run changes nothing on screen.
 */
export function useKindleSync(options: KindleWindowOptions): KindleController {
  const { kindle, clock, vaultKey } = options;
  const [record, setRecord] = useState(() => kindle.records.read());
  const busy = useKindleBusy();
  const [problem, setProblem] = useState<string | null>(null);
  const toast = useKindleToast();
  const { intoVault, setIntoVault } = useKindleVaultChoice(kindle.vaults, vaultKey);
  const runs = useKindleRuns({ options, intoVault, setRecord, say: toast.say });

  const connect = useSteadyCallback(async () => {
    if (busy.now() !== null) return;
    busy.set('connecting');
    setProblem(null);
    try {
      setRecord(await connectKindle({ session: kindle.session, records: kindle.records }));
      busy.set('syncing');
      await runs.asked();
    } catch (error) {
      setProblem(errorMessage(error));
    } finally {
      busy.set(null, 'connecting', 'syncing');
    }
  });

  const syncNow = useSteadyCallback(async () => {
    if (busy.now() !== null) return;
    busy.set('syncing');
    try {
      await runs.asked();
    } finally {
      busy.set(null, 'syncing');
    }
  });

  const disconnect = useSteadyCallback(async () => {
    // A sign-in window is open, or a Disconnect is already under way; a sync is not in the way.
    if (busy.now() === 'connecting' || busy.now() === 'disconnecting') return;
    busy.set('disconnecting');
    setProblem(null);
    try {
      setRecord(await disconnectKindle({ session: kindle.session, records: kindle.records }));
    } catch (error) {
      setProblem(errorMessage(error));
    } finally {
      busy.set(null, 'disconnecting');
    }
  });

  const now = clock.now;
  const view = useMemo(
    () => kindleViewOf(record, { busy: busy.shown, problem, intoVault, now: now() }),
    [record, busy.shown, problem, intoVault, now],
  );
  // One object while nothing in it changes: the window's toasts and Settings are drawn from it.
  return useMemo(
    () => ({
      view,
      connect: () => void connect(),
      syncNow: () => void syncNow(),
      disconnect: () => void disconnect(),
      setIntoVault,
      toast: toast.message,
      toastShown: toast.shown,
      dismissToast: toast.dismiss,
    }),
    [view, connect, syncNow, disconnect, setIntoVault, toast.message, toast.shown, toast.dismiss],
  );
}

/**
 * What Kindle sync is doing now: `shown` for the card, and `now` for a
 * press that comes before the card has been drawn again (⌘K pressed twice).
 * `set(null, ...phases)` ends a phase only if it is still the one under way,
 * so a Disconnect pressed during a sync is not ended by the sync's end.
 */
function useKindleBusy() {
  const [shown, setShown] = useState<KindleBusy | null>(null);
  const current = useRef<KindleBusy | null>(null);
  const set = useCallback((next: KindleBusy | null, ...endsPhases: KindleBusy[]) => {
    if (next === null && !endsPhases.some((phase) => phase === current.current)) return;
    current.current = next;
    setShown(next);
  }, []);
  return { shown, now: () => current.current, set };
}
