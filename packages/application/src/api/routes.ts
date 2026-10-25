import { ApiError } from './api-error.ts';
import { archiveListRoute, archiveRoute, unarchiveRoute } from './archive.ts';
import { assistantMeetingsRoute, briefRoute, openLoopsRoute } from './assistant.ts';
import { makeDashboardRoute, proposeTasksRoute } from './assistant-proposals.ts';
import { atlasQueryRoute } from './atlas-query.ts';
import { automationDryRunRoute, automationLogRoute, automationsRoute } from './automations.ts';
import { API_ROUTES, type ApiRequest, type ApiRoute } from './contract.ts';
import { artifactFileRoute, artifactThumbnailRoute, saveArtifactRoute } from './artifacts.ts';
import { calendarRoute } from './calendar.ts';
import { promoteLineRoute } from './checklists.ts';
import { captureRoute, dailyRoute } from './daily.ts';
import { noteImageRoute } from './images.ts';
import { meetingsRoute, receiveMeetingRoute } from './meetings.ts';
import { inboxRoute, processInboxRoute } from './inbox.ts';
import { clarifyInboxRoute } from './inbox-clarify.ts';
import { todayRoute, weeklyReviewRoute } from './review.ts';
import { createNoteRoute } from './notes-create.ts';
import { duplicatesRoute, mergePeopleRoute } from './people.ts';
import { exportNoteRoute } from './notes-export.ts';
import { backlinksRoute, listNotes, readNoteRoute } from './notes-read.ts';
import { appendRoute, replaceBodyRoute, setPropertiesRoute } from './notes-write.ts';
import type { ApiRouterDeps } from './ports.ts';
import { profileRoute } from './profile.ts';
import { acceptProposalRoute, proposalsRoute, rejectProposalRoute } from './proposals.ts';
import { queryRoute, sqlRoute } from './query.ts';
import { quickAddRoute, quickAddTypesRoute } from './quick-add.ts';
import { searchRoute } from './search.ts';
import { scheduleTaskRoute } from './schedule-task.ts';
import { refreshSourceRoute } from './sources.ts';
import { statusRoute } from './status.ts';
import { renameTagRoute, taggedNotesRoute, tagsRoute } from './tags.ts';
import { templateRoute, templatesRoute } from './templates.ts';
import { termsRoute } from './terms.ts';
import { typeViewsRoute } from './type-views.ts';
import { typesRoute } from './types.ts';
import { addViewNoteRoute, moveCardRoute } from './view-cards.ts';
import { runViewRoute, viewsRoute } from './views.ts';
import type { RouteResult, VaultHandler } from './vault-request.ts';

/** `GET /v1/status` and so on: one key per route, distributed over the union. */
type RouteKey = ApiRoute extends infer Route
  ? Route extends ApiRoute
    ? `${Route['method']} ${Route['path']}`
    : never
  : never;

type RouteHandler =
  | { readonly needsVault: false; readonly handle: (deps: ApiRouterDeps) => Promise<RouteResult> }
  | {
      readonly needsVault: true;
      readonly handle: VaultHandler;
      /**
       * Whether an answer is a write worth a line in the Activity log (U-28):
       * absent for a route that only reads, even one asked with POST.
       */
      readonly wrote?: (answer: RouteResult) => boolean;
    };

const vaultRoute = (handle: VaultHandler): RouteHandler => ({ needsVault: true, handle });

/** A route that writes to the vault: every answer it gives is a write, unless `wrote` says which. */
const vaultWrite = (
  handle: VaultHandler,
  wrote: (answer: RouteResult) => boolean = () => true,
): RouteHandler => ({ needsVault: true, handle, wrote });

/** An upload's last chunk, or a whole image, is answered 201; the chunks before it are not the write. */
const created = (answer: RouteResult) => answer.status === 201;

/** A card that left a group, not one asked into the group it was already in. */
const moved = (answer: RouteResult) => 'moved' in answer.body && answer.body.moved;

/** A rename or a merge, not the preview a `dryRun` (or no `confirm`) asks for. */
const renamed = (answer: RouteResult) => 'report' in answer.body;

/**
 * Every route in the contract, and what answers it. Keyed by the contract's own
 * routes, so a route added there without a handler here is a type error.
 */
