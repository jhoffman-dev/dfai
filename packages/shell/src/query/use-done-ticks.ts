import { useMemo } from 'react';
import { isDoneValue, statusToRemember, type BoardRow, type StatusProperty } from '@dfai/domain';
import { doneChange } from '@dfai/application';
import type { DoneTicks } from '@dfai/ui';
import type { TickMemory } from './tick-memory.ts';
import type { ChangeProperties } from './use-view-writes.ts';

/**
 * The done boxes a view's layouts draw, for a type whose status has a done
 * option; undefined for one that has none.
 *
 * A tick is written like a board drag — through the pane holding the note
 * when one does, straight to the file otherwise — and remembers what the
 * status was, so unticking can put it back.
 */
export function useDoneTicks({
  status,
  rows,
  memory,
  changeProperties,
}: {
  status: StatusProperty | null;
  rows: readonly BoardRow[];
  memory: TickMemory;
  changeProperties: ChangeProperties;
}): DoneTicks | undefined {
  return useMemo(() => {
    if (status === null) return undefined;
    const statusOfNote = (path: string) =>
      rows.find((row) => row.path === path)?.values[status.key];

    return {
      isDone: (values) => isDoneValue(status, values[status.key]),
      onToggle: ({ path, done }) => {
        const kept = done ? statusToRemember({ status, value: statusOfNote(path) }) : null;
        if (kept !== null) memory.remember({ path, value: kept });
        const previous = done ? null : memory.recall(path);
        changeProperties({ path, values: doneChange({ status, done, previous }) });
      },
    };
  }, [status, rows, memory, changeProperties]);
}
