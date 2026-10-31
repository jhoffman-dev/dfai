import { foldedTypeSql } from '../types/note-type-sql.ts';
import { outsideArchiveSql } from '../archive/archive.ts';
import type { CompiledQuery } from '../query/view-query.ts';
import {
  DUPLICATE_OF_KEY,
  IMPORT_CONTRACT_KEY,
  IMPORT_ERROR_KEY,
  IMPORT_OUTCOME_KEY,
  importOutcomeOf,
  meetingLandingSql,
  type ImportOutcome,
} from './meeting-arrival.ts';
import { MEETING_TYPE } from './meeting-header.ts';

/** What the statements here start with, so a log or a stand-in index can tell them apart. */
export const MEETING_QUERY_MARK = '/* meetings */';

/** A note's first value for a key, as text — a date's as written when the index read it as one. */
const valueOf = (key: string) =>
  `(SELECT COALESCE(p.value_date, p.value_text) FROM props AS p WHERE p.path = files.path AND p.key = '${key}' ORDER BY p.idx LIMIT 1)`;

/** Notes of the Meeting type, as a condition on `files.path`. */
const IS_MEETING = `files.path IN (SELECT path FROM props WHERE key = 'type' AND ${foldedTypeSql('value_text')} = ?)`;

/**
 * The notes the index says hold a meeting's provider + external_id: what a
 * copy of it may be a duplicate of. Archived notes count — a meeting filed
 * away and sent again is still the same meeting. Notes marked as a copy or as
 * failing import are listed too: the index can be behind the files (a mark
 * written, or taken out, since it last read them), so whoever asks reads each
 * file to know what it holds now. Ids are compared without the spaces around
 * them: `' g-1'` and `'g-1'` are one meeting.
 */
export function compileMeetingHoldersQuery({
  provider,
  externalId,
}: {
  provider: string;
  externalId: string;
}): CompiledQuery {
  return {
    sql: [
      `${MEETING_QUERY_MARK} SELECT files.path AS "path" FROM files`,
      `WHERE ${IS_MEETING}`,
      `  AND files.path IN (SELECT path FROM props WHERE key = 'provider' AND value_text = ?)`,
      `  AND files.path IN (SELECT path FROM props WHERE key = 'external_id' AND trim(value_text) = ?)`,
      `ORDER BY files.path`,
    ].join('\n'),
    parameters: [MEETING_TYPE, provider, externalId.trim()],
  };
}

/** The most stamp rows one page of {@link compileImportOutcomesQuery} asks for: under the host's own cap on a result. */
export const IMPORT_OUTCOMES_PAGE = 1000;

/**
 * One page of the import stamps the index holds for notes where meeting files
 * land, and the stamp as text: what the index knows of how the import settled
 * each note, which its manifest does not say (#92). Stamps are the import's
 * only where meetings land, so no other note is asked about — a vault with
 * thousands of stamped notes elsewhere costs nothing. Pages are numbered from
 * 0; one with fewer rows than {@link IMPORT_OUTCOMES_PAGE} is the last. Read
 * with {@link importOutcomesOf}.
 */
export function compileImportOutcomesQuery(page = 0): CompiledQuery {
  return {
    sql: [
      `${MEETING_QUERY_MARK} SELECT path, value_text FROM props`,
      `WHERE key = ? AND ${meetingLandingSql('path')}`,
      `ORDER BY path, idx LIMIT ? OFFSET ?`,
    ].join('\n'),
    parameters: [IMPORT_OUTCOME_KEY, IMPORT_OUTCOMES_PAGE, page * IMPORT_OUTCOMES_PAGE],
  };
}

/**
 * One page of the notes where meeting files land that declare the import's
 * contract (`atlas_import`), by path: which of them are the import's, which
 * the manifest does not say either (#214). Paged as
 * {@link compileImportOutcomesQuery} is; each row is one path.
 */
