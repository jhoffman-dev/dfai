import {
  compileDayEventsQuery,
  dayEventTimes,
  dayMeetings,
  EVENT_NOTE_TYPE,
  EVENT_NOTES_FOLDER,
  type DayEventRow,
  type DayEvents,
  type DayMeeting,
} from '@dfai/domain';
import type { IndexPort } from '../index/ports.ts';
import type { Clock } from '../ports.ts';
import type { ReadScope } from '../reads/scoped-reads.ts';

/**
 * What the day's meetings are read from: event notes, wherever they were
 * moved, and the folder a sync makes them in. A tick of a task is none of it.
 */
export const DAY_MEETINGS_SCOPE: ReadScope = {
  types: [EVENT_NOTE_TYPE],
  folders: [EVENT_NOTES_FOLDER],
};

/**
 * The meetings on `day` (`YYYY-MM-DD`), from the event notes a meetings
 * sync wrote (ADR-0046) — read from the index, so it answers offline and on
 * a Mac that is not signed in. What the morning brief (#39) reads per meeting.
 */
export async function readDayMeetings({
  index,
  day,
}: {
  index: Pick<IndexPort, 'query'>;
  day: string;
}): Promise<DayMeeting[]> {
  return dayMeetings(await readDayEventRows({ index, day }), day);
}

/**
 * The events on `day` as a meeting's calendar start is looked for among
 * them (#582): with ends on their own days, and how many event notes the day held.
 */
export async function readDayEventTimes({
  index,
  day,
}: {
  index: Pick<IndexPort, 'query'>;
  day: string;
}): Promise<DayEvents> {
  return dayEventTimes(await readDayEventRows({ index, day }), day);
}

async function readDayEventRows({
  index,
  day,
}: {
  index: Pick<IndexPort, 'query'>;
  day: string;
}): Promise<DayEventRow[]> {
  const { sql, parameters } = compileDayEventsQuery(day);
  const result = await index.query(sql, parameters);
  const at = (name: string) => result.columns.indexOf(name);
  const rows = result.rows.map((row) => {
    const value = row[at('value')];
    return {
      path: String(row[at('path')]),
      title: String(row[at('title')] ?? ''),
      key: String(row[at('key')]),
      value: value === null || value === undefined ? null : String(value),
    };
  });
  return rows;
}

/** Today's meetings, on the injected clock's day. */
export function readTodaysMeetings({
  index,
  clock,
}: {
  index: Pick<IndexPort, 'query'>;
  clock: Pick<Clock, 'today'>;
}): Promise<DayMeeting[]> {
  return readDayMeetings({ index, day: clock.today() });
}
