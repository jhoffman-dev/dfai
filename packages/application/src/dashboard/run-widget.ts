import {
  compileViewQuery,
  formatAggregate,
  groupResultRows,
  resultFields,
  highlightedKey,
  toBoardRows,
  isCountedKind,
  sortByKey,
  splitUnset,
  sqlGroups,
  sqlNumber,
  GROUP_COUNT_COLUMN,
  GROUP_LABEL_COLUMN,
  noteNames,
  type GroupCount,
  type NoteNames,
  type ObjectType,
  type QueryShape,
  type RowGroup,
  type SqlWidgetSpec,
  type ViewQuery,
  type Widget,
} from '@dfai/domain';
import { messageWithoutPaths } from '../api/api-error.ts';
import type { IndexPort } from '../index/ports.ts';
import { runAtlasQuery } from '../query/run-atlas-query.ts';
import { runSql } from '../query/run-sql.ts';
import {
  barsFor,
  barsInOrder,
  donutFor,
  optionsFor,
  rankFor,
  type BarsData,
  type RankData,
} from './shape-groups.ts';

/** One row of a list or table widget, keyed by column name. */
export interface WidgetRow {
  readonly path: string;
  readonly title: string;
  readonly values: Readonly<Record<string, unknown>>;
}

/**
 * The navy card at the top of a dashboard: a count, the part of it that is
 * done, and how it is spread across a grouping.
 */
export interface HeroData {
  readonly shape: 'hero';
  readonly total: number;
  /** The progress part — "166 done". Null when the widget declares no progress. */
  readonly part: { readonly label: string; readonly count: number } | null;
  /** The sparkline, in key order, without the notes that have no value. */
  readonly groups: readonly GroupCount[];
  /** The group the footer calls out — the current phase. */
  readonly highlight: GroupCount | null;
}

export type WidgetData =
  | { readonly shape: 'number'; readonly value: string }
  | {
      readonly shape: 'rows';
      readonly columns: readonly string[];
      readonly rows: readonly WidgetRow[];
    }
  | BarsData
  | RankData
  | HeroData
  | QueryWidgetData
  /** The widget asked something the index could not answer. */
  | { readonly shape: 'error'; readonly message: string };

/** A DFAI query's rows, in their groups and sub-groups when it has any (ADR-0019). */
export interface QueryWidgetData {
  readonly shape: 'grouped';
  /** The columns after the name, each with its heading. */
  readonly fields: readonly { readonly key: string; readonly label: string }[];
  readonly rows: readonly WidgetRow[];
  /** Empty when the query does not group. */
  readonly groups: readonly RowGroup[];
}

export interface WidgetResult {
  readonly widget: Widget;
  /** The SQL that ran, so it can be read and taken elsewhere. */
  readonly sql: string | null;
  readonly data: WidgetData;
}

interface WidgetRun {
  readonly index: IndexPort;
  readonly widget: Widget;
  /** The vault's types, so a donut can list the options nothing has yet. */
  readonly types?: readonly ObjectType[];
  /** Every note, so a link in a `query` widget names the note it means. */
  readonly notePaths?: readonly string[];
  /** How a linked note reads, so a `query` widget's groups are named as a view names them. */
  readonly names?: NoteNames;
}

type QueryResult = { columns: readonly string[]; rows: readonly (readonly unknown[])[] };

/**
 * Runs one widget.
 *
 * Failure is a result rather than a rejection: a dashboard is many questions at
 * once, and one of them being unanswerable — a type that no longer exists, a
 * property renamed — should cost that tile and nothing else.
 */
export async function runWidget({
  index,
  widget,
  types = [],
  notePaths = [],
  names = noteNames(null),
}: WidgetRun): Promise<WidgetResult> {
  let sql: string | null = widget.sql?.statement ?? null;

  try {
    if (widget.atlasQuery !== null) {
      const answer = await runAtlasQuery({ index, text: widget.atlasQuery, types, notePaths });
      return { widget, sql: answer.result.sql, data: readAtlasQuery(answer, names) };
    }
    if (widget.sql !== null) {
      const result = await runSql({ index, sql: widget.sql.statement });
      return { widget, sql, data: readSql(widget.sql, result) };
    }
    const query = queryOf(widget);
    const compiled = compileViewQuery(query, shapeOf(widget));
    sql = compiled.sql;

    if (widget.kind === 'hero') return { widget, sql, data: await runHero(index, widget, query) };

    const result = await index.query(compiled.sql, compiled.parameters);
    return { widget, sql, data: read(widget, result, types) };
  } catch (error) {
    // Drawn on a dashboard and answered through the API: the index's words, never where it sits.
    return { widget, sql, data: { shape: 'error', message: messageWithoutPaths(error) } };
  }
}

