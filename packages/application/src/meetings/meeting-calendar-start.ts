import {
  calendarStartFor,
  meetingStartAsk,
  startAskDays,
  startWorksOutWithoutCalendar,
  type CalendarStart,
  type DayEvents,
  type MappingOptions,
  type MeetingFields,
} from '@dfai/domain';
import type { IndexPort } from '../index/ports.ts';
import { readDayEventTimes } from '../google-calendar/read-day-meetings.ts';

/**
 * The meeting's calendar event, for a meeting that carries no start of its
 * own (#582): the event notes a meetings sync wrote (ADR-0046) on the days
 * it looks at, read through the index, and the domain's rule for which one
 * it was. Null when the meeting has its start, so nothing is read.
 *
 * An index that cannot answer is null for a meeting whose start can still
 * be worked out (arrival less transcript length), as it was before #582.
 * For one with no other way to a start it is passed on: taking it as "no
 * events" would tell the sender to connect a calendar that is connected.
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
  let days: DayEvents[];
  try {
    days = await Promise.all(startAskDays(ask).map((day) => readDayEventTimes({ index, day })));
  } catch (error) {
    if (startWorksOutWithoutCalendar(fields, options)) return null;
    throw error;
  }
  const events = days.flatMap((day) => day.events);
  const notes = days.reduce((total, day) => total + day.notes, 0);
  return calendarStartFor(ask, events, notes);
}
