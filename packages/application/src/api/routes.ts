import { ApiError } from './api-error.ts';
import { API_ROUTES, type ApiRequest, type ApiRoute } from './contract.ts';
import { STATUS_HANDLERS } from './handlers/status.ts';
import { NOTE_HANDLERS } from './handlers/notes.ts';
import { SEARCH_HANDLERS } from './handlers/search.ts';
import { TYPE_HANDLERS } from './handlers/types.ts';
import { TEMPLATE_HANDLERS } from './handlers/templates.ts';
import { SKILL_HANDLERS } from './handlers/skills.ts';
import { VIEW_HANDLERS } from './handlers/views.ts';
import { QUERY_HANDLERS } from './handlers/query.ts';
import { CAPTURE_HANDLERS } from './handlers/capture.ts';
import { PROFILE_HANDLERS } from './handlers/profile.ts';
import { SOURCE_HANDLERS } from './handlers/sources.ts';
import { ARTIFACT_HANDLERS } from './handlers/artifacts.ts';
import { TAG_HANDLERS } from './handlers/tags.ts';
import { PEOPLE_HANDLERS } from './handlers/people.ts';
import { ARCHIVE_HANDLERS } from './handlers/archive.ts';
import { INBOX_HANDLERS } from './handlers/inbox.ts';
import { TASK_HANDLERS } from './handlers/tasks.ts';
import { REVIEW_HANDLERS } from './handlers/review.ts';
import { TODAY_HANDLERS } from './handlers/today.ts';
import { ASSISTANT_HANDLERS } from './handlers/assistant.ts';
import { AUTOMATION_HANDLERS } from './handlers/automations.ts';
import { TERM_HANDLERS } from './handlers/terms.ts';
import { MEETING_HANDLERS } from './handlers/meetings.ts';
import { RECEIVED_CAPTURE_HANDLERS } from './handlers/captures.ts';
import { CALENDAR_HANDLERS } from './handlers/calendar.ts';
import { PROPOSAL_HANDLERS } from './handlers/proposals.ts';
import { GRANOLA_HANDLERS } from './handlers/granola.ts';
import type { RouteHandler, RouteKeyOf } from './handlers/route-handler.ts';

/** `GET /v1/status` and so on: one key per route. */
type RouteKey = RouteKeyOf<ApiRoute>;

/**
 * Every route in the contract, and what answers it. Each area keeps its own
 * table (`./handlers/<area>.ts`), keyed by its own routes; this only composes
 * them, keyed by the contract's, so an area left out here is a type error.
 */
const HANDLERS: Readonly<Record<RouteKey, RouteHandler>> = {
  ...STATUS_HANDLERS,
  ...NOTE_HANDLERS,
  ...SEARCH_HANDLERS,
  ...TYPE_HANDLERS,
  ...TEMPLATE_HANDLERS,
  ...SKILL_HANDLERS,
  ...VIEW_HANDLERS,
  ...QUERY_HANDLERS,
  ...CAPTURE_HANDLERS,
  ...PROFILE_HANDLERS,
  ...SOURCE_HANDLERS,
  ...ARTIFACT_HANDLERS,
  ...TAG_HANDLERS,
  ...PEOPLE_HANDLERS,
  ...ARCHIVE_HANDLERS,
  ...INBOX_HANDLERS,
  ...TASK_HANDLERS,
  ...REVIEW_HANDLERS,
  ...TODAY_HANDLERS,
  ...ASSISTANT_HANDLERS,
  ...AUTOMATION_HANDLERS,
  ...TERM_HANDLERS,
  ...MEETING_HANDLERS,
  ...RECEIVED_CAPTURE_HANDLERS,
  ...CALENDAR_HANDLERS,
  ...PROPOSAL_HANDLERS,
  ...GRANOLA_HANDLERS,
};

/** Every route a handler answers, as `METHOD /path`: for the test that holds them to the contract. */
export const HANDLED_ROUTES: readonly string[] = Object.keys(HANDLERS);

/** The segments a route pattern leaves open, and what a request filled them with. */
export interface RouteParams {
  /** The `{path}` segment, still encoded; '' when the route has none. */
  readonly path: string;
  /** The `{name}` segment, still encoded; '' when the route has none. */
  readonly name: string;
  /** The `{tag}` segment, still encoded; '' when the route has none. */
  readonly tag: string;
  /** The `{id}` segment, still encoded; '' when the route has none. */
  readonly id: string;
}

const PARAMS: Readonly<Record<string, keyof RouteParams>> = {
  '{path}': 'path',
  '{name}': 'name',
  '{tag}': 'tag',
  '{id}': 'id',
};

/**
 * The handler for a request, and the open segments it carries.
 *
 * Matched segment by segment on the path as it arrived, still encoded, so a
 * note path is exactly one segment: `Tasks%2FCall.md` is a note, and
 * `Tasks/Call.md` is a route that does not exist. A known path asked for with
 * the wrong method is `not_found_route` too.
 */
export function matchRoute(
  method: ApiRequest['method'],
  path: string,
): { handler: RouteHandler; params: RouteParams; route: RouteKey } {
  const segments = path.split('/');
  for (const route of API_ROUTES) {
    if (route.method !== method) continue;
    const params = matchSegments(route.path.split('/'), segments);
    if (params !== null) {
      const key = keyOf(route);
      return { handler: HANDLERS[key], params, route: key };
    }
  }
  throw new ApiError('not_found_route', `No route for ${method} ${path}`);
}

function keyOf(route: ApiRoute): RouteKey {
  // TypeScript widens a template over a union to every pairing of method and
  // path; each route has exactly one, which is the key the table holds.
  return `${route.method} ${route.path}` as RouteKey;
}

/** The open segments when the pattern matches ('' for those it has none of), else null. */
function matchSegments(
  pattern: readonly string[],
  segments: readonly string[],
): RouteParams | null {
  if (pattern.length !== segments.length) return null;
  const params = { path: '', name: '', tag: '', id: '' };
  for (const [at, expected] of pattern.entries()) {
    const actual = segments[at] ?? '';
    const param = PARAMS[expected];
    if (param !== undefined && actual !== '') params[param] = actual;
    else if (expected !== actual) return null;
  }
  return params;
}
