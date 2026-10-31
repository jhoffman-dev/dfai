/**
 * The local API's contract for a day's meetings from Google Calendar.
 *
 * One area of `../contract.ts`, which composes every area's routes and
 * answers. Everything here is data. No behaviour belongs in this file.
 */

/**
 * A meeting on a day, from the event note a Google Calendar meetings sync
 * wrote (ADR-0046), as the Today page lists it. Declined and cancelled
 * meetings, and all-day events, are left out.
 */
export interface ApiDayMeeting {
  /** The event note, vault-relative. */
  readonly path: string;
  readonly title: string;
  /** `HH:MM` on the wall clock the note was written in. */
  readonly start: string;
  /** `HH:MM`, or null when it ends another day or gives no end. */
  readonly end: string | null;
  /** The People notes its attendees are linked to. */
  readonly people: readonly string[];
  readonly companies: readonly string[];
  /** The meeting note it was written up in, once there is one. */
  readonly meeting: string | null;
  /** The person has not answered the invitation yet, or said maybe. */
  readonly unanswered: boolean;
}

/** What the routes for a day's meetings from Google Calendar answer with. */
export type ApiCalendarSuccessBody = {
  readonly day: string;
  /** The zone `day` and each start and end are on: the plan zone the vault keeps, else the Mac's (#587). */
  readonly timeZone: string;
  readonly meetings: readonly ApiDayMeeting[];
};

/** The routes for a day's meetings from Google Calendar. */
export const CALENDAR_ROUTES = [
  {
    method: 'GET',
    path: '/v1/calendar/meetings',
    summary:
      "A day's meetings from Google Calendar, as Today lists them, from the event notes in Calendar/. Query: day, on the calendar's clock (the answer's timeZone).",
  },
] as const;
