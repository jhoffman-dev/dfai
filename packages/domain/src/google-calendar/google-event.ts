/**
 * An event on a Google calendar, as DFAI reads it for today's meetings
 * (ADR-0046). Read-only: nothing here is ever written back to Google.
 */

/** How the person answered an invitation. */
export type EventResponse = 'accepted' | 'declined' | 'tentative' | 'needsAction';

export const EVENT_RESPONSES: readonly EventResponse[] = [
  'accepted',
  'declined',
  'tentative',
  'needsAction',
];

/**
 * When an event starts or ends: an instant for a timed event, or a day for
 * an all-day one. Google writes an all-day event's end as the day after its
 * last, which is kept here as Google gave it.
 */
export type EventWhen =
  { readonly kind: 'timed'; readonly at: number } | { readonly kind: 'day'; readonly date: string };

/** Someone, or something, an event was sent to. */
export interface EventAttendee {
  readonly email: string;
  readonly name: string | null;
  /** The person whose calendar this is. */
  readonly self: boolean;
  readonly response: EventResponse | null;
  /** A room or a piece of equipment, never a person. */
  readonly resource: boolean;
}

export type EventStatus = 'confirmed' | 'tentative' | 'cancelled';

export interface GoogleEvent {
  /** Unique within a calendar; one instance of a recurring event has its own. */
  readonly id: string;
  readonly calendarId: string;
  readonly status: EventStatus;
  readonly title: string;
  /** Null for a cancelled event, which Google sends with its id alone. */
  readonly start: EventWhen | null;
  readonly end: EventWhen | null;
  readonly attendees: readonly EventAttendee[];
  /** The series an instance belongs to; null for a one-off. */
  readonly recurringEventId: string | null;
  /** Google's `eventType`: `default`, `focusTime`, `outOfOffice`, `workingLocation`, … */
  readonly eventType: string;
}

/**
 * The event types that can be a meeting. Focus time, out of office, working
 * location and birthdays are on the calendar, but nobody meets in them.
 */
const MEETING_EVENT_TYPES: readonly string[] = ['default', 'fromGmail'];

/** Whether an event is the kind that can be a meeting. */
export function isMeetingKind(event: GoogleEvent): boolean {
  return MEETING_EVENT_TYPES.includes(event.eventType);
}

/**
 * How the person answered: their own attendee's response. An event with no
 * attendee for them is one they made for themselves, and so is theirs.
 */
export function myResponse(event: GoogleEvent): EventResponse | null {
  return event.attendees.find((attendee) => attendee.self)?.response ?? null;
}

/** The people an event was sent to, other than the person and the rooms. */
export function otherAttendees(event: GoogleEvent): readonly EventAttendee[] {
  return event.attendees.filter((attendee) => !attendee.self && !attendee.resource);
}
