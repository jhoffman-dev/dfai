/**
 * The local API as typed calls: one method per route in the contract.
 *
 * It translates and reports; it decides nothing about notes. Every failure —
 * the app closed, the API off, a timeout, an error body — becomes an
 * `AtlasCallError` whose message is fit to show the model as-is: no stack, and
 * never the token.
 */

import type {
  ApiAssistantMeetings,
  ApiBrief,
  ApiOpenLoops,
  ApiProposedSpec,
  ApiProposedTasks,
  ApiAcceptedProposal,
  ApiDuplicatePair,
  ApiMergePeopleBody,
  ApiPeopleMergePreview,
  ApiPeopleMergeReport,
  ApiAddViewNoteBody,
  ApiAppendBody,
  ApiArchiveBody,
  ApiArchivedNote,
  ApiArchiveOutcome,
  ApiProcessOutcome,
  ApiArtifactFile,
  ApiArtifactFileBody,
  ApiAtlasQueryBody,
  ApiAtlasQueryRows,
  ApiAutomationDryRun,
  ApiAutomationList,
  ApiAutomationLog,
  ApiMeeting,
  ApiCalendar,
  ApiCalendarBody,
  ApiCaptureBody,
  ApiCreateNoteBody,
  ApiErrorBody,
  ApiNote,
  ApiProposal,
  ApiProposalArchived,
  ApiNoteExport,
  ApiImageUpload,
  ApiMoveCardBody,
  ApiNoteImage,
  ApiNoteImageBody,
  ApiNoteSummary,
  ApiProcessInboxBody,
  ApiClarifyInboxBody,
  ApiClarifyOutcome,
  ApiScheduleTaskBody,
  ApiPromoteLineBody,
  ApiProfile,
  ApiQueryBody,
  ApiQuickAddBody,
  ApiQuickAddType,
  ApiRenameTagBody,
  ApiReplaceBodyBody,
  ApiRows,
  ApiRunViewBody,
  ApiSaveArtifactBody,
  ApiSearchHit,
  ApiSetPropertiesBody,
  ApiSourceReport,
  ApiSqlBody,
  ApiStatus,
  ApiTag,
  ApiTaggedNote,
  ApiToday,
  ApiWeeklyReview,
  ApiTagRenamePreview,
  ApiTagRenameReport,
  ApiTemplate,
  ApiTemplateContent,
  ApiTerms,
  ApiInboxItem,
  ApiType,
  ApiTypeView,
  ApiView,
} from '@dfai/application';
import { ConnectionError, type Connection } from './connection.ts';

/** Past the host's own 30 s `timeout`, so its clearer answer normally arrives first. */
export const DEFAULT_TIMEOUT_MS = 35_000;

export const NOT_RUNNING =
  'DFAI is not running — open the app, and turn on the API in Settings → Connections.';

/** A timeout is no answer, not a refusal: the write may be on disk already. */
const MAY_HAVE_LANDED =
  'A write may already have landed: read the note before retrying, or it may be made twice.';

/** A failed call, worded for whoever reads the tool result. */
export class AtlasCallError extends Error {
  override readonly name = 'AtlasCallError';
}

