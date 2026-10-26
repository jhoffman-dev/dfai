import { planZoneOr, type DayMeeting } from '@dfai/domain';
import { readDayMeetings } from '../google-calendar/read-day-meetings.ts';
import { readPlanZone } from '../settings/plan-zone.ts';
import { ApiError, messageWithoutPaths } from './api-error.ts';
import type { ApiDayMeeting } from './contract.ts';
import { dayParam } from './fields.ts';
import type { RouteResult, VaultRequest } from './vault-request.ts';

/*
 * A day's meetings from Google Calendar through the local API (ADR-0046),
 * read-only: what the Today page lists, from the event notes a meetings sync
 * wrote into the vault. It reads the index, never Google, so it answers on a
 * Mac that is not signed in, and offline. The morning brief (#39) and n8n read it.
 */

/**
 * `GET /v1/calendar/meetings?day=`: the day's meetings, earliest first. `day`
 * is a day on the calendar's clock — the plan zone the event notes are
 * written on (#587), which the answer names as `timeZone` — so a caller on
 * a Mac in another zone asks for the calendar's day, as the brief does.
 */
export async function dayMeetingsRoute(request: VaultRequest): Promise<RouteResult> {
  const day = dayParam(request.query['day'], 'day');
  if (day === null) throw new ApiError('invalid', 'day is required, written YYYY-MM-DD');
  const meetings = await readDayMeetings({ index: request.index, day }).catch((error: unknown) => {
    throw new ApiError(
      'query_failed',
      `The index could not read the day's meetings: ${messageWithoutPaths(error)}`,
    );
  });
  const timeZone = planZoneOr(await readPlanZone(request), request.timeZone);
  request.assertStillOpen();
  return { status: 200, body: { day, timeZone, meetings: meetings.map(toApiDayMeeting) } };
}

function toApiDayMeeting(meeting: DayMeeting): ApiDayMeeting {
  return {
    path: meeting.path,
    title: meeting.title,
    start: meeting.start,
    end: meeting.end,
    people: [...meeting.people],
    companies: [...meeting.companies],
    meeting: meeting.meeting,
    unanswered: meeting.unanswered,
  };
}
