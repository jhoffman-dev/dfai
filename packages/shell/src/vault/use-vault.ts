import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import {
  flattenVaultTree,
  isWithin,
  VAULT_ROOT,
  type VaultEntry,
  type VaultPath,
  type VaultTreeRow,
} from '@dfai/domain';
import {
  listVaultDirectory,
  listVaultNotes,
  openVault,
  restoreVault,
  type VaultFsPort,
  type VaultLocation,
  type VaultLocationStore,
  type VaultPickerPort,
  type VaultWatchPort,
} from '@dfai/application';
import { sameReading } from '../same-reading.ts';

export interface VaultPorts {
  fs: VaultFsPort;
  picker: VaultPickerPort;
  store: VaultLocationStore;
  watch: VaultWatchPort;
}

export interface VaultView {
  location: VaultLocation | null;
  rows: readonly VaultTreeRow[];
  /** Every note in the vault, for resolving links and offering completions. */
  notePaths: readonly VaultPath[];
  /** The vault `notePaths` is the listing of, or null while a vault's listing is still on its way. */
  notesListedFor: string | null;
  error: string | null;
  chooseVault: () => void;
  /** Shows a vault another way of opening has already chosen and remembered — a clone from GitHub. */
  showVault: (location: VaultLocation) => void;
  toggleDirectory: (path: VaultPath) => void;
  /** Opens a folder in the tree, if it is not open already: where something was just put. */
  expandDirectory: (path: VaultPath) => void;
  /**
   * Forgets a folder that has moved or gone, and everything under it, so the
   * tree does not go on re-reading a path that is no longer there.
   */
  forgetDirectory: (path: VaultPath) => void;
  /** Whether a folder is open in the tree. */
  isExpanded: (path: VaultPath) => boolean;
  /**
   * Re-reads the directories already on screen, after an outside change, and
   * settles once the tree shows what is on disk.
   */
  reload: () => Promise<void>;
}

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Holds the part of the vault the user has actually looked at: directories are
 * read as they are expanded, never up front, so opening a large vault is instant.
 *
 * What is *open* is not here: the panes hold that, because with a split there
 * is more than one of it and the vault has no opinion about which.
 */