export interface AtlasClientOptions {
  /** Called before every request, so a rotated token or new port is seen at once. */
  readonly connect: () => Promise<Connection>;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH';

interface Call {
  readonly method: Method;
  readonly path: string;
  readonly query?: Readonly<Record<string, string | number | undefined>>;
  readonly body?: unknown;
}

interface Answer {
  readonly status: number;
  readonly body: unknown;
}

export interface SearchQuery {
  readonly q: string;
  readonly limit?: number;
  readonly includeArchived?: boolean;
}

export interface MeetingsQuery {
  readonly since?: string;
  readonly limit?: number;
  readonly offset?: number;
  readonly includeArchived?: boolean;
}

export interface BriefQuery {
  readonly entity: string;
  readonly date?: string;
}

export interface AssistantMeetingsQuery {
  readonly entity: string;
  readonly since?: string;
  readonly until?: string;
  readonly about?: string;
  readonly limit?: number;
}

export interface ArchiveListQuery {
  readonly search?: string;
  readonly limit?: number;
  readonly offset?: number;
}

export interface InboxQuery {
  readonly limit?: number;
  readonly cursor?: string;
}

export interface ExportNoteQuery {
  /** Default `confluence`, as the tool first offered. */
  readonly format?: ApiNoteExport['format'];
  /** `standalone` only: whether the frontmatter stays. The route's default is `keep`. */
  readonly frontmatter?: 'keep' | 'drop';
}

export interface ListNotesQuery {
  readonly folder?: string;
  readonly type?: string;
  /** `YYYY-MM-DD`: only the notes about that day. */
  readonly date?: string;
  readonly limit?: number;
  readonly cursor?: string;
}

/** `Tasks/Call Sam.md` → `/v1/notes/Tasks%2FCall%20Sam.md`: the path is one segment. */
const notePath = (path: string, suffix = '') => `/v1/notes/${encodeURIComponent(path)}${suffix}`;

const isDotSegment = (segment: string) => segment === '.' || segment === '..';

/**
 * A tag as one segment. A tag's `#` is optional, so one of only dots is sent
 * with it: it stays a request of the tag route, which answers that no tag has
 * that name, rather than being refused by {@link routeProblem}.
 */
const tagSegment = (tag: string) => encodeURIComponent(isDotSegment(tag) ? `#${tag}` : tag);

/**
 * Why a route cannot be asked for as built, or null. `new URL` resolves `.`
 * and `..` segments — and encodeURIComponent leaves dots alone — so a path or
 * name of only dots would reach another route than the one named.
 */
function routeProblem(path: string): string | null {
  const dots = path.split('/').find(isDotSegment);
  return dots === undefined ? null : `A path or name of "${dots}" names no note or file.`;
}

export class AtlasClient {
  private readonly options: AtlasClientOptions;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;

