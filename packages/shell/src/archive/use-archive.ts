import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { noteLabelForNotice, type MovableEntry, type VaultPath } from '@dfai/domain';
import {
  archiveNotesWithPara,
  listArchive,
  unarchiveNotesWithPara,
  type ArchiveOutcome,
  type ArchivePorts,
  type Clock,
  type Relocation,
} from '@dfai/application';
import type { ArchiveContents } from '@dfai/ui';
import { batchSettled, useRowSelection } from './use-row-selection.ts';

/**
 * Archiving and unarchiving, as a pane, a row's menu, a view, the palette,
 * the weekly review or the Archive asks for it — a PARA note by its value,
 * where it stands, every other note by moving it (#213). Each settles with what the batch did, or null when it did not
 * start — nothing asked for, or a batch already under way.
 */
export interface ArchiveCommands {
  readonly archive: (paths: readonly VaultPath[]) => Promise<ArchiveOutcome | null>;
  readonly unarchive: (paths: readonly VaultPath[]) => Promise<ArchiveOutcome | null>;
  /** While a batch is under way, so it is not asked for twice. */
  readonly busy: boolean;
}

export interface ArchiveOptions {
  readonly ports: ArchivePorts;
  readonly clock: Pick<Clock, 'today'>;
  readonly notePaths: readonly VaultPath[];
  /** Changes when the index does, so the Archive lists what it now holds. */
  readonly indexKey: string;
  /** Whether the Archive page is showing, which is when its list is read. */
  readonly open: boolean;
  /** Re-reads the tree and the index once notes have moved. */
  readonly onSettled: () => void;
  /** After one note moves: offers to update the links it left behind, as a move does. */
  readonly offerLinks: (
    entry: MovableEntry,
    moved: Relocation,
    before: readonly VaultPath[],
  ) => Promise<void>;
}

/**
 * What the window says once a batch is done: only what could not be done.
 * Notices are for trouble; a note that went is seen going — out of Pages,
 * its page's crumb now the Archive.
 */
function outcomeNotice(outcome: ArchiveOutcome): string | null {
  if (outcome.failed.length === 0) return null;
  return outcome.failed
    .map(({ path, reason }) => `${noteLabelForNotice(path)}: ${reason}`)
    .join(' ');
}

/**
 * Everything that puts notes in the Archive or takes them out: the window's
 * one batch, which every page, menu and the palette archive through.
 *
 * One note is archived the way it is moved — its links offered afterwards —
 * and a batch rewrites them as it goes, since an offer per note would be no
 * offer at all. The rules are the use-cases'; this holds what is on screen.
 * The Archive page's own list is `useArchivePage`'s.
 */
export function useArchive(options: Omit<ArchiveOptions, 'open' | 'indexKey'>) {
  const { ports, clock, notePaths, onSettled, offerLinks } = options;
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  // `busy` reaches callers a render late; two presses in one tick would both
  // see it false. The ref is set before the first batch starts.
  const running = useRef(false);

  const run = useCallback(
    async (
      paths: readonly VaultPath[],
      kind: 'archive' | 'unarchive',
    ): Promise<ArchiveOutcome | null> => {
      if (paths.length === 0 || running.current) return null;
      running.current = true;
      const single = paths.length === 1;
      const batch = { ports, paths, notePaths, updateLinks: !single };
      setBusy(true);
      setNotice(null);
      try {
        const outcome =
          kind === 'archive'
            ? await archiveNotesWithPara({ ...batch, today: clock.today() })
            : await unarchiveNotesWithPara(batch);
        setNotice(outcomeNotice(outcome));
        onSettled();
        const [moved] = outcome.moves;
        if (single && moved !== undefined) {
          // The move is done whatever the offer does: its failure is said,
          // and the outcome still reported, so the row is not chosen again.
          await offerLinks({ path: moved.move.from, kind: 'file' }, moved, notePaths).catch(
            (cause: unknown) => setNotice(cause instanceof Error ? cause.message : String(cause)),
          );
        }
        return outcome;
      } catch (cause) {
        setNotice(cause instanceof Error ? cause.message : String(cause));
        return null;
      } finally {
        running.current = false;
        setBusy(false);
      }
    },
    [ports, clock, notePaths, onSettled, offerLinks],
  );

  const commands = useMemo<ArchiveCommands>(
    () => ({
      archive: (paths) => run(paths, 'archive'),
      unarchive: (paths) => run(paths, 'unarchive'),
      busy,
    }),
    [run, busy],
  );

  return { commands, notice };
}

/**
 * The Archive page's list, its search and its chosen rows: the page's own,
 * read in its tab (tab-model.md, PR B) through the window's commands.
 */
export function useArchivePage({
  ports,
  indexKey,
  open,
  commands,
}: Pick<ArchiveOptions, 'ports' | 'indexKey' | 'open'> & {
  /** What takes notes out of the Archive: the window's one batch. */
  commands: Pick<ArchiveCommands, 'unarchive'>;
}) {
  const page = useArchiveListing({ ports, indexKey, open });
  const { beginBatch } = page.choosing;
  const { unarchive } = commands;
  // The Archive's chosen rows stay chosen until the batch settles, then lose
  // the ones that went back; rows chosen meanwhile stay, and failed ones return.
  const unarchiveChosen = useCallback(
    (paths: readonly VaultPath[]) => {
      const settle = beginBatch();
      void unarchive(paths).then((outcome) => settle(batchSettled(outcome, paths)));
    },
    [unarchive, beginBatch],
  );
  return { ...page, unarchive: unarchiveChosen };
}

/** The Archive's list as the index answers it, for the search typed. */
function useArchiveListing({
  ports,
  indexKey,
  open,
}: Pick<ArchiveOptions, 'ports' | 'indexKey' | 'open'>) {
  const [search, setSearch] = useState('');
  const [contents, setContents] = useState<ArchiveContents | null>(null);
  const [error, setError] = useState<string | null>(null);
  const choosing = useRowSelection(search);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    listArchive({ index: ports.index, search })
      .then((listing) => {
        if (cancelled) return;
        setContents(listing);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [ports.index, search, indexKey, open]);

  return { search, setSearch, contents, error, choosing };
}
