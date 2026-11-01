import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  boardGroups,
  drawnLevels,
  filtersByLink,
  calendarEndKey,
  checklistProgressKey,
  groupChoices,
  groupColumnOptions,
  groupResultRows,
  viewGroupKeys,
  layoutChange,
  layoutChoices,
  parseSavedView,
  parseViewDisplay,
  queryForLayout,
  relationTypes,
  repeatKeysOf,
  statusOf,
  toBoardRows,
  type BoardLane,
  type BoardRow,
  type CalendarRange,
  type GroupChoice,
  type LayoutChoice,
  type NoteNames,
  type ObjectType,
  type QueryFilter,
  type QuerySort,
  type RowGroup,
  type StatusProperty,
  type VaultPath,
  type ViewDisplay,
  type ViewEdits,
  type ViewLayout,
  type ViewQuery,
} from '@dfai/domain';
import {
  readCellValue,
  relationGroupLinks,
  runView,
  type IndexPort,
  type MarkdownPort,
  type OpenNote,
  type ReadMoment,
  type VaultFsPort,
  type ViewResult,
  type ActivityLog,
} from '@dfai/application';
import {
  useNoteNames,
  useSteadyCallback,
  type CardAdd,
  type CardMove,
  type CellEdit,
  type DoneTicks,
  type ReadHeldCell,
} from '@dfai/ui';
import type { OpenEditors } from '../panes/open-editors.ts';
import { errorMessage } from './error-message.ts';
import type { TickMemory } from './tick-memory.ts';
import { useCardCreation } from './use-card-creation.ts';
import { useDoneTicks } from './use-done-ticks.ts';
import { useFilterChoices, type FilterChoicesByKey } from './use-filter-choices.ts';
import { useNotePreviews, type NotePreviews } from './use-note-previews.ts';
import { usePendingCards, type BoardShape, type PendingCards } from './use-pending-cards.ts';
import { useRelationChoices, type RelationChoicesByKey } from './use-relation-choices.ts';
import { useChangeProperties, useRowWrites, useWriteProperties } from './use-view-writes.ts';
import type { ViewUndo } from './write-toast.ts';
import { useViewEdits } from './use-view-edits.ts';
import type { ViewDrafts } from './use-view-drafts.ts';

const NO_SORTS: readonly QuerySort[] = [];

/**
 * Runs the open note when that note is a saved view.
 *
 * What is drawn is the view note with the toolbar's unsaved changes laid over
 * it (`useViewEdits`) — its layout among them; editing a row, a card or a date,
 * or ticking a note done, writes that note at once.
 */
