import { MEETING_TYPE } from '../meetings/meeting-header.ts';
import type { CompiledQuery } from '../query/view-query.ts';
import { createVaultPath } from '../vault/vault-path.ts';
import { userSpaceNoteSql } from '../vault/vault-visibility.ts';
import { EVENT_NOTE_KEYS } from './event-notes.ts';
import type { MeetingCandidate } from './meeting-match.ts';
import { notEventNoteSql } from './not-event-notes.ts';

const K = EVENT_NOTE_KEYS;

/** The most event ids one lookup names, well under SQLite's limit on parameters. */
export const EVENT_ID_LOOKUP_SIZE = 500;

const marks = (count: number) => Array.from({ length: count }, () => '?').join(', ');

/**
 * The event notes a sync may write to: those for the events Google
 * answered with, by id, and every one on a day in the window, which a full
 * listing marks when its event has gone. Column: path.
 */
export function compileEventNotesQuery({
  ids,
  fromDay,
  toDay,
}: {
  ids: readonly string[];
  fromDay: string;
  toDay: string;
}): CompiledQuery {
  return {
    sql: `/* meetings: event notes */ SELECT DISTINCT props.path AS "path" FROM props
 WHERE props.key = ? AND ${userSpaceNoteSql('props.path')}
   AND (props.value_text IN (${marks(ids.length)})
        OR props.path IN (SELECT path FROM props WHERE key = ?
                           AND substr(value_text, 1, 10) BETWEEN ? AND ?))
 ORDER BY props.path`,
    parameters: [K.eventId, ...ids, K.date, fromDay, toDay],
  };
}

/**
 * The meeting notes on the window's days that an event may be matched to.
 * Columns: path, title, date, start.
 */
export function compileMeetingCandidatesQuery({
  fromDay,
  toDay,
}: {
  fromDay: string;
  toDay: string;
}): CompiledQuery {
  return {
    sql: `/* meetings: meeting notes to match */ SELECT files.path AS "path", files.title AS "title",
       day.value_text AS "date",
       (SELECT start.value_text FROM props AS start
         WHERE start.path = files.path AND start.key = 'start' ORDER BY start.idx LIMIT 1) AS "start"
  FROM files JOIN props AS day ON day.path = files.path AND day.key = 'date' AND day.idx = 0
 WHERE files.path IN (SELECT path FROM props WHERE key = 'type' AND value_text = ?)
   AND substr(day.value_text, 1, 10) BETWEEN ? AND ?
   AND ${userSpaceNoteSql('files.path')}
 ORDER BY files.path`,
    parameters: [MEETING_TYPE, fromDay, toDay],
  };
}

/** The rows of {@link compileMeetingCandidatesQuery} as candidates. */
export function meetingCandidatesOf(
  rows: readonly { path: string; title: string; date: unknown; start: unknown }[],
): MeetingCandidate[] {
  return rows.flatMap((row) => {
    if (typeof row.date !== 'string') return [];
    const start =
      typeof row.start === 'string' && row.start.trim() !== '' ? row.start.trim() : null;
    return [
      { path: createVaultPath(row.path), title: row.title, date: row.date.slice(0, 10), start },
    ];
  });
}

/** What a row of today's events carries, beside its path and title. */
const DAY_KEYS = [K.date, K.ends, K.response, K.missing, K.eventId] as const;
const LINK_KEYS = [K.people, K.companies, K.meeting] as const;

/**
 * The event notes a meetings sync wrote that start on `day`: a row for each
 * of their times, their answer, their mark and their event id, and one for each note their
 * people, companies and meeting link, resolved. Columns: path, title, key,
 * value; a note's rows arrive together. A brief or a block that carries an
 * event's keys is no meeting (`notEventNoteSql`); any other note's `type` is
 * the person's, and decides nothing.
 */
export function compileDayEventsQuery(day: string): CompiledQuery {
  const notEvent = notEventNoteSql('path');
  const ofTheDay = `SELECT path FROM props WHERE key = ? AND substr(value_text, 1, 10) = ?
     AND path IN (SELECT path FROM props WHERE key = ?)
     AND ${notEvent.sql}`;
  const dayOf = [K.date, day, K.eventId, ...notEvent.parameters];
  return {
    sql: `/* meetings: today */ SELECT "path", "title", "key", "value" FROM (
  SELECT files.path AS "path", files.title AS "title", item.key AS "key",
         item.value_text AS "value", item.idx AS "idx"
    FROM files JOIN props AS item ON item.path = files.path AND item.key IN (${marks(DAY_KEYS.length)})
   WHERE files.path IN (${ofTheDay}) AND ${userSpaceNoteSql('files.path')}
  UNION ALL
  SELECT relations.src, files.title, relations.key, relations.dst, relations.idx
    FROM relations JOIN files ON files.path = relations.src
   WHERE relations.key IN (${marks(LINK_KEYS.length)}) AND relations.dst IS NOT NULL
     AND relations.src IN (${ofTheDay}) AND ${userSpaceNoteSql('files.path')}
) ORDER BY "path", "key", "idx"`,
    parameters: [...DAY_KEYS, ...dayOf, ...LINK_KEYS, ...dayOf],
  };
}