  // No parameter properties: `node src/main.ts` runs this file with type stripping alone.
  constructor(options: AtlasClientOptions) {
    this.options = options;
    this.fetchFn = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  status = () => this.json<ApiStatus>({ method: 'GET', path: '/v1/status' });

  listNotes = (query: ListNotesQuery) =>
    this.json<{ notes: readonly ApiNoteSummary[]; next: string | null; total: number }>({
      method: 'GET',
      path: '/v1/notes',
      query: { ...query },
    });

  createNote = (body: ApiCreateNoteBody) =>
    this.json<{ note: ApiNote }>({ method: 'POST', path: '/v1/notes', body });

  readNote = (path: string) =>
    this.json<{ note: ApiNote }>({ method: 'GET', path: notePath(path) });

  setProperties = (path: string, body: ApiSetPropertiesBody) =>
    this.json<{ note: ApiNote }>({ method: 'PATCH', path: notePath(path, '/properties'), body });

  append = (path: string, body: ApiAppendBody) =>
    this.json<{ note: ApiNote }>({ method: 'POST', path: notePath(path, '/append'), body });

  promoteChecklistLine = (path: string, body: ApiPromoteLineBody) =>
    this.json<{ note: ApiNote; task: ApiNote }>({
      method: 'POST',
      path: notePath(path, '/promote'),
      body,
    });

  replaceBody = (path: string, body: ApiReplaceBodyBody) =>
    this.json<{ note: ApiNote }>({ method: 'PUT', path: notePath(path, '/body'), body });

  backlinks = (path: string, query: { limit?: number; cursor?: string } = {}) =>
    this.json<{ backlinks: readonly ApiNoteSummary[]; next: string | null; total: number }>({
      method: 'GET',
      path: notePath(path, '/backlinks'),
      query: { ...query },
    });

  exportNote = (path: string, { format = 'confluence', frontmatter }: ExportNoteQuery = {}) =>
    this.json<{ export: ApiNoteExport }>({
      method: 'GET',
      path: notePath(path, '/export'),
      query: { format, frontmatter },
    });

  search = ({ q, limit, includeArchived }: SearchQuery) =>
    this.json<{ hits: readonly ApiSearchHit[] }>({
      method: 'GET',
      path: '/v1/search',
      query: { q, limit, includeArchived: includeArchived === true ? 'true' : undefined },
    });

  types = () => this.json<{ types: readonly ApiType[] }>({ method: 'GET', path: '/v1/types' });

  typeViews = (name: string, query: { limit?: number; offset?: number } = {}) =>
    this.json<{
      type: string;
      views: readonly ApiTypeView[];
      total: number;
      next: number | null;
    }>({
      method: 'GET',
      path: `/v1/types/${encodeURIComponent(name)}/views`,
      query: { ...query },
    });

  templates = () =>
    this.json<{ templates: readonly ApiTemplate[]; typesWithoutTemplate: readonly string[] }>({
      method: 'GET',
      path: '/v1/templates',
    });

  template = (name: string) =>
    this.json<{ template: ApiTemplateContent }>({
      method: 'GET',
      path: `/v1/templates/${encodeURIComponent(name)}`,
    });

  terms = () => this.json<ApiTerms>({ method: 'GET', path: '/v1/terms' });

  views = () => this.json<{ views: readonly ApiView[] }>({ method: 'GET', path: '/v1/views' });

  runView = (path: string, body?: ApiRunViewBody) =>
    this.json<ApiAtlasQueryRows | { widgets: readonly unknown[] }>({
      method: 'POST',
      path: `/v1/views/${encodeURIComponent(path)}/run`,
      body,
    });

  query = (body: ApiQueryBody) => this.json<ApiRows>({ method: 'POST', path: '/v1/query', body });

  sql = (body: ApiSqlBody) => this.json<ApiRows>({ method: 'POST', path: '/v1/sql', body });

  atlasQuery = (body: ApiAtlasQueryBody) =>
    this.json<ApiAtlasQueryRows>({ method: 'POST', path: '/v1/atlas-query', body });

  /** Today's daily note; `created` is true when this call made it (201). */
  daily = async (): Promise<{ note: ApiNote; created: boolean }> => {
    const answer = await this.send({ method: 'POST', path: '/v1/daily' });
    return { ...(answer.body as { note: ApiNote }), created: answer.status === 201 };
  };

  capture = (body: ApiCaptureBody) =>
    this.json<{ note: ApiNote }>({ method: 'POST', path: '/v1/capture', body });

  saveArtifact = (body: ApiSaveArtifactBody) =>
    this.json<{ note: ApiNote }>({ method: 'POST', path: '/v1/artifacts', body });

  /** Pictures an artifact's saved copy as its thumbnail, once every file of it is in. */
  artifactThumbnail = (path: string) =>
    this.json<{ note: ApiNote }>({
      method: 'POST',
      path: `/v1/artifacts/${encodeURIComponent(path)}/thumbnail`,
    });

  /** One chunk of a file in an artifact's saved copy; `name` is relative to the copy. */
  writeArtifactFile = (path: string, name: string, body: ApiArtifactFileBody) =>
    this.json<{ file: ApiArtifactFile }>({
      method: 'PUT',
      path: `/v1/artifacts/${encodeURIComponent(path)}/files/${encodeURIComponent(name)}`,
      body,
    });

  /** One chunk of an image for a note; `name` is the file's own name, no folder. */
  writeNoteImage = (path: string, name: string, body: ApiNoteImageBody) =>
    this.json<{ image: ApiNoteImage } | { upload: ApiImageUpload }>({
      method: 'PUT',
      path: notePath(path, `/images/${encodeURIComponent(name)}`),
      body,
    });

  quickAddTypes = () =>
    this.json<{ types: readonly ApiQuickAddType[] }>({ method: 'GET', path: '/v1/quick-add' });

  profile = () => this.json<{ profile: ApiProfile }>({ method: 'GET', path: '/v1/profile' });

  quickAdd = (body: ApiQuickAddBody) =>
    this.json<{ note: ApiNote }>({ method: 'POST', path: '/v1/quick-add', body });

  calendar = (path: string, body: ApiCalendarBody) =>
    this.json<ApiCalendar>({
      method: 'POST',
      path: `/v1/views/${encodeURIComponent(path)}/calendar`,
      body,
    });

  moveCard = (path: string, body: ApiMoveCardBody) =>
    this.json<{ note: ApiNote; moved: boolean }>({
      method: 'POST',
      path: `/v1/views/${encodeURIComponent(path)}/move`,
      body,
    });

  addViewNote = (path: string, body: ApiAddViewNoteBody) =>
    this.json<{ note: ApiNote }>({
      method: 'POST',
      path: `/v1/views/${encodeURIComponent(path)}/notes`,
      body,
    });

  refreshSource = (path: string) =>
    this.json<{ report: ApiSourceReport }>({
      method: 'POST',
      path: `/v1/sources/${encodeURIComponent(path)}/refresh`,
    });

  tags = (sort?: 'name' | 'frequency') =>
    this.json<{ tags: readonly ApiTag[] }>({ method: 'GET', path: '/v1/tags', query: { sort } });

  taggedNotes = (tag: string, query: { limit?: number; cursor?: string }) =>
    this.json<{
      tag: ApiTag;
      notes: readonly ApiTaggedNote[];
      next: string | null;
      total: number;
    }>({
      method: 'GET',
      path: `/v1/tags/${tagSegment(tag)}/notes`,
      query: { ...query },
    });

  renameTag = (tag: string, body: ApiRenameTagBody) =>
    this.json<{ rename: ApiTagRenamePreview; report?: ApiTagRenameReport }>({
      method: 'POST',
      path: `/v1/tags/${tagSegment(tag)}/rename`,
      body,
    });

  duplicatePeople = () =>
    this.json<{ pairs: readonly ApiDuplicatePair[] }>({
      method: 'GET',
      path: '/v1/people/duplicates',
    });

  mergePeople = (body: ApiMergePeopleBody) =>
    this.json<{ merge: ApiPeopleMergePreview; report?: ApiPeopleMergeReport }>({
      method: 'POST',
      path: '/v1/people/merge',
      body,
    });

  archived = (query: ArchiveListQuery) =>
    this.json<{ notes: readonly ApiArchivedNote[]; truncated: boolean; next: number | null }>({
      method: 'GET',
      path: '/v1/archive',
      query: { ...query },
    });

  archive = (body: ApiArchiveBody) =>
    this.json<ApiArchiveOutcome>({ method: 'POST', path: '/v1/archive', body });

  unarchive = (body: ApiArchiveBody) =>
    this.json<ApiArchiveOutcome>({ method: 'POST', path: '/v1/unarchive', body });

  meetings = ({ includeArchived, ...query }: MeetingsQuery) =>
    this.json<{ meetings: readonly ApiMeeting[]; truncated: boolean; next: number | null }>({
      method: 'GET',
      path: '/v1/meetings',
      query: { ...query, includeArchived: includeArchived === true ? 'true' : undefined },
    });
  inbox = (query: InboxQuery = {}) =>
    this.json<{
      items: readonly ApiInboxItem[];
      truncated: boolean;
      next: string | null;
      total: number;
    }>({
      method: 'GET',
      path: '/v1/inbox',
      query: { ...query },
    });

  processInbox = (body: ApiProcessInboxBody) =>
    this.json<ApiProcessOutcome>({ method: 'POST', path: '/v1/inbox/process', body });

  clarifyInbox = (body: ApiClarifyInboxBody) =>
    this.json<ApiClarifyOutcome>({ method: 'POST', path: '/v1/inbox/clarify', body });

  scheduleTask = (body: ApiScheduleTaskBody) =>
    this.json<{ note: ApiNote }>({ method: 'POST', path: '/v1/tasks/schedule', body });
  weeklyReview = () =>
    this.json<{ review: ApiWeeklyReview }>({ method: 'GET', path: '/v1/review/weekly' });

  today = () => this.json<{ today: ApiToday }>({ method: 'GET', path: '/v1/today' });

  brief = (query: BriefQuery) =>
    this.json<{ brief: ApiBrief }>({
      method: 'GET',
      path: '/v1/assistant/brief',
      query: { ...query },
    });

  openLoops = (entity: string) =>
    this.json<{ openLoops: ApiOpenLoops }>({
      method: 'GET',
      path: '/v1/assistant/open-loops',
      query: { entity },
    });

  assistantMeetings = (query: AssistantMeetingsQuery) =>
    this.json<{ meetingQuotes: ApiAssistantMeetings }>({
      method: 'GET',
      path: '/v1/assistant/meetings',
      query: { ...query },
    });

  proposeTasks = (meeting: string) =>
    this.json<
      { proposedTasks: ApiProposedTasks } | { proposingTasks: { meeting: string; running: true } }
    >({ method: 'POST', path: '/v1/assistant/propose-tasks', body: { meeting } });

  makeDashboard = (spec: Readonly<Record<string, unknown>>) =>
    this.json<{ proposedSpec: ApiProposedSpec }>({
      method: 'POST',
      path: '/v1/assistant/make-dashboard',
      body: { spec },
    });

  automations = () => this.json<ApiAutomationList>({ method: 'GET', path: '/v1/automations' });

  proposals = () =>
    this.json<{
      proposals: readonly ApiProposal[];
      stranded: readonly { path: string; headline: string; state: 'accepted' | 'rejected' }[];
      unreadable: readonly { path: string; problem: string }[];
    }>({ method: 'GET', path: '/v1/proposals' });

  acceptProposal = (path: string) =>
    this.json<{ accepted: ApiAcceptedProposal }>({
      method: 'POST',
      path: `/v1/proposals/${encodeURIComponent(path)}/accept`,
    });

  rejectProposal = (path: string) =>
    this.json<{ rejected: ApiProposalArchived }>({
      method: 'POST',
      path: `/v1/proposals/${encodeURIComponent(path)}/reject`,
    });

  automationLog = (id: string, query: { limit?: number }) =>
    this.json<ApiAutomationLog>({
      method: 'GET',
      path: `/v1/automations/${encodeURIComponent(id)}/log`,
      query: { ...query },
    });

  automationDryRun = (id: string) =>
    this.json<ApiAutomationDryRun>({
      method: 'POST',
      path: `/v1/automations/${encodeURIComponent(id)}/dry-run`,
    });

  private async json<T>(call: Call): Promise<T> {
    return (await this.send(call)).body as T;
  }

  /**
   * One request, retried once on 401 if the connection has changed since —
   * the token was rotated, or the app restarted on another port, between the
   * read and the request.
   */
  private async send(call: Call): Promise<Answer> {
    const problem = routeProblem(call.path);
    if (problem !== null) throw new AtlasCallError(problem);
    const connection = await this.connect();
    const answer = await this.attempt(connection, call);
    if (answer.status !== 401) return settle(answer);
    const fresh = await this.connect();
    if (fresh.token === connection.token && fresh.baseUrl === connection.baseUrl) {
      return settle(answer);
    }
    return settle(await this.attempt(fresh, call));
  }

  private async connect(): Promise<Connection> {
    try {
      return await this.options.connect();
    } catch (error) {
      if (error instanceof ConnectionError) throw new AtlasCallError(error.message);
      throw error;
    }
  }

  private async attempt(connection: Connection, call: Call): Promise<Answer> {
    try {
      // The timeout covers the body as well as the headers: a stalled stream is still no answer.
      const response = await this.fetchFn(requestUrl(connection, call), {
        method: call.method,
        headers: requestHeaders(connection, call),
        body: call.body === undefined ? null : JSON.stringify(call.body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      return { status: response.status, body: await readBody(response) };
    } catch (error) {
      throw new AtlasCallError(networkFailure(error, connection, this.timeoutMs));
    }
  }
}

function requestUrl(connection: Connection, call: Call): string {
  const url = new URL(connection.baseUrl + call.path);
  for (const [key, value] of Object.entries(call.query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  return url.toString();
}

function requestHeaders(connection: Connection, call: Call): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${connection.token}`,
    Accept: 'application/json',
  };
  if (call.body !== undefined) headers['Content-Type'] = 'application/json';
  return headers;
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text === '') return null;
  try {
    return JSON.parse(text);
  } catch {
    // Not JSON: `settle` reports it by status, which says more than a parse error would.
    return undefined;
  }
}

function settle(answer: Answer): Answer {
  if (answer.status >= 200 && answer.status < 300 && answer.body !== undefined) return answer;
  if (isErrorBody(answer.body)) {
    const { code, message, problems } = answer.body.error;
    // A refused spec's problems go to the caller whole, each where it is, to fix and send again.
    const listed = problems === undefined ? '' : `\nproblems: ${JSON.stringify(problems)}`;
    throw new AtlasCallError(`${code}: ${message}${hintFor(code)}${listed}`);
  }
  throw new AtlasCallError(`DFAI answered ${answer.status} with a body this server cannot read.`);
}

function hintFor(code: string): string {
  if (code === 'unauthorized') {
    return ' The token in the connection file was refused; check Settings → Connections.';
  }
  if (code === 'timeout') return `. ${MAY_HAVE_LANDED}`;
  return '';
}

function isErrorBody(body: unknown): body is ApiErrorBody {
  if (typeof body !== 'object' || body === null || !('error' in body)) return false;
  const { error } = body;
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string' &&
    'message' in error &&
    typeof error.message === 'string'
  );
}

function networkFailure(error: unknown, connection: Connection, timeoutMs: number): string {
  if (error instanceof DOMException && error.name === 'TimeoutError') {
    return `DFAI did not answer within ${timeoutMs / 1000} s. ${MAY_HAVE_LANDED}`;
  }
  const code = causeCode(error);
  if (code === 'ECONNREFUSED') return NOT_RUNNING;
  return `Could not reach DFAI at ${connection.baseUrl} (${code ?? 'network error'}).`;
}

/** Undici puts the socket error's code on `cause`. */
function causeCode(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const { cause } = error;
  if (typeof cause !== 'object' || cause === null || !('code' in cause)) return undefined;
  return typeof cause.code === 'string' ? cause.code : undefined;
}
