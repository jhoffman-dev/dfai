import { foldedTypeSql } from '../types/note-type-sql.ts';
import { MEETING_TYPE, type MeetingAttendee } from '../meetings/meeting-header.ts';
import type { CompiledQuery } from '../query/view-query.ts';
import { PARA_KEY } from '../types/para.ts';
import { createVaultPath, type VaultPath } from '../vault/vault-path.ts';
import { userSpaceNoteSql } from '../vault/vault-visibility.ts';
import { attendeesOf } from './meeting-link-plan.ts';
import { MEETING_PEOPLE_KEY, MEETING_PROJECT_KEY } from './meeting-link-keys.ts';
import {
  isOpenFiling,
  meetingParticipants,
  seriesTitle,
  type ParticipantOwner,
  type SeriesMeeting,
} from './meeting-series.ts';

/** Rows per page of either statement: under the host's own cap on a result. */
export const MEETING_SERIES_PAGE_SIZE = 2000;

/** A meeting's first value for a key, as text — a date's as written when the index read it as one. */
const valueOf = (key: string) =>
  `(SELECT COALESCE(p.value_date, p.value_text) FROM props AS p WHERE p.path = files.path AND p.key = '${key}' ORDER BY p.idx LIMIT 1)`;

/** The filed note's first value for a key. */
const filedValueOf = (key: string) =>
  `(SELECT p.value_text FROM props AS p WHERE p.path = filed.dst AND p.key = '${key}' ORDER BY p.idx LIMIT 1)`;

/**
 * One page of every meeting, with what the series rule reads of it (#227):
 * title, day, start, provider, whether its `project` holds anything, and
 * the note its first `project` link opens — that note's title, type, PARA
 * and status, for {@link isOpenFiling} to judge. Archived meetings are read
 * too: what they were filed under still says what their series is. Columns:
 * path, title, date, start, provider, filed, project, project_title,
 * project_type, project_para, project_status.
 */
export function compileSeriesMeetingsQuery(page: number): CompiledQuery {
  return {
    sql: `/* meeting links: series meetings */ SELECT files.path AS "path",
  COALESCE(${valueOf('title')}, files.title) AS "title",
  ${valueOf('date')} AS "date", ${valueOf('start')} AS "start", ${valueOf('provider')} AS "provider",
  EXISTS (SELECT 1 FROM props AS p WHERE p.path = files.path AND p.key = ?
           AND trim(coalesce(p.value_text, p.value_json, '')) <> '') AS "filed",
  filed.dst AS "project", target.title AS "project_title",
  ${filedValueOf('type')} AS "project_type", ${filedValueOf(PARA_KEY)} AS "project_para",
  ${filedValueOf('status')} AS "project_status"
  FROM files
  LEFT JOIN relations AS filed ON filed.src = files.path AND filed.key = ?
   AND filed.idx = (SELECT MIN(first.idx) FROM relations AS first WHERE first.src = files.path AND first.key = ?)
  LEFT JOIN files AS target ON target.path = filed.dst
 WHERE files.path IN (SELECT path FROM props WHERE key = 'type' AND ${foldedTypeSql('value_text')} = ?)
   AND ${userSpaceNoteSql('files.path')}
 ORDER BY files.path LIMIT ? OFFSET ?`,
    parameters: [
      MEETING_PROJECT_KEY,
      MEETING_PROJECT_KEY,
      MEETING_PROJECT_KEY,
      MEETING_TYPE,
      MEETING_SERIES_PAGE_SIZE,
      page * MEETING_SERIES_PAGE_SIZE,
    ],
  };
}

/**
 * One page of who was at each of these meetings: a row per attendee, its
 * entry as JSON (kind `attendee`), and a row per Person note its `people`
 * links (kind `person`). Columns: path, kind, value. Every path is bound.
 */
export function compileSeriesParticipantsQuery({
  paths,
  page,
}: {
  paths: readonly string[];
  page: number;
}): CompiledQuery {
  const among = paths.map(() => '?').join(', ');
  return {
    sql: `/* meeting links: series participants */ SELECT "path", "kind", "value" FROM (
  SELECT path AS "path", 'attendee' AS "kind", value_json AS "value", idx AS "idx" FROM props
   WHERE key = 'attendees' AND path IN (${among})
  UNION ALL
  SELECT src, 'person', dst, idx FROM relations
   WHERE key = ? AND dst IS NOT NULL AND src IN (${among})
) ORDER BY "path", "kind", "idx" LIMIT ? OFFSET ?`,
    parameters: [
      ...paths,
      MEETING_PEOPLE_KEY,
      ...paths,
      MEETING_SERIES_PAGE_SIZE,
      page * MEETING_SERIES_PAGE_SIZE,
    ],
  };
}

