import {
  calendarStartFor,
  meetingStartAsk,
  type CalendarStart,
  type MappingOptions,
  type MeetingFields,
} from '@dfai/domain';
import type { IndexPort } from '../index/ports.ts';
import { readDayMeetings } from '../google-calendar/read-day-meetings.ts';

/**
 * The meeting's calendar event, for a meeting that carries no start of its
 * own (#582): the day's event notes a meetings sync wrote (ADR-0046), read
 * through the index, and the domain's rule for which one it was. Null when
 * the meeting has its start, so nothing is read. An index that cannot answer
 * is passed on: taking it as "no events" would tell the sender to connect a
 * calendar that is connected.
 */
export async function meetingCalendarStart({
  index,
  fields,
  options,
}: {
  index: Pick<IndexPort, 'query'>;
  fields: MeetingFields;
  options: MappingOptions;
}): Promise<CalendarStart | null> {
  const ask = meetingStartAsk(fields, options);
  if (ask === null) return null;
  const meetings = await readDayMeetings({ index, day: ask.day });
  const wall = (time: string) => `${ask.day}T${time}`;
  const events = meetings.map(({ title, start, end }) => ({
    title,
    start: wall(start),
    end: end === null ? null : wall(end),
  }));
  return calendarStartFor(ask, events);
}
