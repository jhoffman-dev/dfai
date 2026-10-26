import { rfc3339Instant } from './meeting-instant.ts';
import { MeetingMappingError, shown } from './meeting-mapping-error.ts';
import { zoneOffsetMinutes, type StatedWhen } from './meeting-stated.ts';

/** When a meeting was: the day, its local start, and its end when known. */
export interface MeetingWhen {
  readonly date: string;
  readonly start: string;
  readonly end: string | null;
  /** True when the start was worked out (arrival less transcript length), not read. */
  readonly startApproximate: boolean;
  /** `calendar` when the start was read off the meeting's calendar event; null when off the meeting itself. */
  readonly startSource: 'calendar' | null;
}

/**
 * What the meeting's calendar event gave: its start and end (`HH:MM`), or why
 * no event could be taken. `connect` says connecting a calendar could help:
 * DFAI had no events that day at all.
 */
export type CalendarStart =
  | { readonly found: true; readonly start: string; readonly end: string | null }
  | { readonly found: false; readonly why: string; readonly connect: boolean };

/**
 * What a calendar is asked about a meeting nothing it carries gives a start
 * for: the day (`YYYY-MM-DD`) and when its notes arrived on the local clock
 * (`YYYY-MM-DDTHH:MM`), which is about when it ended.
 */
export interface StartAsk {
  readonly day: string;
  readonly arrived: string;
}

/** A day and a time read off one input value; either may be missing. */
interface Moment {
  readonly day: string | null;
  readonly time: string | null;
}

const NOTHING: Moment = { day: null, time: null };
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME =
  /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}(?:\.\d+)?))?(Z|[+-]\d{2}:?\d{2})?$/i;
const CLOCK = /^(\d{1,2})[:.](\d{2})(?::\d{2})?\s*([ap])?\.?m?\.?$/i;

/** `2026-09-29`, when it is a day the calendar has (no 30 February). */
function realDay(text: string): string | null {
  const match = DAY.exec(text);
  if (match === null) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  const real = date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  return real ? text : null;
}

/** `9:05`, `09:05:30`, `2:30 PM` as 24-hour `HH:MM`; null when it is not a time of day. */
function clockTime(text: string): string | null {
  const match = CLOCK.exec(text);
  if (match === null) return null;
  let hours = Number(match[1]);
  const minutes = Number(match[2]);
  const half = match[3]?.toLowerCase();
  if (half !== undefined && (hours < 1 || hours > 12)) return null;
  if (half === 'p' && hours < 12) hours += 12;
  if (half === 'a' && hours === 12) hours = 0;
  if (hours > 23 || minutes > 59) return null;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

/** A clock in `timeZone`; refuses a name that is not an IANA zone. */
function zoneClock(timeZone: string): Intl.DateTimeFormat {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
  } catch {
    throw new MeetingMappingError(
      `${shown(timeZone)} is not a time zone (try "America/Los_Angeles")`,
    );
  }
}

/** The day an instant falls on and its `HH:MM:SS` time of day, on one zone's clock. */
export interface WallTime {
  readonly day: string;
  readonly time: string;
}

/**
 * A reader of instants (milliseconds since the epoch) on the clock of
 * `timeZone`, made once for many turns. Refuses a name that is not an IANA zone.
 *
 * Known limit: the zone's rules come from each engine's own tz database
 * (Node bundles one; the webview's JavaScriptCore reads macOS's). Writers on
 * different tz versions can disagree by an hour for a zone whose rules
 * changed — America/Vancouver from 2026-11-01, for one. The in-app pull
 * checks the ids the vault holds before fetching and runs after a sync pull,
 * so the first file written wins and the second writer skips the note.
 */
export function wallClockIn(timeZone: string): (instant: number) => WallTime {
  const clock = zoneClock(timeZone);
  return (instant) => {
    const parts = clock.formatToParts(instant);
    const part = (type: string) => parts.find((each) => each.type === type)?.value ?? '';
    return {
      day: `${part('year')}-${part('month')}-${part('day')}`,
      time: `${part('hour')}:${part('minute')}:${part('second')}`,
    };
  };
}

/** The day and time an instant shows on a clock in `timeZone`. */
function inZone(instant: Date, timeZone: string): Moment {
  const { day, time } = wallClockIn(timeZone)(instant.getTime());
  return { day, time: time.slice(0, 5) };
}

/**
 * A date-and-time. Without an offset it is a local clock time, taken as
 * written. With one (`Z`, `-07:00`) it is an instant, shown on the clock of
 * `timeZone`; with no zone to read it in it is refused, since keeping the
 * UTC clock time would put a 17:02 meeting at 00:02 the next day.
 */
