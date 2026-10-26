import {
  compileMeetingListQuery,
  importStanding,
  isArchivedPath,
  MEETING_LIST_LIMIT,
  MeetingMappingError,
  createVaultPath,
  type MeetingFields,
} from '@dfai/domain';
import {
  MeetingPathsTakenError,
  readMeetingSummaryStates,
  receiveMeeting,
  type MeetingSummaryStates,
} from '../meetings/index.ts';
import { listVaultNotes } from '../vault/read-vault.ts';
import { ApiError, messageWithoutPaths } from './api-error.ts';
import type { ApiMeeting } from './contract.ts';
import {
  bodyObject,
  countOf,
  dayParam,
  isRecord,
  offsetOf,
  optionalArray,
  optionalString,
  queryFlag,
  requiredText,
  type Fields,
} from './fields.ts';
import type { RouteResult, VaultRequest } from './vault-request.ts';

const LISTED = { fallback: 50, max: MEETING_LIST_LIMIT };

/**
 * The vault's meetings, newest first, a page at a time (P28-04): every note
 * of the Meeting type, and every meeting file that failed import, with the
 * error the import wrote into it. `since` keeps the ones on or after a day.
 * A duplicate is archived, so it is listed only with `includeArchived`.
 */
export async function meetingsRoute(request: VaultRequest): Promise<RouteResult> {
  const since = dayParam(request.query['since'], 'since');
  const limit = countOf(request.query['limit'], { field: 'limit', ...LISTED });
  const offset = offsetOf(request.query['offset']);
  const includeArchived = queryFlag(request.query['includeArchived'], 'includeArchived');
  // One more than asked for says whether there is another page.
  const { sql, parameters } = compileMeetingListQuery({
    since,
    includeArchived,
    limit: limit + 1,
    offset,
  });
  const found = await request.index.query(sql, parameters).catch((error: unknown) => {
    throw new ApiError(
      'query_failed',
      `The index could not list meetings: ${messageWithoutPaths(error)}`,
    );
  });
  const truncated = found.rows.length > limit;
  const listed = found.rows.slice(0, limit).map(toApiMeeting);
  const summaries = await summaryStatesOf(request, listed);
  // The index and the files answer for the vault open now: one read after a switch is another vault's.
  request.assertStillOpen();
  const meetings = listed.map((meeting) => withSummary(meeting, summaries));
  return {
    status: 200,
    body: { meetings, truncated, next: truncated ? offset + meetings.length : null },
  };
}

/** Where each listed meeting's summary stands, read from its file and the vault's rules; reads only. */
async function summaryStatesOf(
  request: VaultRequest,
  meetings: readonly ListedMeeting[],
): Promise<MeetingSummaryStates> {
  const paths = meetings.flatMap(({ path }) => (path === '' ? [] : [createVaultPath(path)]));
  if (paths.length === 0) return { states: new Map(), pendingWhy: '' };
  return readMeetingSummaryStates({
    fs: request.fs,
    markdown: request.markdown,
    notePaths: await listVaultNotes({ fs: request.fs }),
    paths,
    today: request.clock.today(),
  });
}

/** A meeting with where its summary stands; `none` for one whose file could not be read. */
function withSummary(
  meeting: ListedMeeting,
  { states, pendingWhy }: MeetingSummaryStates,
): ApiMeeting {
  const state =
    meeting.path === '' ? 'none' : (states.get(createVaultPath(meeting.path)) ?? 'none');
  const { archived, ...rest } = meeting;
  return {
    ...rest,
    summary: state,
    ...(state === 'pending' && pendingWhy !== '' && { summaryPendingWhy: pendingWhy }),
    ...(archived === true && { archived }),
  };
}

/** A meeting as the index lists it, before its summary is read. */
type ListedMeeting = Omit<ApiMeeting, 'summary' | 'summaryPendingWhy'>;

/** A row of the list, in `MEETING_LIST_COLUMNS` order, as the API answers it. */
function toApiMeeting(row: readonly unknown[]): ListedMeeting {
  const text = (column: number): string | null => textOrNull(row[column]);
  const path = text(0) ?? '';
  const meeting: ListedMeeting = {
    path,
    title: text(1) ?? '',
    date: text(2),
    start: text(3),
    end: text(4),
    kind: text(5),
    provider: text(6),
    externalId: text(7),
    importOutcome: importStanding({
      path,
      stamped: Boolean(row[11]),
      stamp: row[8],
      declared: Boolean(row[12]),
    }),
    importError: text(9),
    duplicateOf: text(10),
  };
  return isArchivedPath(path) ? { ...meeting, archived: true } : meeting;
}

