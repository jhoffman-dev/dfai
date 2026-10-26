import { meetingWhen } from '../../packages/domain/src/meetings/mapping/meeting-when.ts';
import { MeetingMappingError } from '../../packages/domain/src/meetings/mapping/meeting-mapping-error.ts';
import { notionWhen, type DateOrder } from './notion-date.ts';

/** What a Notion date cell says about a day: the day, and the end of a range, or why it says nothing readable. */
export type DayReading =
  | {
      readonly kind: 'day';
      readonly day: string;
      /** The day a range ends on, or null for no range, or one whose end could not be read. */
      readonly end: string | null;
      /** The end as Notion wrote it, or null for no range. */
      readonly endText: string | null;
    }
  | { readonly kind: 'unread'; readonly why: string };

/**
 * The day a value falls on, read as the meeting mapper reads a meeting's
 * date; null with why when it is none. The mapper insists on a start time,
 * which a day alone does not have: it is given midnight, and only the day
 * is read back.
 */
function dayIn(value: string, timeZone: string | null): { day: string | null; why: string } {
  try {
    // A day cell states nothing and arrived at no time: it is read as a date alone.
    const { date } = meetingWhen({
      date: value,
      start: null,
      end: null,
      stated: null,
      arrived: null,
      transcriptLength: null,
      firstSpoken: '00:00',
      timeZone,
      calendar: null,
    });
    return { day: date, why: '' };
  } catch (error) {
    if (!(error instanceof MeetingMappingError)) throw error;
    const why = error.message.replace(/^date: /, '');
    // The mapper says it of a meeting; here it is a time written with no day.
    return { day: null, why: why === 'the meeting has no date' ? 'it has a time and no day' : why };
  }
}

/**
 * The day a Notion date cell is on. The cell is read as the meeting import
 * reads a Date (`notionWhen`): a time with a zone other than UTC is that
 * clock's, and a UTC time is an instant, whose day is the one it falls on in
 * `timeZone` — the day Notion showed. A range keeps its end's day. A date
 * written `10/06/2026` is read in `order`, and with none is not read.
 */
export function readDay(
  cell: string,
  timeZone: string | null,
  order: DateOrder | null = null,
): DayReading {
  const when = notionWhen(cell, order);
  const start = dayIn(when.date, timeZone);
  if (start.day === null) return { kind: 'unread', why: start.why };
  const endText = cell.includes('→') ? (cell.split('→')[1]?.trim() ?? '') : null;
  const end = when.end === null ? null : dayIn(when.end, timeZone).day;
  return { kind: 'day', day: start.day, end, endText: endText === '' ? null : endText };
}
