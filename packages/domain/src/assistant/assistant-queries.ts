import { foldedTypeName, foldedTypeSql } from '../types/note-type-sql.ts';
import { outsideArchiveSql } from '../archive/archive.ts';
import { TASK_KEYS } from '../gtd/gtd-status.ts';
import { tagKey } from '../tags/tag-name.ts';
import { FOLLOW_UP_TAG } from '../automations/meeting-items.ts';
import type { CompiledQuery } from '../query/view-query.ts';
import type { BlockRef } from './citation.ts';
import { userSpaceNoteSql } from '../vault/vault-visibility.ts';

/*
 * The two things the assistant's tools ask the index that a linked page does
 * not: where each item says it came from (its `source`), and the follow-ups
 * made from a page's meetings. Each is one bounded statement over the
 * index's own tables, however many items or meetings it is asked about.
 */

/** What the statements here start with, so a log or a stand-in index can tell them apart. */
export const ASSISTANT_QUERY_MARK = '/* assistant */';

/** The most notes one statement names: far inside SQLite's limit on bound values. */
export const ASSISTANT_PATHS_PER_QUERY = 1000;

/** The most follow-ups an answer lists. */
export const FOLLOW_UP_LIMIT = 100;

const placeholders = (count: number): string => Array.from({ length: count }, () => '?').join(', ');

/** The paths a statement is asked about: each once, at most {@link ASSISTANT_PATHS_PER_QUERY}. */
function boundedPaths(paths: readonly string[]): string[] {
  return [...new Set(paths)].slice(0, ASSISTANT_PATHS_PER_QUERY);
}

/**
 * A note's first value for a key, as text — a date's as written when the
 * index read it as one. The key is bound, not written into the statement.
 */
const valueOf = (column: string): string =>
  `(SELECT COALESCE(p.value_date, p.value_text) FROM props AS p WHERE p.path = ${column} AND p.key = ? ORDER BY p.idx LIMIT 1)`;

/** The `source` each of these notes holds, as written: `[[Kickoff#^t0003]]`. Null with no paths. */
export function compileSourcesQuery(paths: readonly string[]): CompiledQuery | null {
  const asked = boundedPaths(paths);
  if (asked.length === 0) return null;
  return {
    sql: [
      `${ASSISTANT_QUERY_MARK} SELECT p.path AS "path", p.value_text AS "source" FROM props AS p`,
      `WHERE p.key = '${TASK_KEYS.source}' AND p.idx = 0 AND p.path IN (${placeholders(asked.length)})`,
    ].join('\n'),
    parameters: asked,
  };
}

/** Each note's `source`, by path, from the rows of {@link compileSourcesQuery}. */
export function sourcesOf(rows: readonly (readonly unknown[])[]): ReadonlyMap<string, string> {
  const sources = new Map<string, string>();
  for (const [path, source] of rows) {
    if (typeof path === 'string' && typeof source === 'string') sources.set(path, source);
  }
  return sources;
}

/** The blocks, among those asked about, the index holds: one statement however many. Null with none asked. */
export function compileBlocksQuery(blocks: readonly BlockRef[]): CompiledQuery | null {
  const asked = [
    ...new Map(blocks.map((block) => [`${block.path}\0${block.id}`, block])).values(),
  ].slice(0, ASSISTANT_PATHS_PER_QUERY);
  if (asked.length === 0) return null;
  return {
    sql: [
      `${ASSISTANT_QUERY_MARK} SELECT b.path AS "path", b.id AS "id" FROM blocks AS b`,
      `WHERE (b.path, b.id) IN (VALUES ${asked.map(() => '(?, ?)').join(', ')})`,
    ].join('\n'),
    parameters: asked.flatMap((block) => [block.path, block.id]),
  };
}

/** The blocks of the rows of {@link compileBlocksQuery}, as a set a block is looked up in. */
export function blocksHeld(rows: readonly (readonly unknown[])[]): (block: BlockRef) => boolean {
  const held = new Set(rows.map(([path, id]) => `${String(path)}\0${String(id)}`));
  return (block) => held.has(`${block.path}\0${block.id}`);
}

/** The columns of {@link compileFollowUpsQuery}, in order. */
export const FOLLOW_UP_COLUMNS = [
  'path',
  'title',
  'status',
  'due',
  'source',
  'waitingOn',
  'modified',
  'direct',
  'meeting',
  'meetingTitle',
] as const;

/**
 * The open tasks tagged `#follow-up` (P29-05) linked either way — by a
 * property or a link in a body — with `entity` or one of its `meetings`. A
 * follow-up made from a meeting is joined to it by the meeting's `tasks` and
 * cites a turn of it in `source`, so it is found from the meeting though it
 * never names the person.
 *
 * A meeting is shared: the same follow-up is reached from every attendee. One
 * reached only through a meeting is therefore kept when it names no Person
 * (the owner's to chase, whoever is asked about) and dropped when it names a
 * Person other than `entity` (it is that person's, not this one's). One that
 * names `entity` itself is kept either way. `direct` says which it was, and
 * `meeting` the first meeting that reached it otherwise.
 *
 * Archived and hidden notes are left out, as every query leaves them out;
 * `done` is the status that finishes a task, null when the Task type has
 * none. `modified` is the day the file last changed.
 */