function dateTime(match: RegExpExecArray, field: string, timeZone: string | null): Moment {
  const [text, day = '', hours = '', minutes = '', seconds = '00', offset] = match;
  if (realDay(day) === null) throw new MeetingMappingError(`${field}: ${day} is not a real day`);
  const time = clockTime(`${hours}:${minutes}`);
  if (time === null) {
    throw new MeetingMappingError(`${field}: ${hours}:${minutes} is not a time of day`);
  }
  if (offset === undefined) return { day, time };
  if (timeZone === null) {
    throw new MeetingMappingError(
      `${field}: ${text} is an instant (it ends in Z or an offset) and there is no time zone to read it in; set timeZone`,
    );
  }
  const zone = offset.toUpperCase().replace(/^([+-]\d{2})(\d{2})$/, '$1:$2');
  // Read by our own rules, not the engine's: V8 and JavaScriptCore differ on a 60th second.
  const instant = rfc3339Instant(`${day}T${hours}:${minutes}:${seconds}${zone}`);
  if (instant === null) {
    throw new MeetingMappingError(`${field}: cannot read ${shown(text)} as an instant`);
  }
  return inZone(new Date(instant), timeZone);
}

function readMoment(value: unknown, field: string, timeZone: string | null): Moment {
  if (value === null || value === undefined || value === '') return NOTHING;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new MeetingMappingError(`${field}: not a valid date`);
    return readMoment(value.toISOString(), field, timeZone);
  }
  if (typeof value !== 'string') {
    throw new MeetingMappingError(`${field}: expected text, got ${shown(value)}`);
  }
  const text = value.trim();
  const full = DATE_TIME.exec(text);
  if (full !== null) return dateTime(full, field, timeZone);
  if (DAY.test(text)) {
    const day = realDay(text);
    if (day === null) throw new MeetingMappingError(`${field}: ${text} is not a real day`);
    return { day, time: null };
  }
  const time = clockTime(text);
  if (time !== null) return { day: null, time };
  throw new MeetingMappingError(`${field}: cannot read ${shown(text)} as a date or a time`);
}

/** What the mapping reads the meeting's time from. */
export interface WhenInput {
  readonly date: unknown;
  readonly start: unknown;
  readonly end: unknown;
  /** The day and time the provider's email states; when given, `date` is not read. */
  readonly stated: StatedWhen | null;
  /** When the notes arrived (an instant, or a local date-time), for an approximate start. */
  readonly arrived: unknown;
  /** How long the recording ran, in seconds, to take off `arrived`. */
  readonly transcriptLength: number | null;
  /** The transcript's first time of day, for a provider (Granola) that stamps every turn. */
  readonly firstSpoken: string | null;
  readonly timeZone: string | null;
  /** The meeting's calendar event, looked up from a {@link StartAsk}; null when there is no calendar to ask. */
  readonly calendar: CalendarStart | null;
}

/** A stated day and time; approximate when it is another zone's clock that could not be converted. */
interface StatedMoment extends Moment {
  readonly approximate: boolean;
}

/**
 * The stated day and time, each checked as a value of `date` and `start`
 * would be. A time with a zone after it (`13:00 EDT`) is shown on the clock
 * of `timeZone`, which may move the day. A zone the mapper does not know, or
 * no `timeZone` to show it in, keeps the clock time as written but marks it
 * approximate: another zone's clock is never written as local unflagged.
 */
function statedMoment(stated: StatedWhen, timeZone: string | null): StatedMoment {
  const { day } = readMoment(stated.day, 'stated', null);
  if (stated.time === null) return { day, time: null, approximate: false };
  const time = clockTime(stated.time);
  if (time === null) throw new MeetingMappingError(`stated: ${stated.time} is not a time of day`);
  if (stated.zone === null) return { day, time, approximate: false };
  const offset = zoneOffsetMinutes(stated.zone);
  if (offset === null || timeZone === null) return { day, time, approximate: true };
  const instant = new Date(Date.parse(`${day ?? ''}T${time}:00Z`) - offset * 60_000);
  return { ...inZone(instant, timeZone), approximate: false };
}

/** When the notes arrived, on the local clock; null when the sender did not say. */
function arrivalMoment(input: WhenInput): { day: string; time: string } | null {
  if (input.arrived === null || input.arrived === undefined || input.arrived === '') return null;
  const { day, time } = readMoment(input.arrived, 'arrived', input.timeZone);
  if (day === null || time === null) {
    throw new MeetingMappingError('arrived: needs a date and a time (when the notes arrived)');
  }
  return { day, time };
}

const SEND_A_START = 'send `start`, a time in the subject, or a transcript with its times';