/** Every widget of a dashboard, run together and reported together. */
export async function runDashboard({
  widgets,
  ...run
}: Omit<WidgetRun, 'widget'> & { widgets: readonly Widget[] }): Promise<WidgetResult[]> {
  return Promise.all(widgets.map((widget) => runWidget({ ...run, widget })));
}

/** A query's rows as a table's, grouped the way a query view groups them. */
function readAtlasQuery(
  { compiled, result }: Awaited<ReturnType<typeof runAtlasQuery>>,
  names: NoteNames,
): QueryWidgetData {
  const rows = toBoardRows(result);
  return {
    shape: 'grouped',
    fields: resultFields(compiled),
    rows,
    groups: groupResultRows({ rows, groups: compiled.groups, names }),
  };
}

const COUNT: QueryShape = { aggregate: { kind: 'count', column: null } };

function shapeOf(widget: Widget): QueryShape {
  if (widget.kind === 'number' && widget.aggregate !== null) {
    return { aggregate: widget.aggregate };
  }
  if (widget.kind === 'hero') return COUNT;
  if (isCountedKind(widget.kind) && widget.groupBy !== null) return { groupBy: widget.groupBy };
  return {};
}

/**
 * A hero asks up to three questions of the same query: how many, how many of
 * those are the progress part, and how many per group. They run together.
 */
async function runHero(index: IndexPort, widget: Widget, query: ViewQuery): Promise<HeroData> {
  const ask = async (asked: ViewQuery, shape: QueryShape): Promise<QueryResult> => {
    const compiled = compileViewQuery(asked, shape);
    return index.query(compiled.sql, compiled.parameters);
  };
  const { progress, groupBy } = widget;

  const [total, part, grouped] = await Promise.all([
    ask(query, COUNT),
    progress === null
      ? null
      : ask({ ...query, filters: [...query.filters, ...progress.filters] }, COUNT),
    groupBy === null ? null : ask(query, { groupBy }),
  ]);

  const groups = grouped === null ? [] : sortByKey(splitUnset(readGroups(grouped)).groups);
  const highlight = highlightedKey(groups, widget.highlight);
  return {
    shape: 'hero',
    total: countIn(total),
    part:
      progress === null || part === null ? null : { label: progress.label, count: countIn(part) },
    groups,
    highlight: groups.find((group) => group.label === highlight) ?? null,
  };
}

/** Every kind but `sql` asks of a type; the parser never makes one without a query. */
function queryOf(widget: Widget): ViewQuery {
  if (widget.query === null) throw new Error('This widget has no query to run.');
  return widget.query;
}

/** A statement's answer, read by position as `show` asks. */
function readSql(spec: SqlWidgetSpec, result: QueryResult): WidgetData {
  if (spec.show === 'number') return { shape: 'number', value: sqlNumber(result) };
  if (spec.show === 'bar') return barsInOrder(sqlGroups(result));
  return {
    shape: 'rows',
    columns: result.columns,
    rows: result.rows.map((row) => toRow(result.columns, row)),
  };
}

function countIn(result: QueryResult): number {
  const value = Number(result.rows[0]?.[0] ?? 0);
  return Number.isFinite(value) ? value : 0;
}

function read(widget: Widget, result: QueryResult, types: readonly ObjectType[]): WidgetData {
  if (widget.kind === 'number') {
    const kind = widget.aggregate?.kind ?? 'count';
    // An aggregate over no rows still returns one row; a missing one means the
    // view itself is empty, which reads as nothing rather than as zero.
    return { shape: 'number', value: formatAggregate(kind, result.rows[0]?.[0] ?? null) };
  }

  if (isCountedKind(widget.kind)) {
    const groups = readGroups(result);
    if (widget.kind === 'donut') return donutFor(groups, optionsFor(widget, types));
    if (widget.kind === 'rank') return rankFor(widget, groups);
    return barsFor(widget, groups);
  }

  return {
    shape: 'rows',
    columns: result.columns,
    rows: result.rows.map((row) => toRow(result.columns, row)),
  };
}

function readGroups(result: QueryResult): GroupCount[] {
  const label = result.columns.indexOf(GROUP_LABEL_COLUMN);
  const count = result.columns.indexOf(GROUP_COUNT_COLUMN);
  if (label < 0 || count < 0) throw new Error('the chart query returned no groups');

  return result.rows.map((row) => ({
    label: String(row[label] ?? ''),
    count: Number(row[count] ?? 0),
  }));
}

function toRow(columns: readonly string[], row: readonly unknown[]): WidgetRow {
  const values: Record<string, unknown> = {};
  columns.forEach((column, index) => {
    values[column] = row[index];
  });

  return {
    path: String(values['path'] ?? ''),
    title: String(values['title'] ?? ''),
    values,
  };
}
