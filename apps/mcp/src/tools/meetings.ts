/** Meetings: what arrived, and what the import made of each (ADR-0027). */

import { z } from 'zod';
import { defineTool, definedOnly } from './define.ts';
import { includeArchived, limit } from './inputs.ts';

export const meetings = defineTool({
  name: 'atlas_meetings',
  title: 'List meetings',
  description:
    'List meetings, newest first by date and start time: { meetings: [{ path, title, date, ' +
    'start, end, kind, provider, externalId, importOutcome, importError, duplicateOf, summary }], ' +
    'truncated, next }. Meetings arrive as files in Inbox/Meetings/ and DFAI imports each, ' +
    'stamping "importOutcome": imported, duplicate or error; "pending" while a file waits in ' +
    'Inbox/Meetings/ to be imported, null for a meeting elsewhere DFAI never imported. ' +
    '"importError" is non-null for a file that broke the meeting import contract: it says why, ' +
    'the file stays where it landed, and fixing the file (atlas_update_properties or ' +
    'atlas_replace_note_body) makes DFAI import it and clear the error. A second copy of a ' +
    'meeting is archived with "duplicateOf" linking the first, so it is listed only with ' +
    'includeArchived. "summary" says where the summary Claude writes at the top of a meeting ' +
    'stands: "written" (the block is Claude\'s, as written), "edited" (the person changed or ' +
    'removed it), "pending" (the After a meeting rule has yet to write it; "summaryPendingWhy" ' +
    'says why, e.g. Claude Code is not logged in) or "none" (no rule will). The summary is the ' +
    '"> [!summary]" callout at the top of the note; read it with atlas_read_note. ' +
    'A key the file lacks is null. When "next" is a number, pass it as ' +
    '"offset" for the next page. Read a meeting itself with atlas_read_note.',
  inputSchema: z.object({
    since: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .describe('Keep meetings on or after this day, YYYY-MM-DD.'),
    limit: limit.max(500).optional(),
    offset: z.number().int().min(0).optional().describe('How many to skip: a previous "next".'),
    includeArchived: includeArchived.optional(),
  }),
  annotations: { readOnlyHint: true },
  call: (client, input) => client.meetings(definedOnly(input)),
});

export const dayMeetings = defineTool({
  name: 'atlas_day_meetings',
  title: "A day's meetings from Google Calendar",
  description:
    "A day's meetings from Google Calendar, as the Today page lists them, earliest first: " +
    '{ day, meetings: [{ path, title, start, end, people, companies, meeting, unanswered }] }. ' +
    'Each is an event note a meetings sync wrote in Calendar/ (ADR-0046), read from the vault, ' +
    'never from Google, so it answers offline. "start" and "end" are wall-clock HH:MM; "end" is ' +
    'null when the meeting ends another day. Declined and cancelled meetings, and all-day ' +
    'events, are left out. "people" and "companies" are the notes its attendees link; ' +
    '"meeting" is the meeting note it was written up in, or null. "unanswered" is true while ' +
    'the invitation is unanswered or answered maybe. These are calendar events; the meeting ' +
    'notes a notetaker sends are atlas_meetings. Read a note itself with atlas_read_note.',
  inputSchema: z.object({
    day: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .describe('The day, YYYY-MM-DD.'),
  }),
  annotations: { readOnlyHint: true },
  call: (client, input) => client.dayMeetings(input),
});

export const meetingTools = [meetings, dayMeetings];
