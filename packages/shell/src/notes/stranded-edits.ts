import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  isStrandedEditExpired,
  noteLabelForNotice,
  redateStrandedEdit,
  type StrandedEdit,
  type VaultPath,
} from '@dfai/domain';
import { UnstoredWork } from './unstored-work.ts';

/**
 * Where kept work waits between runs of the app, one vault at a time: paths are
 * relative to a vault, and `notes.md` in one is not `notes.md` in another.
 */
export interface KeptWorkStore<Kept> {
  /** Everything kept for this vault. Nothing kept, or nothing readable, is none. */
  read: (vaultKey: string) => readonly Kept[];
  /**
   * Keeps one note's work, replacing what was kept for it before. `false` when
   * it could not be stored, and so lasts only as long as the app is running.
   */
  put: (args: { vaultKey: string; edit: Kept }) => boolean;
  remove: (args: { vaultKey: string; path: VaultPath }) => void;
}

export type StrandedEditStore = KeptWorkStore<StrandedEdit>;

/**
 * What a closing pane hands over: the work, before it is dated, and the vault it
 * was typed in. That vault is named by the pane rather than taken to be the one
 * open now, because a pane closed by a vault switch hands its work over after
 * the switch (R14-01).
 */
export type Stranding = Omit<StrandedEdit, 'keptAt'> & { readonly vault: string };

export interface StrandedEdits {
  /** Keeps what a pane could not save, so opening the note again gets it back. */
  readonly keep: (stranding: Stranding) => void;
  /**
   * Hands back what was kept for a note in the open vault, to one pane: it is
   * not waiting any more, and no other pane is given it. It stays kept until
   * `settle` — handed back is not written, and a quit or a crash before the
   * pane writes it, or before someone answers "Overwrite or Discard?", must not
   * lose it (R14-05).
   */
  readonly take: (path: VaultPath) => StrandedEdit | null;
  /**
   * Lets go of work that was handed back, once it has been written or thrown
   * away. Named by vault, because a pane can settle after a switch.
   */
  readonly settle: (args: { vault: string; path: VaultPath }) => void;
  /** Throws away what was kept for a note, for work nobody is coming back for. */
  readonly forget: (path: VaultPath) => void;
  /** The notes with work waiting, in the order it was kept. */
  readonly waiting: readonly VaultPath[];
  /** What to tell whoever is watching, while work is waiting to be recovered. */
  readonly notice: string | null;
}

const namesOf = (edits: readonly StrandedEdit[]): string =>
  edits.map((edit) => noteLabelForNotice(edit.path)).join(', ');

/** A vault as a person knows it: its folder's name, not the whole path. */
const vaultName = (vaultKey: string): string =>
  vaultKey
    .split(/[\\/]/)
    .filter((part) => part !== '')
    .pop() ?? vaultKey;

function describeHere(kept: readonly StrandedEdit[], unstored: readonly StrandedEdit[]) {
  const first = kept[0];
  if (first === undefined) return null;
  const said = `Unsaved changes to ${namesOf(kept)} could not be saved: ${first.reason}. Open the note again to get them back.`;
  const volatile = kept.filter((edit) => unstored.some((held) => held.path === edit.path));
  return volatile.length === 0
    ? said
    : `${said} Changes to ${namesOf(volatile)} could not be stored either, so they will be lost if DFAI quits first.`;
}

/**
 * Work held only in memory for vaults that are not open. It is not offered
 * here — its paths name another vault's notes — but nothing else says it
 * exists, and it is gone if DFAI quits.
 */
const describeElsewhere = (held: readonly (readonly [string, readonly StrandedEdit[]])[]) =>
  held.map(
    ([vault, edits]) =>
      `Unsaved changes to ${namesOf(edits)} in ${vaultName(vault)} could not be saved or stored. Open ${vaultName(vault)} again before DFAI quits to get them back.`,
  );

function describe({
  kept,
  unstored,
  vaultKey,
}: {
  kept: readonly StrandedEdit[];
  unstored: UnstoredWork;
  vaultKey: string | null;
}): string | null {
  const said = [
    describeHere(kept, unstored.in(vaultKey)),
    ...describeElsewhere(unstored.elsewhere(vaultKey)),
  ].filter((part) => part !== null);
  return said.length === 0 ? null : said.join(' ');
}

