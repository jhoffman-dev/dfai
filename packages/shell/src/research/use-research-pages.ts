import { useMemo, useState } from 'react';
import {
  DEFAULT_LIBRARY_SORT,
  filterHighlights,
  libraryShown,
  settleHighlightFilter,
  settleLibraryFilter,
  NO_HIGHLIGHT_FILTER,
  NO_LIBRARY_FILTER,
  type HighlightChoices,
  type HighlightFilter,
  type LibraryChoices,
  type LibraryFilter,
  type LibrarySort,
} from '@dfai/domain';
import type { HighlightsPageProps, LibraryPageProps, ResearchListState } from '@dfai/ui';
import type { ReadState } from '../reads/read-state.ts';
import type { HighlightList, LibraryList } from './use-research-reads.ts';

type EntriesRead<Entry> = ReadState<{ readonly entries: readonly Entry[] }>;

/** A read's entries as a page shows them: the ones `shown` lets through, of how many. */
function listState<Entry>(
  read: EntriesRead<Entry>,
  shown: (entries: readonly Entry[]) => readonly Entry[],
): ResearchListState<Entry> {
  if (read.kind !== 'ready') return read;
  return { kind: 'ready', shown: shown(read.entries), total: read.entries.length };
}

const NO_CHOICES = { kinds: [], tags: [], projects: [] } satisfies LibraryChoices;
const NO_HIGHLIGHT_CHOICES = { sources: [], colors: [], tags: [] } satisfies HighlightChoices;

/**
 * The Library's filter and order, kept by the page while it is open, and
 * the sources they show: the domain's rules over what the index read.
 */
export function useLibraryPage(
  read: ReadState<LibraryList>,
): Pick<LibraryPageProps, 'state' | 'choices' | 'filter' | 'onFilter' | 'sort' | 'onSort'> {
  const [chosen, setFilter] = useState<LibraryFilter>(NO_LIBRARY_FILTER);
  const [sort, setSort] = useState<LibrarySort>(DEFAULT_LIBRARY_SORT);
  const choices = read.kind === 'ready' ? read.choices : NO_CHOICES;
  // What the controls say is what filters: a choice the vault no longer has is
  // dropped, and kept dropped — set while drawing, so it does not come back on
  // when the vault offers the choice again.
  const filter = read.kind === 'ready' ? settleLibraryFilter(chosen, choices) : chosen;
  if (filter !== chosen) setFilter(filter);
  const state = useMemo(
    () => listState(read, (entries) => libraryShown(entries, { filter, sort })),
    [read, filter, sort],
  );
  return { state, choices, filter, onFilter: setFilter, sort, onSort: setSort };
}

/**
 * All highlights' filter, kept by the page while it is open, and the
 * highlights it shows. "When the source changed" counts back from the
 * clock's `now`, read as the filter changes.
 */
export function useHighlightsPage(
  read: ReadState<HighlightList>,
  now: () => number,
): Pick<HighlightsPageProps, 'state' | 'choices' | 'filter' | 'onFilter'> {
  const [{ filter: chosen, at }, setFiltered] = useState<{ filter: HighlightFilter; at: number }>(
    () => ({ filter: NO_HIGHLIGHT_FILTER, at: now() }),
  );
  const choices = read.kind === 'ready' ? read.choices : NO_HIGHLIGHT_CHOICES;
  // Dropped and kept dropped, as the Library's.
  const filter = read.kind === 'ready' ? settleHighlightFilter(chosen, choices) : chosen;
  if (filter !== chosen) setFiltered({ filter, at });
  const state = useMemo(
    () => listState(read, (entries) => filterHighlights(entries, filter, at)),
    [read, filter, at],
  );
  const onFilter = useMemo(
    () => (next: HighlightFilter) => setFiltered({ filter: next, at: now() }),
    [now],
  );
  return { state, choices, filter, onFilter };
}