/** A row of {@link compileSeriesMeetingsQuery}. */
export interface SeriesMeetingRow {
  readonly path: string;
  readonly title: string;
  readonly date: string | null;
  readonly start: string | null;
  readonly provider: string | null;
  /** Whether its `project` holds anything at all: a meeting that does is never filed again. */
  readonly filed: boolean;
  readonly project: string | null;
  readonly projectTitle: string | null;
  readonly projectType: string | null;
  readonly projectPara: string | null;
  readonly projectStatus: string | null;
}

/** A row of {@link compileSeriesParticipantsQuery}. */
export interface SeriesParticipantRow {
  readonly path: string;
  readonly kind: string;
  readonly value: string | null;
}

/** A meeting the index holds, as the series rule and a backfill read it: one `filed` is never filed again. */
export type MeetingOnRecord = SeriesMeeting;

/**
 * The meetings the rows describe. A meeting with no day is left out: no
 * series can be told by it. Its `project` counts only when it opens an open
 * project or area ({@link isOpenFiling}).
 */
export function meetingsOnRecord({
  meetings,
  participants,
  owner,
}: {
  meetings: readonly SeriesMeetingRow[];
  participants: readonly SeriesParticipantRow[];
  owner: ParticipantOwner;
}): MeetingOnRecord[] {
  const who = participantsByMeeting(participants);
  return meetings.flatMap((row) => {
    if (row.date === null || row.date.trim() === '') return [];
    const listed = who.get(row.path) ?? { attendees: [], people: [] };
    return [
      {
        path: createVaultPath(row.path),
        title: row.title,
        date: row.date.trim().slice(0, 10),
        start: row.start,
        provider: row.provider ?? '',
        participants: meetingParticipants({ ...listed, owner }),
        project: filedProjectOf(row),
        filed: row.filed,
      },
    ];
  });
}

function filedProjectOf(row: SeriesMeetingRow): SeriesMeeting['project'] {
  if (row.project === null) return null;
  const open = isOpenFiling({
    path: row.project,
    type: row.projectType,
    para: row.projectPara,
    status: row.projectStatus,
  });
  return open
    ? { path: createVaultPath(row.project), title: row.projectTitle ?? row.project }
    : null;
}

function participantsByMeeting(rows: readonly SeriesParticipantRow[]) {
  const byMeeting = new Map<string, { attendees: MeetingAttendee[]; people: VaultPath[] }>();
  for (const row of rows) {
    const listed = byMeeting.get(row.path) ?? { attendees: [], people: [] };
    if (row.kind === 'person' && row.value !== null) listed.people.push(createVaultPath(row.value));
    if (row.kind === 'attendee') listed.attendees.push(...attendeeOf(row.value));
    byMeeting.set(row.path, listed);
  }
  return byMeeting;
}

/** One attendee entry as the index keeps it, read as linking reads the frontmatter; none when it does not read. */
function attendeeOf(json: string | null): MeetingAttendee[] {
  if (json === null) return [];
  try {
    return attendeesOf({ attendees: [JSON.parse(json) as unknown] });
  } catch {
    // An entry that is not JSON names nobody: the meeting's other attendees still count.
    return [];
  }
}

/**
 * The meetings a series rule over `targets` can read anything from: every
 * meeting sharing a title or a day with one of them — its series, or its
 * twin. What participants are then read for, so a vault's whole history is
 * never read for one meeting.
 */
export function seriesNeighbours<Row extends Pick<SeriesMeetingRow, 'path' | 'title' | 'date'>>(
  rows: readonly Row[],
  targets: readonly Pick<SeriesMeetingRow, 'title' | 'date'>[],
): Row[] {
  const titles = new Set(targets.map((target) => seriesTitle(target.title)));
  const days = new Set(targets.flatMap((target) => (target.date === null ? [] : [target.date])));
  titles.delete('');
  return rows.filter(
    (row) => titles.has(seriesTitle(row.title)) || (row.date !== null && days.has(row.date)),
  );
}