export function useVault(
  { fs, picker, store }: VaultPorts,
  {
    beforeSwitch,
    onSwitched,
  }: {
    /** Settles the vault being left, once another is chosen and before the host moves. */
    beforeSwitch?: () => Promise<void>;
    /**
     * Told the vault adopted, in the same event as the location changes, for
     * state that belongs to a vault and must change hands in the same render
     * (R14-01): the tabs, whose paths mean nothing in another vault.
     */
    onSwitched?: (next: VaultLocation) => void;
  } = {},
): VaultView {
  /** Read when a vault is chosen, so the callbacks need not be stable to be current. */
  const settle = useRef(beforeSwitch);
  settle.current = beforeSwitch;
  const switched = useRef(onSwitched);
  switched.current = onSwitched;

  const [location, setLocation] = useState<VaultLocation | null>(null);
  const [children, setChildren] = useState<ReadonlyMap<VaultPath, readonly VaultEntry[]>>(
    new Map(),
  );
  const [expanded, setExpanded] = useState<ReadonlySet<VaultPath>>(new Set());
  const [notePaths, setNotePaths] = useState<readonly VaultPath[]>([]);
  /** The vault `notePaths` lists, once its listing has come back; null until then. */
  const [notesListedFor, setNotesListedFor] = useState<string | null>(null);
  /** The vault adopted last, so a listing that lands after a switch is known for the vault it was asked of. */
  const adopted = useRef<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /**
   * Folders forgotten since the last render — moved or deleted — which a
   * reload in the same breath must not try to read: its `children` is a
   * render behind, and still lists them.
   */
  const forgotten = useRef<Set<VaultPath>>(new Set());

  const loadDirectory = useCallback(
    async (path: VaultPath) => {
      try {
        const entries = await listVaultDirectory({ fs, path });
        setChildren((current) => new Map(current).set(path, entries));
      } catch (cause) {
        setError(message(cause));
      }
    },
    [fs],
  );

  const adoptVault = useCallback(
    (next: VaultLocation) => {
      // One synchronous commit for the location and everything that changes
      // hands with it: `onSwitched` moves a store, whose readers React draws
      // at once, while a state change made here, after an await, is drawn
      // later. Left to that order, one render would show the next vault's
      // tabs against this vault's ports (R14-01).
      adopted.current = next.absolutePath;
      flushSync(() => {
        switched.current?.(next);
        setLocation(next);
        setChildren(new Map());
        setExpanded(new Set());
        setNotesListedFor(null);
        setError(null);
      });
      forgotten.current.clear();
      void loadDirectory(VAULT_ROOT);
      listVaultNotes({ fs })
        .then((paths) => {
          // Landed after another vault was adopted: its notes, not this one's.
          if (adopted.current !== next.absolutePath) return;
          setNotePaths(paths);
          setNotesListedFor(next.absolutePath);
        })
        .catch((cause: unknown) => setError(message(cause)));
    },
    [fs, loadDirectory],
  );

  // Reopen last launch's vault, if there was one.
  useEffect(() => {
    let cancelled = false;
    restoreVault({ store })
      .then((remembered) => {
        if (!cancelled && remembered !== null) adoptVault(remembered);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(message(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [store, adoptVault]);

  const chooseVault = useCallback(() => {
    openVault({ picker, store, beforeSwitch: () => settle.current?.() ?? Promise.resolve() })
      .then((chosen) => {
        if (chosen !== null) adoptVault(chosen);
      })
      .catch((cause: unknown) => setError(message(cause)));
  }, [picker, store, adoptVault]);

  const toggleDirectory = useCallback(
    (path: VaultPath) => {
      forgotten.current.delete(path);
      setExpanded((current) => {
        const next = new Set(current);
        if (next.has(path)) next.delete(path);
        else next.add(path);
        return next;
      });
      // Read a directory the first time it is opened, and not again. This must
      // stay outside the state updater: React may run an updater more than once,
      // and the read would then happen twice.
      if (!children.has(path)) void loadDirectory(path);
    },
    [children, loadDirectory],
  );

  const expandDirectory = useCallback(
    (path: VaultPath) => {
      if (path === VAULT_ROOT) return;
      forgotten.current.delete(path);
      setExpanded((current) => (current.has(path) ? current : new Set(current).add(path)));
      // Outside the updater, for the reason `toggleDirectory` gives.
      if (!children.has(path)) void loadDirectory(path);
    },
    [children, loadDirectory],
  );

  const forgetDirectory = useCallback((path: VaultPath) => {
    forgotten.current.add(path);
    const gone = (each: VaultPath) => isWithin(each, path);
    setChildren((current) => new Map([...current].filter(([each]) => !gone(each))));
    setExpanded((current) => new Set([...current].filter((each) => !gone(each))));
  }, []);

  const isExpanded = useCallback((path: VaultPath) => expanded.has(path), [expanded]);

  // Read by `reload` as it runs, so `reload` is one function while the tree
  // changes: every pane is handed what calls it (#325).
  const listed = useRef(children);
  listed.current = children;
  const reload = useCallback(async () => {
    const gone = (path: VaultPath) =>
      [...forgotten.current].some((folder) => isWithin(path, folder));
    const paths = [...listed.current.keys()].filter((path) => !gone(path));
    const askedOf = adopted.current;
    listVaultNotes({ fs })
      .then((notes) => {
        // The same list while it lists the same notes: every pane reads it, and
        // a new array for an edit that added no note would draw them all (#325).
        if (adopted.current === askedOf) {
          setNotePaths((listed) => (sameReading(listed, notes) ? listed : notes));
        }
      })
      .catch((cause: unknown) => setError(message(cause)));
    const listings = await Promise.allSettled(
      paths.map((path) => listVaultDirectory({ fs, path })),
    );
    // All at once: a note moved between two open folders is in one of them
    // at every render, never in both and never in neither. A folder that
    // could not be read keeps what it showed, and says why.
    setChildren((current) => {
      const next = new Map(current);
      let moved = false;
      listings.forEach((listing, at) => {
        const path = paths[at];
        if (listing.status !== 'fulfilled' || path === undefined) return;
        // A folder that lists what it did keeps its list, and its rows are not drawn again.
        if (sameReading(current.get(path), listing.value)) return;
        next.set(path, listing.value);
        moved = true;
      });
      return moved ? next : current;
    });
    const failed = listings.find((listing) => listing.status === 'rejected');
    if (failed !== undefined) setError(message(failed.reason));
  }, [fs]);

  const rows = useMemo(
    () => flattenVaultTree({ children, expanded, notePaths }),
    [children, expanded, notePaths],
  );

  return {
    location,
    rows,
    notePaths,
    notesListedFor,
    error,
    chooseVault,
    showVault: adoptVault,
    toggleDirectory,
    expandDirectory,
    forgetDirectory,
    isExpanded,
    reload,
  };
}