export function useSavedView({
  note,
  index,
  fs,
  markdown,
  types,
  notePaths,
  indexKey,
  onChanged,
  editors,
  drafts,
  viewPaths,
  tickMemory,
  activity,
  toasts,
}: {
  note: OpenNote | null;
  index: IndexPort;
  fs: VaultFsPort;
  markdown: MarkdownPort;
  types: readonly ObjectType[];
  notePaths: readonly string[];
  /** Changes when the index does, so the table refreshes after an edit. */
  indexKey: string;
  onChanged: () => void;
  /** The panes, so a note one of them holds is written through it. */
  editors: OpenEditors;
  /** Every view's unsaved toolbar changes. */
  drafts: ViewDrafts;
  /** Every saved view, so a new one's name is checked against them. */
  viewPaths: readonly string[];
  /** What ticked notes' statuses were, so unticking can put them back. */
  tickMemory: TickMemory;
  /** Where an edit the view gives up on is recorded. */
  activity: Pick<ActivityLog, 'inOpenVault'>;
  /**
   * Where a row's change is said with its Undo (#320) — the window's toasts,
   * and the panes the undo must not write under. Nothing is said without.
   */
  toasts?: Omit<ViewUndo, 'fs' | 'onUndone'>;
}): {
  query: ViewQuery | null;
  display: ViewDisplay;
  /** The type the view lists, when the vault defines it. */
  type: ObjectType | null;
  result: ViewResult | null;
  /** The columns the view asked for — the result may carry more, for a done box. */
  fields: readonly string[];
  /** What the result carries only for the layout's sake, which a table leaves out. */
  hidden: readonly string[];
  rows: readonly BoardRow[];
  /** A board's columns — every value, even one no card has yet — and a gallery's groups. */
  columns: readonly RowGroup[];
  /** A board's swimlanes, when the view sub-groups. */
  lanes: readonly BoardLane[];
  /** What a board draws its moved cards with, before the index has them (`useBoardAsPending`, #260). */
  pendingBoard: {
    pending: PendingCards;
    regroup: (rows: readonly BoardRow[]) => BoardShape;
  };
  /** A table's groups and their sub-groups: only the values some row has. */
  groups: readonly RowGroup[];
  /** What the Group control offers, each with why it cannot be chosen when it cannot. */
  groupChoices: readonly GroupChoice[];
  /** What the Filter control's value box offers for each property, once wanted. */
  filterChoices: FilterChoicesByKey;
  /** Asks for a property's filter choices: its value box has opened, or a filter on it is listed. */
  wantFilterChoices: (key: string) => void;
  error: string | null;
  /** A cell committed in the table: settles once written, fails as a refusal or a failed write does. */
  editCell: (edit: CellEdit) => Promise<void>;
  /** The notes each relation column's picker offers, once wanted. */
  relationChoices: RelationChoicesByKey;
  /** Why a relation's notes could not be read, by its key. */
  relationChoiceProblems: Readonly<Record<string, string>>;
  /** Asks for a relation's notes: its cell's picker has opened. */
  wantRelationChoices: (key: string) => void;
  /** What a cell holding several values holds, read from its note once its writes so far have ended. */
  readHeldCell: ReadHeldCell;
  toggleSort: (column: string) => void;
  setFilters: (filters: readonly QueryFilter[]) => void;
  setSorts: (sorts: readonly QuerySort[]) => void;
  setGroupBy: (groupBy: string | null) => void;
  setSubGroupBy: (subGroupBy: string | null) => void;
  toggleColumn: (key: string) => void;
  moveColumn: (key: string, by: -1 | 1) => void;
  /** Whether archived notes are listed too; they are left out unless asked for. */
  includeArchived: boolean;
  setIncludeArchived: (include: boolean) => void;
  /** Whether the view on screen differs from the view note. */
  edited: boolean;
  save: () => void;
  reset: () => void;
  /** Writes the view as shown to a new view note, and says where. */
  saveAs: (name: string) => Promise<VaultPath | null>;
  saveAsError: string | null;
  moveCard: (move: CardMove) => void;
  reschedule: (args: { path: string; start: string; end: string | null }) => void;
  moveBar: (args: { path: string; start: string; end: string }) => void;
  addCard: (add: CardAdd) => void;
  /** Adds a note under a table's group, given its values, and says where. */
  addInGroup: (chain: readonly RowGroup[]) => Promise<VaultPath | null>;
  /** Adds a note on a calendar's day or at its time, named as typed. */
  addOnDate: (args: { value: string; name: string }) => void;
  /** Adds a note of the view's type — in a board's first column — and says where. */
  addNote: () => Promise<VaultPath | null>;
  /** Every layout, and whether this type can be drawn as it. */
  layouts: readonly LayoutChoice[];
  /** Draws the view another way — an unsaved change, like a filter. */
  setLayout: (layout: ViewLayout) => void;
  /** Shows a calendar as a month, a week, 3 days, a day or an agenda — an unsaved change, like a layout. */
  setCalendarRange: (range: CalendarRange) => void;
  /** The done boxes, for a type whose status has a done option. */
  ticks: DoneTicks | undefined;
  /** What a feed and a gallery show of each note beyond its fields. */
  previews: NotePreviews;
} {
  // Held with the view it was turned on in, so the next view opens without it.
  const [archivedIn, setArchivedIn] = useState<string | null>(null);
  const includeArchived = archivedIn !== null && archivedIn === note?.path;
  const setIncludeArchived = useCallback(
    (include: boolean) => setArchivedIn(include ? (note?.path ?? null) : null),
    [note?.path],
  );
  const shownView = useShownView({
    note,
    index,
    indexKey,
    includeArchived,
    drafts,
    viewPaths,
    fs,
    markdown,
    editors,
    onChanged,
    types,
    activity,
  });
  const { result, error, setError, query, display, type, status, hidden, fields } = shownView;
  const { applyEdits, ...viewEdits } = shownView.edits;
  const readRows = useMemo(
    () => (result === null ? [] : toBoardRows({ columns: result.columns, rows: result.rows })),
    [result],
  );
  // Steady: a view handed a new `onChanged` is no reason to draw its rows' writers again (#325).
  const onUndone = useSteadyCallback(onChanged);
  const toastsShow = toasts?.toasts;
  const toastsPanes = toasts?.panes;
  const undo = useMemo(
    () =>
      toastsShow === undefined || toastsPanes === undefined
        ? undefined
        : { toasts: toastsShow, panes: toastsPanes, onUndone },
    [toastsShow, toastsPanes, onUndone],
  );
  const writeProperties = useWriteProperties({ editors, fs, markdown, activity, undo });
  // Every card as it is drawn: one moved, where the move puts it until the index has it (#260).
  const cards = usePendingCards({
    rows: readRows,
    read: shownView.read,
    runsBegun: shownView.runsBegun,
    indexKey,
    scope: [index, note?.path],
    write: writeProperties,
    onChanged,
  });
  const rows = readRows;
  const { columns, lanes, groups, groupOptions, regroup } = useViewShape({
    type,
    display,
    sorts: query?.sorts ?? NO_SORTS,
    rows,
    index,
    indexKey,
  });
  const pendingBoard = useMemo(
    () => ({ pending: cards.pending, regroup }),
    [cards.pending, regroup],
  );
  const choices = useMemo(() => groupChoices(type), [type]);
  const names = useNoteNames();
  const { choices: filterChoices, want: wantFilterChoices } = useFilterChoices({
    type,
    index,
    indexKey,
    names,
  });

  const {
    choices: relationChoices,
    problems: relationChoiceProblems,
    want: wantRelationChoices,
  } = useRelationChoices({
    type,
    index,
    indexKey,
  });

  const { settled } = cards;
  const readHeldCell = useCallback<ReadHeldCell>(
    ({ path, column }) =>
      settled(path).then(() => readCellValue({ fs, markdown, path, key: column })),
    [settled, fs, markdown],
  );

  const changeProperties = useChangeProperties({
    editors,
    fs,
    markdown,
    activity,
    undo,
    onChanged,
    onError: setError,
  });
  const rowWrites = useRowWrites({
    display,
    type,
    groupOptions,
    status,
    changeProperties,
    moveProperties: cards.move,
    shownOf: cards.shownOf,
    refuse: cards.refuse,
  });
  const layouts = useMemo(() => (type === null ? [] : layoutChoices(type)), [type]);
  const setLayout = useLayoutEdit({ display, type, status, applyEdits });
  const setCalendarRange = useCallback(
    (calendarRange: CalendarRange) => applyEdits({ calendarRange }),
    [applyEdits],
  );
  const ticks = useDoneTicks({ status, rows, memory: tickMemory, changeProperties });
  const previews = useNotePreviews({
    fs,
    markdown,
    rows,
    layout: display.layout,
    viewKey: note?.path ?? '',
    indexKey,
    type,
  });
  const creation = useCardCreation({
    fs,
    markdown,
    query,
    type,
    groupBy: display.groupBy,
    subGroupBy: display.subGroupBy,
    dateKey: display.dateKey,
    groupOptions,
    notePaths,
    activity,
    onChanged,
    onError: setError,
  });

  return {
    query,
    display,
    type,
    result,
    includeArchived,
    setIncludeArchived,
    fields,
    hidden,
    rows,
    columns,
    lanes,
    pendingBoard,
    groups,
    groupChoices: choices,
    filterChoices,
    wantFilterChoices,
    relationChoices,
    relationChoiceProblems,
    wantRelationChoices,
    readHeldCell,
    error,
    ...viewEdits,
    ...rowWrites,
    ...creation,
    layouts,
    setLayout,
    setCalendarRange,
    ticks,
    previews,
  };
}