interface Shown {
  readonly waiting: readonly VaultPath[];
  readonly notice: string | null;
}

/**
 * The edits no pane is holding any more.
 *
 * A pane that is closed, or moved to another note, writes what is unsaved on
 * the way out — and that write can be refused, because the file moved on while
 * the pane held it. The work has to go somewhere: dropping it is data loss, and
 * saying so without keeping it is data loss that apologises. It is kept until
 * the note is opened again and the work is written or thrown away there — in
 * the store, so that can come after a quit — or until it expires.
 */
export function useStrandedEdits({
  store,
  vaultKey,
  now,
}: {
  store: StrandedEditStore;
  vaultKey: string | null;
  now: () => number;
}): StrandedEdits {
  const kept = useRef(new Map<VaultPath, StrandedEdit>());
  /** Kept here but not in the store, because the store refused it. */
  const unstored = useRef(new UnstoredWork());
  /** The vault `kept` is for, read by `refresh` without depending on it. */
  const openVault = useRef(vaultKey);
  /** Read when needed, so a clock passed inline does not reload the store every render. */
  const clock = useRef(now);
  clock.current = now;
  const [shown, setShown] = useState<Shown>({ waiting: [], notice: null });

  const refresh = useCallback(() => {
    const edits = [...kept.current.values()];
    setShown({
      waiting: edits.map((edit) => edit.path),
      notice: describe({ kept: edits, unstored: unstored.current, vaultKey: openVault.current }),
    });
  }, []);

  useEffect(() => {
    openVault.current = vaultKey;
    kept.current = new Map();
    if (vaultKey !== null) {
      const at = clock.current();
      const found = [...store.read(vaultKey), ...unstored.current.in(vaultKey)];
      for (const read of found.sort((a, b) => a.keptAt - b.keptAt)) {
        const edit = redateStrandedEdit({ edit: read, now: at });
        if (isStrandedEditExpired({ edit, now: at })) {
          store.remove({ vaultKey, path: edit.path });
          unstored.current.release({ vault: vaultKey, path: edit.path });
          continue;
        }
        kept.current.delete(edit.path);
        kept.current.set(edit.path, edit);
        // Stored redated, or the next start would find it in the future again.
        if (edit !== read)
          unstored.current.record({ vault: vaultKey, edit, stored: store.put({ vaultKey, edit }) });
      }
    }
    refresh();
  }, [store, vaultKey, refresh]);

  const keep = useCallback(
    ({ vault, ...work }: Stranding) => {
      const edit: StrandedEdit = { ...work, keptAt: clock.current() };
      unstored.current.record({ vault, edit, stored: store.put({ vaultKey: vault, edit }) });
      // Work from a vault that is no longer open is filed under that vault, and
      // offered when it is opened again. Shown here, it would be offered to this
      // vault's note of the same name — but if the store refused it, the notice
      // still has to say it exists. Judged against the vault open now, not the
      // one this closure was made under: a pane closed by the switch hands its
      // work over through the `keep` it was given before it, after it.
      if (vault === openVault.current) {
        // Deleted first so a note stranded again moves to the end, where the
        // order of `waiting` says it belongs.
        kept.current.delete(edit.path);
        kept.current.set(edit.path, edit);
      }
      refresh();
    },
    [store, refresh],
  );

  const take = useCallback(
    (path: VaultPath) => {
      const edit = kept.current.get(path);
      if (edit === undefined) return null;
      kept.current.delete(path);
      refresh();
      return edit;
    },
    [refresh],
  );

  const settle = useCallback(
    ({ vault, path }: { vault: string; path: VaultPath }) => {
      store.remove({ vaultKey: vault, path });
      unstored.current.release({ vault, path });
      if (vault === openVault.current) kept.current.delete(path);
      refresh();
    },
    [store, refresh],
  );

  const forget = useCallback(
    (path: VaultPath) => {
      if (vaultKey !== null) settle({ vault: vaultKey, path });
    },
    [settle, vaultKey],
  );

  // One object while nothing in it changed: every pane is handed it (#325).
  return useMemo(
    () => ({ keep, take, settle, forget, waiting: shown.waiting, notice: shown.notice }),
    [keep, take, settle, forget, shown],
  );
}
