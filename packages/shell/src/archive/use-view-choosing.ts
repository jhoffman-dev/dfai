import { useEffect, useMemo, useState } from 'react';
import { archiveRefusal, isArchivedPath, type VaultPath } from '@dfai/domain';
import type { ArchiveOutcome } from '@dfai/application';
import type { BulkAction, RowSelection } from '@dfai/ui';
import type { ExportCommands } from '../export/export-flow.ts';
import type { ArchiveCommands } from './use-archive.ts';
import { usePeopleChoice, type ChosenPeopleMerge } from '../people/use-chosen-people.ts';
import { batchSettled, useRowSelection } from './use-row-selection.ts';

/** A view's select mode: whether rows can be chosen, which are, and what can be done to them. */
export interface ViewChoosing {
  readonly on: boolean;
  readonly setOn: (on: boolean) => void;
  readonly selection: RowSelection;
  readonly actions: readonly BulkAction[];
  readonly count: number;
  readonly clear: () => void;
}

const notes = (n: number) => (n === 1 ? 'note' : `${n} notes`);

/**
 * Choosing a view's rows to archive or unarchive them together (P23-03).
 * Leaving select mode, or the view, lets go of the choice.
 */
export function useViewChoosing({
  viewKey,
  commands,
  tab = '',
  people = null,
  present = null,
  exporting = null,
}: {
  viewKey: string;
  commands: ArchiveCommands;
  /** The tab the view is in: its choice is the one ⌘K merges while it is focused. */
  tab?: string;
  /** Given for a view of people: its chosen rows can be merged into another person. */
  people?: ChosenPeopleMerge | null;
  /** The rows the view shows now: a chosen row no longer among them is let go of. */
  present?: readonly string[] | null;
  /** Given where notes can be exported (#501): the chosen rows can be, together. */
  exporting?: ExportCommands | null;
}): ViewChoosing {
  const [on, setOn] = useState(false);
  const { selection, chosen, clear, afterBatch, beginBatch } = useRowSelection(
    `${viewKey}:${String(on)}`,
  );

  useEffect(() => setOn(false), [viewKey]);
  const merging = usePeopleChoice({ tab, merge: people, chosen, present, afterBatch, beginBatch });

  const actions = useMemo(() => {
    const paths = chosen as VaultPath[];
    const archived = paths.filter(isArchivedPath);
    const archivable = paths.filter((path) => archiveRefusal(path) === null);
    // The choice stays until the batch is done, then loses what went; rows
    // chosen meanwhile stay, and what could not go is chosen again.
    const run =
      (
        given: readonly VaultPath[],
        work: (given: readonly VaultPath[]) => Promise<ArchiveOutcome | null>,
      ) =>
      () => {
        const settle = beginBatch();
        void work(given)
          .catch((cause: unknown) => {
            // The commands say their own failures; one that throws instead is
            // logged, and settles as a batch that did not start.
            console.error('A batch could not be run:', cause);
            return null;
          })
          .then((outcome) => settle(batchSettled(outcome, given)));
      };
    const offered: BulkAction[] = [...merging];
    if (exporting !== null && paths.length > 0) {
      offered.push({
        label: `Export ${notes(paths.length)}…`,
        onRun: () => exporting.ask(paths, beginBatch()),
      });
    }
    if (archivable.length > 0) {
      offered.push({
        label: `Archive ${notes(archivable.length)}`,
        onRun: run(archivable, commands.archive),
        disabled: commands.busy,
      });
    }
    if (archived.length > 0) {
      offered.push({
        label: `Unarchive ${notes(archived.length)}`,
        onRun: run(archived, commands.unarchive),
        disabled: commands.busy,
      });
    }
    return offered;
  }, [chosen, commands, beginBatch, merging, exporting]);

  return { on, setOn, selection, actions, count: chosen.length, clear };
}