/**
 * Choosing a layout from the toolbar: an unsaved change like a filter, which
 * Save view writes and Reset drops — with the property the layout needs when
 * the view does not name one yet. A layout the type cannot draw changes nothing.
 */
function useLayoutEdit({
  display,
  type,
  status,
  applyEdits,
}: {
  display: ViewDisplay;
  type: ObjectType | null;
  status: StatusProperty | null;
  applyEdits: (edits: ViewEdits) => void;
}) {
  return useCallback(
    (layout: ViewLayout) => {
      if (type === null) return;
      const edits = layoutChange({ layout, display, type, statusKey: status?.key ?? null });
      if (edits !== null) applyEdits(edits);
    },
    [display, type, status, applyEdits],
  );
}

/**
 * The view as it is drawn — the note with the toolbar's unsaved changes over
 * it — and its result. Saving writes the view note through the pane holding it.
 */
function useShownView({
  note,
  index,
  indexKey,
  drafts,
  viewPaths,
  fs,
  markdown,
  editors,
  onChanged,
  types,
  includeArchived,
  activity,
}: {
  note: OpenNote | null;
  index: IndexPort;
  indexKey: string;
  includeArchived: boolean;
  drafts: ViewDrafts;
  viewPaths: readonly string[];
  fs: VaultFsPort;
  markdown: MarkdownPort;
  editors: OpenEditors;
  onChanged: () => void;
  types: readonly ObjectType[];
  activity: Pick<ActivityLog, 'inOpenVault'>;
}) {
  const [saveError, setSaveError] = useState<string | null>(null);
  const changeView = useChangeProperties({
    editors,
    fs,
    markdown,
    activity,
    onChanged,
    onError: setSaveError,
  });
  const edits = useViewEdits({
    note,
    drafts,
    changeProperties: changeView,
    fs,
    markdown,
    viewPaths,
    activity,
    onChanged,
  });
  const query = useMemo(
    () => (note === null ? null : parseSavedView(edits.shown)),
    [note, edits.shown],
  );
  const display = useMemo(() => parseViewDisplay(edits.shown), [edits.shown]);
  const type = useMemo(
    () =>
      query === null ? null : (types.find((candidate) => candidate.name === query.type) ?? null),
    [types, query],
  );
  const status = useMemo(() => statusOf(type), [type]);
  // The query as this layout runs it: with the status a done box reads, and a
  // feed's newest-first order. The saved query — and the Sort control — are unchanged.
  const layoutRun = useMemo(
    () =>
      query === null
        ? null
        : queryForLayout({
            query,
            layout: display.layout,
            statusKey: status?.key ?? null,
            endKey:
              display.dateKey === null
                ? null
                : calendarEndKey({ ...display, dateKey: display.dateKey }),
            groupKeys: viewGroupKeys({
              type,
              groupBy: display.groupBy,
              subGroupBy: display.subGroupBy,
            }),
            progressKey: checklistProgressKey(type),
            repeatKeys: repeatKeysOf(type),
          }),
    [query, display, status, type],
  );
  const run = useViewResult({
    index,
    query: layoutRun?.query ?? null,
    indexKey,
    includeArchived,
  });
  const hidden = useMemo(() => layoutRun?.hidden ?? [], [layoutRun]);
  const fields = useMemo(
    () => (run.result?.columns ?? []).filter((column) => !hidden.includes(column)),
    [run.result, hidden],
  );
  return {
    ...run,
    error: run.error ?? saveError,
    query,
    display,
    type,
    status,
    hidden,
    fields,
    edits,
  };
}