/** Why there is no start, and what the sender can add to give one. */
function noStartMessage(calendar: CalendarStart | null): string {
  const lead =
    'start: the meeting has no start time: the email states none, and with no transcript length the arrival (about when it ended) cannot give one';
  if (calendar === null || calendar.found) return `${lead}; ${SEND_A_START}`;
  const connect = calendar.connect
    ? ', or connect Google Calendar so DFAI can take the start from the meeting’s event'
    : '';
  return `${lead}, and ${calendar.why}; ${SEND_A_START}${connect}`;
}

/**
 * When the meeting began, about: the arrival less the recording's length.
 * Without a length (no transcript, or one with no stamps and no end mark)
 * there is nothing to take off, and the arrival — about when the meeting
 * ended — is never a start, so the meeting is refused, saying what would
 * give one. Worked on the local clock, so a meeting that spans a
 * daylight-saving change is out by that hour — it is marked approximate.
 */
function arrivalLessLength(input: WhenInput): Moment {
  const arrived = arrivalMoment(input);
  if (arrived === null) return NOTHING;
  const { day, time } = arrived;
  if (input.transcriptLength === null) {
    throw new MeetingMappingError(noStartMessage(input.calendar));
  }
  const arrival = Date.parse(`${day}T${time}:00Z`);
  const began = new Date(arrival - input.transcriptLength * 1000).toISOString();
  return { day: began.slice(0, 10), time: began.slice(11, 16) };
}

/** What the meeting itself says of its time: each source read and checked. */
interface Sources {
  readonly stated: StatedMoment | null;
  readonly date: Moment;
  readonly start: Moment;
  readonly end: Moment;
  /** The start read off the meeting (`start`, the email, `date`, the first word spoken), if any. */
  readonly read: string | null;
}

function readSources(input: WhenInput): Sources {
  if (input.timeZone !== null) zoneClock(input.timeZone);
  const stated = input.stated === null ? null : statedMoment(input.stated, input.timeZone);
  // A stated day means the date is the provider's arrival time (Gemini's Notion Date): not the meeting's.
  const date = stated ?? readMoment(input.date, 'date', input.timeZone);
  const start = readMoment(input.start, 'start', input.timeZone);
  const end = readMoment(input.end, 'end', input.timeZone);
  return { stated, date, start, end, read: start.time ?? date.time ?? input.firstSpoken };
}

/**
 * What to ask the calendar, when nothing the meeting carries gives its start:
 * the day the email states, else the date's, else the start's, else the
 * arrival's, and the arrival itself. Null when the meeting has its start, or
 * no arrival to check an event's end against.
 */
export function startAsk(input: WhenInput): StartAsk | null {
  const { date, start, read } = readSources(input);
  if (read !== null) return null;
  const arrived = arrivalMoment(input);
  if (arrived === null) return null;
  return { day: date.day ?? start.day ?? arrived.day, arrived: `${arrived.day}T${arrived.time}` };
}

/**
 * The meeting's day, start and end. The day is the one the email states,
 * else the date's, else the start's. The start is the one given, else the
 * time the email states, else the time on the date, else when the first
 * word was spoken (a wall-clock transcript only), else the start of the
 * meeting's calendar event (read, so not approximate; its end too, when none
 * was given), else — marked approximate — the arrival less the transcript's
 * length. With none of those the meeting has no start, and the contract
 * requires one — so it is refused rather than given a made-up time. A start
 * read off another zone's clock that could not be converted is marked
 * approximate too.
 */
export function meetingWhen(input: WhenInput): MeetingWhen {
  const { stated, date, start, end, read } = readSources(input);
  const event = read === null && input.calendar?.found === true ? input.calendar : null;
  if (event !== null) {
    const day = date.day ?? start.day ?? arrivalMoment(input)?.day ?? null;
    if (day === null) throw new MeetingMappingError('date: the meeting has no date');
    const finish = end.time ?? event.end;
    return {
      date: day,
      start: event.start,
      end: finish,
      startApproximate: false,
      startSource: 'calendar',
    };
  }
  const worked = read === null ? arrivalLessLength(input) : NOTHING;
  const day = date.day ?? start.day ?? worked.day;
  if (day === null) throw new MeetingMappingError('date: the meeting has no date');
  const startTime = read ?? worked.time;
  if (startTime === null) {
    throw new MeetingMappingError('start: the meeting has no start time (pass `start`)');
  }
  const foreignClock =
    start.time === null && stated !== null && stated.time !== null && stated.approximate;
  return {
    date: day,
    start: startTime,
    end: end.time,
    startApproximate: read === null || foreignClock,
    startSource: null,
  };
}
