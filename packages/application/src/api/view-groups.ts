import {
  boardGroups,
  drawnLevels,
  drawsGroups,
  groupResultRows,
  noteNames,
  queryForLayout,
  relationTypes,
  toBoardRows,
  viewGroupKeys,
  type GroupedBy,
  type NoteNames,
  type ObjectType,
  type RowGroup,
  type ViewDisplay,
  type ViewQuery,
  withChecklistProgress,
} from '@dfai/domain';
import { readNamedNotes } from '../graph/load-graph.ts';
import { relationGroupLinks } from '../query/relation-group-links.ts';
import { loadObjectTypes } from '../types/load-types.ts';
import { toApiGroup } from './atlas-query-answer.ts';
import type { ApiAtlasQueryRows, ApiRows } from './contract.ts';
import { runViewQuery } from './query.ts';
import type { VaultRequest } from './vault-request.ts';

/*
 * A saved view's groups and sub-groups (`groupBy`, `subGroupBy`), answered
 * as the app draws them — the same levels, the same order, a relation's
 * groups named for the note — so a caller reads a grouped table or a board
 * with swimlanes the way James sees it.
 */

/** The type a saved view lists, as the vault declares it; null when it declares none. */
export async function viewTypeOf(request: VaultRequest, name: string): Promise<ObjectType | null> {
  const types = await loadObjectTypes({ fs: request.fs, markdown: request.markdown });
  return types.find((type) => type.name === name) ?? null;
}

/**
 * A saved view's rows, and — when its layout draws groups — those groups.
 * The rows then carry what they are grouped by even when the view does not
 * show it as a column; those columns are read, then left out of the answer,
 * so `columns` is the view's own either way — and each note's checklist
 * progress, where its type has one (P30-03). A board keeps a group for every
 * value its first level declares, an empty column included.
 */
export async function runSavedView(
  request: VaultRequest,
  {
    query: asSaved,
    display,
    includeArchived,
  }: { query: ViewQuery; display: ViewDisplay; includeArchived: boolean },
): Promise<ApiAtlasQueryRows> {
  const type = await viewTypeOf(request, asSaved.type);
  const query = withChecklistProgress(asSaved, type);
  if (!drawsGroups(display.layout) || display.groupBy === null) {
    return runViewQuery(request, query, { includeArchived, type });
  }
  const { names, related } = await relationGroups(request, { display, type });
  const levels = drawnLevels({ display, type, sorts: query.sorts, related });
  if (levels.length === 0) return runViewQuery(request, query, { includeArchived, type });

  const run = groupedRun({ query, display, type });
  const answer = await runViewQuery(request, run.query, { includeArchived, type });
  const rows = toBoardRows(answer);
  const places = new Map(rows.map((row, place) => [row, place]));
  const groups = groupResultRows({
    rows,
    groups: levels,
    names,
    keepEmpty: display.layout === 'board',
  }).map((group) => toApiGroup(group, places));
  return { ...withoutColumns(answer, run.hidden), groups };
}

/**
 * A board's columns and lanes as the app draws them — every declared option,
 * every note a relation can point at, every value a card has — which are the
 * groups a card on it can be moved to. Empty for a view that draws none.
 */
export async function boardGroupsOf(
  request: VaultRequest,
  { query, display, type }: { query: ViewQuery; display: ViewDisplay; type: ObjectType | null },
): Promise<{ levels: GroupedBy[]; columns: readonly RowGroup[]; lanes: readonly RowGroup[] }> {
  const { names, related } = await relationGroups(request, { display, type });
  const levels = drawnLevels({ display, type, sorts: query.sorts, related });
  if (levels.length === 0) return { levels, columns: [], lanes: [] };
  const answer = await runViewQuery(request, groupedRun({ query, display, type }).query, {
    includeArchived: false,
    type,
  });
  const board = boardGroups({ rows: toBoardRows(answer), levels, names });
  return { levels, columns: board.columns, lanes: board.lanes.map((lane) => lane.group) };
}

/** The view's query as its layout runs it, reading what it groups by. */
function groupedRun({
  query,
  display,
  type,
}: {
  query: ViewQuery;
  display: ViewDisplay;
  type: ObjectType | null;
}) {
  return queryForLayout({
    query,
    layout: display.layout,
    statusKey: null,
    groupKeys: viewGroupKeys({ type, groupBy: display.groupBy, subGroupBy: display.subGroupBy }),
  });
}

/**
 * The names relation groups are called by, and for each grouping level that
 * is a relation, every note it can point at. Only read when a level is one.
 */
async function relationGroups(
  request: VaultRequest,
  { display, type }: { display: ViewDisplay; type: ObjectType | null },
): Promise<{ names: NoteNames; related: Record<string, readonly string[]> }> {
  const targets = [display.groupBy, display.subGroupBy].flatMap((key) => {
    const property = type?.properties.find((candidate) => candidate.key === key);
    return property?.kind === 'relation' && property.target !== null
      ? [{ key: property.key, targets: relationTypes(property) }]
      : [];
  });
  if (targets.length === 0) return { names: noteNames(null), related: {} };
  const names = noteNames(await readNamedNotes({ index: request.index }));
  const related: Record<string, readonly string[]> = {};
  for (const { key, targets: pointedAt } of targets) {
    related[key] = await relationGroupLinks({ index: request.index, targets: pointedAt, names });
  }
  return { names, related };
}

/** The answer without the columns read only to group by. */
function withoutColumns(answer: ApiRows, hidden: readonly string[]): ApiRows {
  if (hidden.length === 0) return answer;
  const kept = answer.columns.flatMap((column, at) => (hidden.includes(column) ? [] : [at]));
  return {
    ...answer,
    columns: kept.map((at) => answer.columns[at] ?? ''),
    rows: answer.rows.map((row) => kept.map((at) => row[at])),
  };
}