/** The view run against the index, again whenever the index changes. */
function useViewResult({
  index,
  query,
  indexKey,
  includeArchived,
}: {
  index: IndexPort;
  query: ViewQuery | null;
  indexKey: string;
  includeArchived: boolean;
}) {
  const [ran, setRan] = useState<{ result: ViewResult | null; read: ReadMoment }>(NOT_RUN);
  const [error, setError] = useState<string | null>(null);
  const resolveLink = useLinkResolver(query);
  // Counts the runs begun, so a card moved can tell a run made after its write from one under way (#260).
  const begun = useRef(0);
  const runsBegun = useCallback(() => begun.current, []);

  useEffect(() => {
    if (query === null) {
      setRan(NOT_RUN);
      setError(null);
      return;
    }

    let cancelled = false;
    begun.current += 1;
    const read = { at: begun.current, indexKey };
    setError(null);
    runView({ index, query, includeArchived, resolveLink })
      .then((found) => {
        if (!cancelled) setRan({ result: found, read });
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setRan({ result: null, read });
          setError(errorMessage(cause));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [index, query, indexKey, includeArchived, resolveLink]);

  return { result: ran.result, read: ran.read, runsBegun, error, setError };
}

/** Before the view has run: no result, read before anything was written. */
const NOT_RUN = { result: null, read: { at: 0, indexKey: '' } } as const;

/**
 * The note a link opens, for a view filtered by one (`project is [[…]]`) —
 * and only for such a view, so no other view runs again each time the
 * vault's notes are read anew.
 */
function useLinkResolver(query: ViewQuery | null): ((target: string) => string | null) | undefined {
  const names = useNoteNames();
  const byLink = query !== null && filtersByLink(query);
  return useMemo(
    () => (byLink ? (target: string) => names.opens(`[[${target}]]`) : undefined),
    [byLink, names],
  );
}

/**
 * The result as rows, and in its groups: a table's groups and sub-groups, a
 * board's columns and swimlanes — one grouping model, the one a query's
 * GROUP BY … THEN uses, in the order the type declares a select's options.
 */
function useViewShape({
  type,
  display,
  sorts,
  rows,
  index,
  indexKey,
}: {
  type: ObjectType | null;
  display: ViewDisplay;
  sorts: readonly QuerySort[];
  /** The result's rows, as they are drawn. */
  rows: readonly BoardRow[];
  index: IndexPort;
  indexKey: string;
}) {
  const names = useNoteNames();
  const related = useRelatedOptions({ type, display, index, indexKey, names });

  /** The values the grouping property declares, so columns read in workflow order. */
  const groupOptions = useMemo(
    () => groupColumnOptions(type, display.groupBy),
    [type, display.groupBy],
  );

  // The levels the layout draws — a gallery only its first, as its columns —
  // by the rule the API answers and moves cards by.
  const { layout, groupBy, subGroupBy } = display;
  const levels = useMemo(
    () => drawnLevels({ display: { layout, groupBy, subGroupBy }, type, sorts, related }),
    [type, layout, groupBy, subGroupBy, sorts, related],
  );
  const table = display.layout === 'table';
  const regroup = useCallback(
    (shown: readonly BoardRow[]) => boardGroups({ rows: shown, levels, names }),
    [levels, names],
  );
  const board = useMemo(
    () => (table ? { columns: [], lanes: [] } : regroup(rows)),
    [table, rows, regroup],
  );
  const groups = useMemo(
    () => (table ? groupResultRows({ rows, groups: levels, names }) : []),
    [table, rows, levels, names],
  );

  return { columns: board.columns, lanes: board.lanes, groups, groupOptions, regroup };
}

/**
 * For each grouping level that is a relation, every note it can point at —
 * so a board grouped by project has a column (or a lane) for each project.
 */
function useRelatedOptions({
  type,
  display,
  index,
  indexKey,
  names,
}: {
  type: ObjectType | null;
  display: ViewDisplay;
  index: IndexPort;
  indexKey: string;
  names: NoteNames;
}): Readonly<Record<string, readonly string[]>> {
  // The types each level points at, as one key, so the same types read again ask nothing.
  const targetsOf = (key: string | null) => {
    const property = type?.properties.find((candidate) => candidate.key === key);
    return property?.kind === 'relation' ? relationTypes(property).join(',') : '';
  };
  const first = useRelatedNotes({ index, targets: targetsOf(display.groupBy), indexKey, names });
  const second = useRelatedNotes({
    index,
    targets: targetsOf(display.subGroupBy),
    indexKey,
    names,
  });
  return useMemo(() => {
    const related: Record<string, readonly string[]> = {};
    if (display.groupBy !== null) related[display.groupBy] = first;
    if (display.subGroupBy !== null) related[display.subGroupBy] = second;
    return related;
  }, [display.groupBy, display.subGroupBy, first, second]);
}

/**
 * Every note a relation can point at, as the link a card in its column would
 * hold — so a board grouped by project has a column for each project, even
 * one with nothing in it yet.
 */
function useRelatedNotes({
  index,
  targets,
  indexKey,
  names,
}: {
  index: IndexPort;
  /** The types the relation points at, joined by commas; '' for a level that is no relation. */
  targets: string;
  indexKey: string;
  /** Links a note the way it is found, not by the title it may give itself. */
  names: NoteNames;
}): readonly string[] {
  const [links, setLinks] = useState<readonly string[]>([]);

  useEffect(() => {
    if (targets === '') {
      setLinks([]);
      return;
    }
    let cancelled = false;
    relationGroupLinks({ index, targets: targets.split(','), names })
      .then((links) => {
        if (!cancelled) setLinks(links);
      })
      .catch(() => {
        // An index that is not ready yet offers no empty columns; the cards
        // still make theirs.
        if (!cancelled) setLinks([]);
      });
    return () => {
      cancelled = true;
    };
  }, [index, targets, indexKey, names]);

  return links;
}