const HANDLERS: Readonly<Record<RouteKey, RouteHandler>> = {
  'GET /v1/status': { needsVault: false, handle: statusRoute },
  'GET /v1/notes': vaultRoute(listNotes),
  'POST /v1/notes': vaultWrite(createNoteRoute),
  'GET /v1/notes/{path}': vaultRoute(readNoteRoute),
  'PATCH /v1/notes/{path}/properties': vaultWrite(setPropertiesRoute),
  'POST /v1/notes/{path}/append': vaultWrite(appendRoute),
  'PUT /v1/notes/{path}/body': vaultWrite(replaceBodyRoute),
  'GET /v1/notes/{path}/backlinks': vaultRoute(backlinksRoute),
  'POST /v1/notes/{path}/promote': vaultWrite(promoteLineRoute),
  'GET /v1/notes/{path}/export': vaultRoute(exportNoteRoute),
  'PUT /v1/notes/{path}/images/{name}': vaultWrite(noteImageRoute, created),
  'GET /v1/search': vaultRoute(searchRoute),
  'GET /v1/types': vaultRoute(typesRoute),
  'GET /v1/types/{name}/views': vaultRoute(typeViewsRoute),
  'GET /v1/templates': vaultRoute(templatesRoute),
  'GET /v1/templates/{name}': vaultRoute(templateRoute),
  'GET /v1/views': vaultRoute(viewsRoute),
  'POST /v1/views/{path}/run': vaultRoute(runViewRoute),
  'POST /v1/views/{path}/calendar': vaultRoute(calendarRoute),
  'POST /v1/views/{path}/move': vaultWrite(moveCardRoute, moved),
  'POST /v1/views/{path}/notes': vaultWrite(addViewNoteRoute),
  'POST /v1/query': vaultRoute(queryRoute),
  'POST /v1/sql': vaultRoute(sqlRoute),
  'POST /v1/atlas-query': vaultRoute(atlasQueryRoute),
  'POST /v1/daily': vaultWrite(dailyRoute, created),
  'POST /v1/capture': vaultWrite(captureRoute),
  'GET /v1/quick-add': vaultRoute(quickAddTypesRoute),
  'POST /v1/quick-add': vaultWrite(quickAddRoute),
  'GET /v1/profile': vaultRoute(profileRoute),
  'POST /v1/sources/{path}/refresh': vaultRoute(refreshSourceRoute),
  'POST /v1/artifacts': vaultWrite(saveArtifactRoute),
  'PUT /v1/artifacts/{path}/files/{name}': vaultRoute(artifactFileRoute),
  'POST /v1/artifacts/{path}/thumbnail': vaultRoute(artifactThumbnailRoute),
  'GET /v1/tags': vaultRoute(tagsRoute),
  'GET /v1/tags/{tag}/notes': vaultRoute(taggedNotesRoute),
  'POST /v1/tags/{tag}/rename': vaultWrite(renameTagRoute, renamed),
  'GET /v1/people/duplicates': vaultRoute(duplicatesRoute),
  'POST /v1/people/merge': vaultWrite(mergePeopleRoute, renamed),
  'GET /v1/archive': vaultRoute(archiveListRoute),
  'POST /v1/archive': vaultWrite(archiveRoute),
  'POST /v1/unarchive': vaultWrite(unarchiveRoute),
  'GET /v1/inbox': vaultRoute(inboxRoute),
  'POST /v1/inbox/process': vaultWrite(processInboxRoute),
  'POST /v1/inbox/clarify': vaultWrite(clarifyInboxRoute),
  'POST /v1/tasks/schedule': vaultWrite(scheduleTaskRoute),
  'GET /v1/review/weekly': vaultRoute(weeklyReviewRoute),
  'GET /v1/assistant/brief': vaultRoute(briefRoute),
  'GET /v1/assistant/open-loops': vaultRoute(openLoopsRoute),
  'GET /v1/assistant/meetings': vaultRoute(assistantMeetingsRoute),
  'POST /v1/assistant/propose-tasks': vaultWrite(proposeTasksRoute),
  'POST /v1/assistant/make-dashboard': vaultWrite(makeDashboardRoute, (answer) =>
    'proposedSpec' in answer.body ? answer.body.proposedSpec.proposal !== null : false,
  ),
  'GET /v1/today': vaultRoute(todayRoute),
  'GET /v1/automations': vaultRoute(automationsRoute),
  'GET /v1/automations/{id}/log': vaultRoute(automationLogRoute),
  'POST /v1/automations/{id}/dry-run': vaultRoute(automationDryRunRoute),
  'GET /v1/terms': vaultRoute(termsRoute),
  'GET /v1/meetings': vaultRoute(meetingsRoute),
  'POST /v1/meetings': vaultWrite(receiveMeetingRoute, created),
  'GET /v1/proposals': vaultRoute(proposalsRoute),
  'POST /v1/proposals/{path}/accept': vaultWrite(acceptProposalRoute),
  'POST /v1/proposals/{path}/reject': vaultWrite(rejectProposalRoute),
};

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