export function compileImportDeclarationsQuery(page = 0): CompiledQuery {
  return {
    sql: [
      `${MEETING_QUERY_MARK} SELECT DISTINCT path FROM props`,
      `WHERE key = ? AND trim(coalesce(value_text, value_json, '')) <> ''`,
      `  AND ${meetingLandingSql('path')}`,
      `ORDER BY path LIMIT ? OFFSET ?`,
    ].join('\n'),
    parameters: [IMPORT_CONTRACT_KEY, IMPORT_OUTCOMES_PAGE, page * IMPORT_OUTCOMES_PAGE],
  };
}

/**
 * How the import settled each note, from {@link compileImportOutcomesQuery}'s
 * rows, as the import reads a stamp: one it does not know, or not text, is
 * `imported` all the same.
 */
export function importOutcomesOf(
  rows: readonly (readonly unknown[])[],
): Map<string, ImportOutcome> {
  const outcomes = new Map<string, ImportOutcome>();
  for (const [path, stamp] of rows) {
    const outcome = importOutcomeOf({ [IMPORT_OUTCOME_KEY]: stamp });
    if (!outcomes.has(String(path)) && outcome !== null) outcomes.set(String(path), outcome);
  }
  return outcomes;
}

/** The columns {@link compileMeetingListQuery} comes back as, in order. */
export const MEETING_LIST_COLUMNS = [
  'path',
  'title',
  'date',
  'start',
  'end',
  'kind',
  'provider',
  'external_id',
  IMPORT_OUTCOME_KEY,
  IMPORT_ERROR_KEY,
  DUPLICATE_OF_KEY,
  'stamped',
  'declared',
] as const;

/** The most meetings one page lists. */
export const MEETING_LIST_LIMIT = 500;

/**
 * Meetings, newest first by their day and start, then by path so a page never
 * reshuffles: every note of the Meeting type, and any note carrying an import
 * error, since a file that failed the contract may not say what it is. `since`
 * keeps those on or after a day (`YYYY-MM-DD`); a note with no day is kept
 * only when no `since` is given. Archived notes — duplicates among them —
 * are left out unless asked for.
 */
export function compileMeetingListQuery({
  since,
  includeArchived,
  limit,
  offset,
}: {
  since: string | null;
  includeArchived: boolean;
  limit: number;
  offset: number;
}): CompiledQuery {
  const title = `COALESCE(${valueOf('title')}, files.title)`;
  const columns = [
    `files.path AS "path"`,
    `${title} AS "title"`,
    ...MEETING_LIST_COLUMNS.slice(2, -2).map((key) => `${valueOf(key)} AS "${key}"`),
    // Whether the import stamped it at all: a stamp with its value cleared is a stamp still.
    `EXISTS (SELECT 1 FROM props AS p WHERE p.path = files.path AND p.key = '${IMPORT_OUTCOME_KEY}') AS "stamped"`,
    // Whether it declares the import's contract, which makes an unstamped one the import's (#214).
    `EXISTS (SELECT 1 FROM props AS p WHERE p.path = files.path AND p.key = '${IMPORT_CONTRACT_KEY}' AND trim(coalesce(p.value_text, p.value_json, '')) <> '') AS "declared"`,
  ];
  const conditions = [
    `(${IS_MEETING} OR files.path IN (SELECT path FROM props WHERE key = ?))`,
    ...(includeArchived ? [] : [outsideArchiveSql('files.path')]),
    ...(since === null ? [] : [`"date" >= ?`]),
  ];
  return {
    sql: [
      `${MEETING_QUERY_MARK} SELECT ${columns.join(',\n  ')}`,
      `FROM files`,
      `WHERE ${conditions.join('\n  AND ')}`,
      `ORDER BY "date" IS NULL, "date" DESC, "start" DESC, files.path`,
      `LIMIT ? OFFSET ?`,
    ].join('\n'),
    parameters: [
      MEETING_TYPE,
      IMPORT_ERROR_KEY,
      ...(since === null ? [] : [since]),
      Math.max(1, Math.floor(limit)),
      Math.max(0, Math.floor(offset)),
    ],
  };
}
