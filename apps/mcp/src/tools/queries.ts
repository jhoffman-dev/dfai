/** Tools that return rows from the index: saved views, structured queries, DFAI queries, SQL. */

import type { ApiQueryBody } from '@dfai/application';
import { z } from 'zod';
import { defineTool, definedOnly } from './define.ts';
import { includeArchived, limit, notePath } from './inputs.ts';

const READ_ONLY = { readOnlyHint: true } as const;

const ROWS =
  'Returns { columns, rows, truncated, sql }; "truncated" is true when more rows matched than ' +
  'came back, because the limit or the row cap cut it short.';

type FilterOperator = NonNullable<ApiQueryBody['filters']>[number]['operator'];

/**
 * The operators, spelled out for the schema. The two checks below make this a
 * type error the moment the contract gains or loses one.
 */
const OPERATORS = [
  'is',
  'isNot',
  'contains',
  'startsWith',
  'greaterThan',
  'lessThan',
  'isEmpty',
  'isNotEmpty',
] as const satisfies readonly FilterOperator[];
type Exhaustive = FilterOperator extends (typeof OPERATORS)[number] ? true : never;
const exhaustive: Exhaustive = true;
void exhaustive;

export const runView = defineTool({
  name: 'atlas_run_view',
  title: 'Run a saved view',
  description:
    `Run a saved view or dashboard by its path from atlas_list_views. A view answers rows: ${ROWS} ` +
    'A view that groups (a table, board or gallery with a groupBy) also answers "groups": ' +
    '[{ label, value, rows, groups }], "rows" being indexes into rows and "groups" its sub-groups ' +
    "(a board's swimlanes); a board lists every column, even empty ones. " +
    'A dashboard answers { widgets }, one result per widget. A view leaves archived notes out ' +
    'unless includeArchived is true.',
  inputSchema: z.object({
    path: z
      .string()
      .min(1)
      .describe("The view or dashboard's path exactly as atlas_list_views returned it."),
    includeArchived: includeArchived.optional(),
  }),
  annotations: READ_ONLY,
  call: (client, { path, includeArchived: archived }) =>
    client.runView(path, archived === undefined ? undefined : { includeArchived: archived }),
});

export const query = defineTool({
  name: 'atlas_query',
  title: 'Query notes of a type',
  description:
    'Find notes of one type by their property values, e.g. open tasks due this week: ' +
    '{ type: "task", filters: [{ key: "status", operator: "isNot", value: "done" }], ' +
    'sorts: [{ key: "due", direction: "asc" }] }. Call atlas_list_types first for real keys and ' +
    `values. "isEmpty" and "isNotEmpty" take no value. Archived notes are left out unless ` +
    `includeArchived is true. For tasks, schedule: true adds a "schedule" column: each task's ` +
    '{ estimate, scheduled, done, overBy } in minutes — scheduled being the time its timeblocks ' +
    `(notes of type block) set aside for it, and overBy how far that runs past its estimate. ${ROWS}`,
  inputSchema: z.object({
    type: z.string().min(1).describe("The type's name, as atlas_list_types gives it."),
    columns: z.array(z.string()).optional().describe('Property keys to return. Omit for all.'),
    filters: z
      .array(
        z.object({
          key: z.string(),
          operator: z.enum(OPERATORS),
          value: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
        }),
      )
      .optional()
      .describe('All must match.'),
    sorts: z.array(z.object({ key: z.string(), direction: z.enum(['asc', 'desc']) })).optional(),
    limit: limit.optional(),
    includeArchived: includeArchived.optional(),
    schedule: z
      .boolean()
      .optional()
      .describe('For a query of tasks: add each task’s schedule. Refused for any other type.'),
  }),
  annotations: READ_ONLY,
  call: (client, { filters, ...rest }) =>
    client.query({
      ...definedOnly(rest),
      ...(filters && { filters: filters.map((filter) => definedOnly(filter)) }),
    }),
});

export const sql = defineTool({
  name: 'atlas_sql',
  title: 'Read-only SQL',
  description:
    "Run one read-only SQL SELECT against DFAI's index (SQLite), for questions atlas_query " +
    'cannot express. Tables: files(path, title, summary, modified, size); ' +
    'props(path, key, idx, value_text, value_num, value_date, value_json), one row per ' +
    'property value, idx ordering a list; links(src, dst, target, kind), dst null when the ' +
    'link points at no note; fts, an FTS5 table (path, title, body) for MATCH. Each type has ' +
    'a view v_<type> with path, title, summary and a column per property, each cell as ' +
    'atlas_query shows it (the type matched in any case, a date its first real day, a single ' +
    'value written as a list as none). Read sqlite_master ' +
    'for the exact definitions. Writes are rejected, and a query that runs too long fails with ' +
    `"query_failed". Use ? placeholders with "params" rather than pasting values into the SQL. ${ROWS}`,
  inputSchema: z.object({
    sql: z.string().min(1).describe('A single SELECT statement.'),
    params: z
      .array(z.union([z.string(), z.number(), z.null()]))
      .optional()
      .describe('Values for the ? placeholders, in order.'),
  }),
  annotations: READ_ONLY,
  call: (client, input) => client.sql(definedOnly(input)),
});