export function compileFollowUpsQuery({
  entity,
  meetings,
  taskType,
  personType,
  statusKey,
  done,
  limit = FOLLOW_UP_LIMIT,
}: {
  entity: string;
  meetings: readonly string[];
  /** The vault's Task type, as notes of it write `type:`. */
  taskType: string;
  /** The vault's Person type, as notes of it write `type:`; null when it has none. */
  personType: string | null;
  statusKey: string;
  done: string | null;
  limit?: number;
}): CompiledQuery {
  const asked = boundedPaths(meetings.filter((path) => path !== entity));
  const around = [entity, ...asked];
  const hits = [
    'SELECT r.dst AS task, a.path AS around, a.self AS self FROM relations AS r JOIN around AS a ON r.src = a.path',
    'SELECT r.src, a.path, a.self FROM relations AS r JOIN around AS a ON r.dst = a.path',
    'SELECT l.dst, a.path, a.self FROM links AS l JOIN around AS a ON l.src = a.path',
    'SELECT l.src, a.path, a.self FROM links AS l JOIN around AS a ON l.dst = a.path',
  ].join(' UNION ');
  const linkedWith = [
    't.path IN (SELECT r.dst FROM relations AS r WHERE r.src = f.path)',
    't.path IN (SELECT r.src FROM relations AS r WHERE r.dst = f.path)',
    't.path IN (SELECT l.dst FROM links AS l WHERE l.src = f.path)',
    't.path IN (SELECT l.src FROM links AS l WHERE l.dst = f.path)',
  ].join(' OR ');
  const namesOtherPerson =
    personType === null
      ? '0'
      : `EXISTS (SELECT 1 FROM props AS t WHERE t.key = 'type' AND ${foldedTypeSql('t.value_text')} = ? AND t.path <> ? AND (${linkedWith}))`;
  const open = done === null ? [] : ["  AND COALESCE(status, '') <> ?"];
  return {
    sql: [
      `${ASSISTANT_QUERY_MARK} WITH around(path, self) AS (VALUES ${around.map((_, at) => (at === 0 ? '(?, 1)' : '(?, 0)')).join(', ')}),`,
      `hits(task, around, self) AS (${hits}),`,
      'followed AS (',
      '  SELECT f.path AS path, f.title AS title,',
      `    ${valueOf('f.path')} AS status,`,
      `    ${valueOf('f.path')} AS due,`,
      `    ${valueOf('f.path')} AS source,`,
      `    ${valueOf('f.path')} AS waitingOn,`,
      "    date(f.modified / 1000, 'unixepoch', 'localtime') AS modified,",
      '    (SELECT COALESCE(MAX(h.self), 0) FROM hits AS h WHERE h.task = f.path) AS direct,',
      '    (SELECT MIN(h.around) FROM hits AS h WHERE h.task = f.path AND h.self = 0) AS meeting,',
      `    ${namesOtherPerson} AS other`,
      '  FROM files AS f',
      `  WHERE f.path IN (SELECT path FROM props WHERE key = 'type' AND ${foldedTypeSql('value_text')} = ?)`,
      '    AND f.path IN (SELECT path FROM tags WHERE tag = ?)',
      '    AND f.path IN (SELECT task FROM hits)',
      `    AND ${outsideArchiveSql('f.path')} AND ${userSpaceNoteSql('f.path')}`,
      ')',
      'SELECT followed.path AS "path", followed.title AS "title", status AS "status", due AS "due",',
      '  source AS "source", waitingOn AS "waitingOn", modified AS "modified", direct AS "direct",',
      '  CASE WHEN direct = 1 THEN NULL ELSE meeting END AS "meeting",',
      '  (SELECT m.title FROM files AS m WHERE m.path = followed.meeting AND followed.direct = 0) AS "meetingTitle"',
      'FROM followed',
      'WHERE (direct = 1 OR other = 0)',
      ...open,
      'ORDER BY followed.path LIMIT ?',
    ].join('\n'),
    parameters: [
      ...around,
      statusKey,
      TASK_KEYS.due,
      TASK_KEYS.source,
      TASK_KEYS.waitingOn,
      ...(personType === null ? [] : [foldedTypeName(personType), entity]),
      foldedTypeName(taskType),
      tagKey(FOLLOW_UP_TAG),
      ...(done === null ? [] : [done]),
      limit,
    ],
  };
}

/** A follow-up as {@link compileFollowUpsQuery} answers it. */
export interface FollowUpRow {
  readonly path: string;
  readonly title: string;
  readonly status: string | null;
  readonly due: string | null;
  readonly source: string | null;
  /** Who it waits on, as written; null when it does not say. */
  readonly waitingOn: string | null;
  /** The day its file last changed. */
  readonly modified: string | null;
  /** Whether it is linked with the page itself, not only with a meeting. */
  readonly direct: boolean;
  /** The first meeting of the page that reached it, when it is not linked with the page itself. */
  readonly meeting: string | null;
  readonly meetingTitle: string | null;
}

const textOrNull = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/** The rows of {@link compileFollowUpsQuery}, in {@link FOLLOW_UP_COLUMNS} order. */
export function followUpRowsOf(rows: readonly (readonly unknown[])[]): FollowUpRow[] {
  return rows.flatMap(
    ([path, title, status, due, source, waitingOn, modified, direct, meeting, meetingTitle]) =>
      typeof path === 'string'
        ? [
            {
              path,
              title: typeof title === 'string' ? title : path,
              status: textOrNull(status),
              due: textOrNull(due),
              source: textOrNull(source),
              waitingOn: textOrNull(waitingOn),
              modified: textOrNull(modified),
              direct: direct === 1 || direct === true,
              meeting: textOrNull(meeting),
              meetingTitle: textOrNull(meetingTitle),
            },
          ]
        : [],
  );
}