const textOrNull = (value: unknown): string | null =>
  value === null || value === undefined ? null : String(value);

/**
 * Takes in a meeting another program sends — n8n, in James's setup (#93) —
 * mapped by the rules its workflow's Code nodes run, and written into
 * `Inbox/Meetings/`, where the import settles it as any arrival. The same
 * provider and id already held is answered 200 `in-vault`, and nothing is
 * written; a new file is 201 `written`. A meeting the mapping cannot place in
 * time, or whose file the contract would refuse, is `invalid`, with why.
 */
export async function receiveMeetingRoute(request: VaultRequest): Promise<RouteResult> {
  const body = meetingBody(request.body);
  const fields = meetingFieldsOf(body);
  const options = {
    timeZone: optionalString(body, 'timeZone') ?? request.timeZone,
    // Event notes are on the calendar's clock (ADR-0046), which nothing stores; the Mac's is the
    // nearest one known, and never the sender's.
    calendarTimeZone: request.timeZone,
    groupAddresses: groupAddressesOf(body),
  };
  const receipt = await receiveMeeting({ ports: request, fields, options }).catch(refusedMeeting);
  // A meeting found held is only held in the vault the request was for.
  request.assertStillOpen();
  return { status: receipt.outcome === 'written' ? 201 : 200, body: { meeting: receipt } };
}

/** Every field the route reads; any other is refused, so a misspelt one cannot drop content. */
const MEETING_FIELDS = new Set([
  'provider',
  'sourceId',
  'title',
  'subject',
  'start',
  'end',
  'arrived',
  'attendees',
  'summaryMd',
  'transcriptMd',
  'category',
  'timeZone',
  'groupAddresses',
]);

/**
 * The body, with a null optional field taken as left out — n8n sends null
 * for a field its node has no value for. A key the route does not read is
 * refused rather than ignored: the meeting it sent without that content would
 * be written, and every send after it answered `in-vault`.
 */
function meetingBody(raw: unknown): Fields {
  const body = bodyObject(raw);
  const unknown = Object.keys(body).find((key) => !MEETING_FIELDS.has(key));
  if (unknown !== undefined) {
    throw new ApiError('invalid', `${JSON.stringify(unknown)} is not a field of a meeting`);
  }
  return Object.fromEntries(Object.entries(body).filter(([, value]) => value !== null));
}

/** The request as the mapper's fields: the names n8n's "Meeting fields for DFAI" node gives them. */
function meetingFieldsOf(body: Fields): MeetingFields {
  return {
    source: requiredText(body, 'provider'),
    sourceId: requiredText(body, 'sourceId'),
    title: requiredText(body, 'title'),
    stated: optionalString(body, 'subject'),
    start: optionalString(body, 'start'),
    end: optionalString(body, 'end'),
    arrived: optionalString(body, 'arrived'),
    attendees: attendeesOf(body),
    sections: optionalString(body, 'summaryMd'),
    transcript: optionalString(body, 'transcriptMd'),
    category: optionalString(body, 'category'),
  };
}

/** The attendee records as sent, for the mapper to read as n8n's records are read, once their kinds are checked. */
function attendeesOf(body: Fields): readonly Fields[] | undefined {
  return optionalArray(body, 'attendees')?.map((attendee, at) => {
    if (!isRecord(attendee)) throw new ApiError('invalid', `attendees[${at}] must be an object`);
    const field = `attendees[${at}]`;
    for (const key of ['name', 'email']) {
      const value = attendee[key];
      if (value !== undefined && value !== null && typeof value !== 'string') {
        throw new ApiError('invalid', `${field}.${key} must be a string`);
      }
    }
    if (attendee['group'] !== undefined && typeof attendee['group'] !== 'boolean') {
      throw new ApiError('invalid', `${field}.group must be true or false`);
    }
    return attendee;
  });
}

/** Addresses that are groups though their local part does not say so, as n8n's `OPTIONS` lists them. */
function groupAddressesOf(body: Fields): readonly string[] {
  const addresses = optionalArray(body, 'groupAddresses') ?? [];
  for (const [at, address] of addresses.entries()) {
    if (typeof address !== 'string') {
      throw new ApiError('invalid', `groupAddresses[${at}] must be a string`);
    }
  }
  return addresses as readonly string[];
}

/** Why a meeting was not taken, as the caller is told it. */
function refusedMeeting(error: unknown): never {
  if (error instanceof MeetingMappingError) throw new ApiError('invalid', error.message);
  if (error instanceof MeetingPathsTakenError) throw new ApiError('exists', error.message);
  throw error;
}