export const runQuery = defineTool({
  name: 'atlas_run_query',
  title: 'Run a DFAI query',
  description:
    "Run a DFAI query, the text the app's query builder writes, across one or more types, e.g. " +
    '"FROM task, project WHERE status != done AND project.owner = [[Julie]] AND tag = #q3 ' +
    'SORT BY due GROUP BY project THEN status". Clauses: FROM type, …; WHERE with AND, OR, NOT, ' +
    'brackets, = != < <= > >=, CONTAINS, STARTS WITH, IS [NOT] EMPTY, LINKS TO this, CONNECTED TO this; SORT BY ' +
    'field [ASC|DESC]; GROUP BY field [THEN field]; SHOW field, …; INCLUDE ARCHIVED; LIMIT n. A ' +
    'field is a property of a listed type (atlas_list_types), one hop through a relation ' +
    "(project.owner), or title, type, tag, modified, path. Values: words, 'quoted text', numbers, " +
    'true/false, [[Note]], #tag, @today, @tomorrow, @weekAgo, @startOfWeek, a count from today ' +
    '(@-30d, @+2w, @+1m, @-1y; up to 1000 years), and this — the note given as "context", e.g. ' +
    'a person\'s meetings in the last 30 days, with their note as context: "FROM meeting WHERE ' +
    'people = this AND date > @-30d AND date <= @today" (date > @-30d alone takes the meetings ' +
    "to come too). this compares with a relation (= or !=); quote it, 'this', to mean the word. " +
    'LINKS TO this lists notes whose body links to it; CONNECTED TO this lists notes joined to ' +
    'it by any link, either way round, in a body or a property (the tasks that came from a ' +
    'meeting, with the meeting as context: FROM task WHERE CONNECTED TO this); after a relation, ' +
    "waiting_on CONNECTED TO this, it asks about the notes that relation points at. A note's fenced ```atlas-query block " +
    'holds such a query after an optional "layout:" line; to answer it as the app shows it, ' +
    'send the query without that line, with the note as context. Archived notes are ' +
    'left out unless the query says INCLUDE ARCHIVED. Returns { columns, rows, truncated, sql }, ' +
    'plus "groups" for GROUP BY: ' +
    '[{ label, value, rows: [indexes into rows], groups: [sub-groups] }]. A mistake in the text is ' +
    '"invalid" with its line and column; fix it there and run again. Read-only; saving a query ' +
    'as a view stays in the app.',
  inputSchema: z.object({
    query: z.string().min(1).describe('The DFAI query text.'),
    limit: limit
      .max(5000)
      .optional()
      .describe(
        "At most this many rows, 1 to 5000; the query's own LIMIT wins when smaller. Default 500.",
      ),
    context: notePath
      .optional()
      .describe(
        'The note the query is about, which "this" in the query names — a path exactly as another ' +
          'tool returned it, e.g. "People/Mara Quill.md". Omit when the query does not say this.',
      ),
  }),
  annotations: READ_ONLY,
  call: (client, input) => client.atlasQuery(definedOnly(input)),
});

export const calendar = defineTool({
  name: 'atlas_calendar',
  title: "A view's calendar",
  description:
    "Read a saved view's notes as its calendar shows them, for a month, a week (from Monday), 3 " +
    'days, a day, or an agenda of any number of days. The view must place notes on a date ' +
    '(atlas_list_views shows its layout; a calendar or timeline view does). Returns { range, days, ' +
    'events: [{ path, title, start, end, allDay, on }], unscheduled, truncated }: "on" lists the ' +
    'days of the range each note is on, and times are wall-clock, as the notes write them.',
  inputSchema: z.object({
    path: z.string().min(1).describe("The view's path exactly as atlas_list_views returned it."),
    range: z
      .enum(['month', 'week', '3day', 'day', 'agenda'])
      .optional()
      .describe('Omit for the range the view was saved with.'),
    anchor: z.string().optional().describe('A day in the range, "YYYY-MM-DD". Omit for today.'),
    days: z
      .number()
      .int()
      .min(1)
      .max(366)
      .optional()
      .describe('For an agenda only: how many days it lists. Default 30.'),
  }),
  annotations: READ_ONLY,
  call: (client, { path, ...body }) => client.calendar(path, definedOnly(body)),
});

export const queryTools = [runView, query, runQuery, sql, calendar];
