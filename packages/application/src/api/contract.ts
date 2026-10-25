/**
 * The local API, as types.
 *
 * Three things are built against this file at once: the router that answers
 * requests inside the app (`./router.ts`), the Rust host that receives them on
 * localhost and forwards them here (`apps/desktop/src-tauri/src/api.rs`), and
 * the MCP server that other tools start and that speaks this API on their
 * behalf (`apps/mcp`). Keeping the contract in one typed place means a mismatch
 * between them is a type error rather than a surprise. ADR-0016 says why it is
 * shaped this way; `vault/docs/api/v1.md` says the same for people.
 *
 * Everything here is data. No behaviour belongs in this file.
 */

import type {
  DoneAction,
  ExportDropKind,
  FilterOperator,
  NoteEvent,
  RunTrigger,
  SetValue,
} from '@dfai/domain';

/** Every path the API serves starts with this. A breaking change gets `/v2`. */
export const API_VERSION_PREFIX = '/v1';

// ---------------------------------------------------------------------------
// The bridge: how the Rust host hands a request to the app and gets an answer.
// ---------------------------------------------------------------------------

/**
 * One HTTP request, after the host has checked it is allowed to exist at all.
 *
 * The host authenticates and forwards; it decides nothing about what the
 * request means (ADR-0005). By the time a request looks like this, the token,
 * the Host header, the absence of an Origin header and the body size have all
 * been checked, so the router never sees a request it would have to refuse on
 * those grounds.
 */
export interface ApiRequest {
  /** Correlates the answer with the request; chosen by the host. */
  readonly id: string;
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** The path after the host, starting with `/v1`, still percent-encoded. */
  readonly path: string;
  /** Query string parameters, decoded. Repeated keys keep the last value. */
  readonly query: Readonly<Record<string, string>>;
  /** The parsed JSON body, or null when there is none. */
  readonly body: unknown;
}

export interface ApiResponse {
  /** Echoes `ApiRequest.id`. */
  readonly id: string;
  readonly status: number;
  /** Serialised to JSON by the host exactly as given. */
  readonly body: ApiSuccessBody | ApiErrorBody;
}

/** The Tauri event the host emits a request on, and the command that answers. */
export const API_REQUEST_EVENT = 'api-request';
export const API_RESPOND_COMMAND = 'api_respond';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Why a request failed, as a word a program can branch on.
 *
 * `message` beside it is for people. Callers should branch on `code`, never on
 * the wording of `message`, which may change.
 */
export type ApiErrorCode =
  /** No token, or the wrong one. Answered by the host. */
  | 'unauthorized'
  /** A browser origin, or a Host header that is not this machine. Answered by the host. */
  | 'forbidden'
  /** The body is larger than the host accepts. Answered by the host. */
  | 'too_large'
  /** The app did not answer in time. Answered by the host. */
  | 'timeout'
  /** No route for this method and path. */
  | 'not_found_route'
  /** The route exists; the note, view or type it names does not. */
  | 'not_found'
  /** The request is well-formed JSON but not a valid request: bad path, unknown operator, missing field. */
  | 'invalid'
  /** `ifModified` did not match: the note changed since the caller read it. */
  | 'conflict'
  /** The note is open in DFAI with unsaved edits, so a body write would clobber them. */
  | 'unsaved_in_app'
  /**
   * A note already exists at the path a create asked for, or a tag rename
   * would merge into a tag in use and was not sent with `merge: true`.
   */
  | 'exists'
  /** No vault is open in DFAI. */
  | 'no_vault'
  /** The SQL was rejected by the read-only connection, or ran past its budget. */
  | 'query_failed'
  /** The artifact's page could not be pictured here — another platform, a page that never loaded. */
  | 'thumbnail_failed'
  /** Anything else. The message says what. */
  | 'internal';

export interface ApiErrorBody {
  readonly error: {
    readonly code: ApiErrorCode;
    readonly message: string;
    /** Seconds to wait before asking again; only on a `conflict` that is over with time. */
    readonly retryAfter?: number;
    /** Where in a DFAI query's text the problem is; only on an `invalid` query. */
    readonly at?: ApiTextPosition;
    /** Everything a checker found wrong with a spec, each where it is; only on an `invalid` spec. */
    readonly problems?: readonly ApiSpecProblem[];
  };
}

/**
 * One thing wrong with a dashboard or view spec (P32-05): `at` is the field
 * or widget (`name`, `widgets[2]`), `message` the checker's own words.
 */
export interface ApiSpecProblem {
  readonly at: string;
  readonly message: string;
}

/**
 * A place in a query's text. `line` and `column` count from 1, columns in
 * characters; `start` and `end` are the offsets (UTF-16 units, as JavaScript
 * indexes a string) of the characters that caused the problem.
 */
export interface ApiTextPosition {
  readonly line: number;
  readonly column: number;
  readonly start: number;
  readonly end: number;
}

/** The HTTP status each error code is answered with. */
export const API_ERROR_STATUS: Readonly<Record<ApiErrorCode, number>> = {
  unauthorized: 401,
  forbidden: 403,
  too_large: 413,
  timeout: 504,
  not_found_route: 404,
  not_found: 404,
  invalid: 400,
  conflict: 409,
  unsaved_in_app: 409,
  exists: 409,
  no_vault: 503,
  query_failed: 422,
  thumbnail_failed: 422,
  internal: 500,
};

// ---------------------------------------------------------------------------
// Shapes returned by the routes
// ---------------------------------------------------------------------------

/** A note as a list entry: enough to choose it, not its contents. */
export interface ApiNoteSummary {
  /** Vault-relative, forward slashes, with the `.md`. The note's identity. */
  readonly path: string;
  readonly title: string;
  /** The `type:` in its frontmatter, or null. */
  readonly type: string | null;
  /**
   * The file's modification time in milliseconds, as the host reports it.
   * Pass it back as `ifModified` to write only if nothing changed in between.
   */
  readonly modified: number;
}

/** A whole note. */
export interface ApiNote extends ApiNoteSummary {
  /** The frontmatter, parsed. Values are whatever YAML made of them. */
  readonly properties: Readonly<Record<string, unknown>>;
  /** Everything after the frontmatter, as markdown, byte for byte. */
  readonly body: string;
}

/** One kind of thing a note's export left out, and each one, as the note writes it. */
export interface ApiExportDrops {
  readonly kind: ExportDropKind;
  /** Once each, in the order the note has them. */
  readonly items: readonly string[];
}

/**
 * `GET /v1/notes/{path}/export`: a note made ready to leave DFAI, by `format`
 * — for a Confluence page (P32-07), or as Markdown (#501). DFAI writes nothing.
 */
export type ApiNoteExport = ApiConfluenceExport | ApiMarkdownExport | ApiStandaloneExport;

/** `format=confluence`: the note as a Confluence page's body. */
export interface ApiConfluenceExport {
  readonly path: string;
  readonly format: 'confluence';
  /** The note's title, as its page shows it: the title for the page. */
  readonly title: string;
  /** The page's body, as markdown: properties left out, links as their words. */
  readonly markdown: string;
  /** Everything left out, by kind. Empty when nothing was. */
  readonly dropped: readonly ApiExportDrops[];
}

/** A picture in the vault an exported note shows, and the name a copy of it goes by. */
export interface ApiExportAttachment {
  /** The picture's vault path, in user space. */
  readonly path: string;
  /** For `markdown`, the file name a copy takes; for `standalone`, the path the Markdown links to. */
  readonly as: string;
}

/** `format=markdown`: the note as it is, and the pictures its own blocks show. */
export interface ApiMarkdownExport {
  readonly path: string;
  readonly format: 'markdown';
  readonly title: string;
  /** The file's text, byte for byte: frontmatter, line endings and a byte-order mark as they are. */
  readonly markdown: string;
  readonly attachments: readonly ApiExportAttachment[];
}

/** `format=standalone`: the note as Markdown that reads without DFAI or the vault. */
export interface ApiStandaloneExport {
  readonly path: string;
  readonly format: 'standalone';
  readonly title: string;
  /**
   * Wiki links as their words, embeds inlined, each picture linked at
   * `attachments/<name>`; the frontmatter kept unless `frontmatter=drop`.
   */
  readonly markdown: string;
  /** Each picture the Markdown links to, `as` the `attachments/<name>` it links to. */
  readonly attachments: readonly ApiExportAttachment[];
  /** Everything left out, by kind. Empty when nothing was. */
  readonly dropped: readonly ApiExportDrops[];
}

export interface ApiStatus {
  readonly app: 'atlas';
  readonly version: string;
  /** The commit the running app was built from, as a short SHA; null when its build did not know. */
  readonly build: string | null;
  /** Null when no vault is open; every other route then answers `no_vault`. */
  readonly vault: { readonly name: string } | null;
  readonly index: { readonly ready: boolean; readonly notes: number };
  /**
   * Whether Google Calendar is connected for the open vault on this Mac;
   * null when no vault is open. Status only: the API never hands out a
   * Google token and makes no calendar call (ADR-0030).
   */
  readonly googleCalendar: { readonly connected: boolean } | null;
}

export interface ApiSearchHit {
  readonly path: string;
  readonly title: string;
  /** The matching text with `<<` and `>>` around the words that matched. */
  readonly snippet: string;
  /** Present, and true, on a hit in the Archive: only when the search asked for `includeArchived`. */
  readonly archived?: true;
}

export interface ApiTypeProperty {
  readonly key: string;
  readonly kind: string;
  readonly label: string;
  readonly required: boolean;
  readonly options: readonly string[];
  /** For a relation: the type it points at — the first, when it may point at several. */
  readonly target: string | null;
  /** For a relation: every type it may point at, `[project, area]`; empty when it names none. */
  readonly targets: readonly string[];
  readonly many: boolean;
}

export interface ApiType {
  readonly name: string;
  readonly label: string;
  readonly properties: readonly ApiTypeProperty[];
}

export interface ApiView {
  /** The view or dashboard note's own path, for `/v1/views/{path}/run`. */
  readonly path: string;
  readonly title: string;
  readonly kind: 'view' | 'dashboard';
  /** For a view: the type it lists. Null for a dashboard. */
  readonly type: string | null;
  /** For a view: table, board, list, gallery, feed, calendar or timeline. */
  readonly layout: string | null;
  /** For a view: the property it groups by — a board's columns, a table's groups. Null for none. */
  readonly groupBy: string | null;
  /** For a view: what each group is split by — a board's swimlanes, a table's sub-groups. */
  readonly subGroupBy: string | null;
  /**
   * For a view: its `order:`, its place among its type's tabs (ADR-0023); null
   * when it was never placed, or for a dashboard. `/v1/types/{name}/views`
   * answers a type's views already in tab order.
   */
  readonly order: number | null;
}

/** One of a type's view tabs, as the type's page shows them (ADR-0023). */
export interface ApiTypeView {
  /** The view's own path, for `/v1/views/{path}/run`; for the virtual default, where it would be written. */
  readonly path: string;
  /** The tab's name: the view's `title:`, else its file name. */
  readonly title: string;
  /** table, board, list, gallery, feed, calendar or timeline. */
  readonly layout: string;
  /** Its `order:`; null when it was never placed (it reads after the placed ones), or virtual. */
  readonly order: number | null;
  /**
   * True for the default table a type with no views shows: not a file yet, so
   * it cannot be run by its path. Run `/v1/query` with the type for its rows.
   */
  readonly virtual: boolean;
}

/**
 * Something that makes notes from a template (ADR-0026): new notes of a type,
 * today's note, captured tasks, or saved artifacts. A template with none is
 * offered only in the New menu, and by name to `POST /v1/notes`.
 */
export type ApiTemplateUse =
  | { readonly kind: 'type'; readonly type: string; readonly label: string }
  | { readonly kind: 'daily' }
  | { readonly kind: 'capture' }
  | { readonly kind: 'artifact' };

/** A template in `.atlas/templates`, as the Templates page lists it. */
export interface ApiTemplate {
  /** Its file name without the extension: what `POST /v1/notes { template }` takes. */
  readonly name: string;
  /** Its file, under `.atlas/templates`. Read-only: the API never writes there. */
  readonly path: string;
  /** What makes notes from it; empty when only the New menu offers it. */
  readonly uses: readonly ApiTemplateUse[];
}

/** A template and what a note made from it starts with. */
export interface ApiTemplateContent extends ApiTemplate {
  /** Its frontmatter, parsed: the properties a new note starts with. */
  readonly properties: Readonly<Record<string, unknown>>;
  /** Everything after the frontmatter, as markdown, byte for byte. */
  readonly body: string;
}

/** Rows, as the index returned them. */
export interface ApiRows {
  readonly columns: readonly string[];
  readonly rows: readonly (readonly unknown[])[];
  /**
   * True when more rows matched than came back: for a query or a view, its
   * limit or the host's row cap cut it short; for SQL, the row cap.
   */
  readonly truncated: boolean;
  /** The SQL that ran, so a caller can read what it asked for. */
  readonly sql: string;
}

/**
 * A group of a DFAI query's rows, as the app groups a list or a table: a
 * select's groups in the type's order, a relation's named for the note, the
 * rows with no value last. A group no row is in is left out.
 */
export interface ApiQueryGroup {
  readonly label: string;
  /** The value its rows hold, or null for the rows with none. */
  readonly value: string | null;
  /** Its rows, as indexes into the answer's `rows`. */
  readonly rows: readonly number[];
  /** The sub-groups (`GROUP BY a THEN b`); empty at the last level. */
  readonly groups: readonly ApiQueryGroup[];
}

/** A DFAI query's answer: its rows, and its groups when it has `GROUP BY`. */
export interface ApiAtlasQueryRows extends ApiRows {
  readonly groups?: readonly ApiQueryGroup[];
}

// ---------------------------------------------------------------------------
// Request bodies
// ---------------------------------------------------------------------------

export interface ApiCreateNoteBody {
  /** Vault-relative folder. Omitted: the vault's root. */
  readonly folder?: string;
  /** The note's name, without `.md`. Omitted: "Untitled", numbered if taken. */
  readonly name?: string;
  /** A template's name from `.atlas/templates`, e.g. "Task". */
  readonly template?: string;
  /** Frontmatter to set on top of the template's. */
  readonly properties?: Readonly<Record<string, unknown>>;
  /** Markdown for the body. Replaces the template's body when given. */
  readonly body?: string;
}

export interface ApiSetPropertiesBody {
  /** Keys to set. A null value removes the key. */
  readonly set: Readonly<Record<string, unknown>>;
  /** Optional: refuse with `conflict` unless the note's `modified` still equals this. */
  readonly ifModified?: number;
}

export interface ApiAppendBody {
  /** Markdown added after the existing body, separated by a blank line. */
  readonly markdown: string;
  readonly ifModified?: number;
}

export interface ApiReplaceBodyBody {
  readonly markdown: string;
  /**
   * Required. A replace without it would be a blind overwrite of whatever the
   * note says now, which is exactly how edits get lost.
   */
  readonly ifModified: number;
}

export interface ApiQueryBody {
  readonly type: string;
  readonly columns?: readonly string[];
  readonly filters?: readonly {
    readonly key: string;
    readonly operator: FilterOperator;
    readonly value?: string | number | boolean | null;
  }[];
  readonly sorts?: readonly { readonly key: string; readonly direction: 'asc' | 'desc' }[];
  readonly limit?: number;
  /** Lists archived notes too. Default false: the Archive is out of the way unless asked for. */
  readonly includeArchived?: boolean;
  /**
   * For a query of tasks: adds a `schedule` column, each task's
   * {@link ApiTaskSchedule} (P31-01). Default false.
   */
  readonly schedule?: boolean;
}

/**
 * A task's schedule, in minutes (P31-01): its estimate (null when it has
 * none), the time its blocks set aside — a one-task block all of itself, a
 * block of several shared by what each has left — what is done (all of the
 * estimate once finished; null with no estimate), and how far the time
 * scheduled runs past the estimate.
 */
export interface ApiTaskSchedule {
  readonly estimate: number | null;
  readonly scheduled: number;
  readonly done: number | null;
  readonly overBy: number;
}

/** A DFAI query (ADR-0019), run read-only against the vault's types and notes. */
export interface ApiAtlasQueryBody {
  /** The query's text, e.g. `FROM task WHERE status != done SORT BY due`. */
  readonly query: string;
  /**
   * At most this many rows, 1 to 5000. The text's own `LIMIT` wins when it is
   * smaller; with neither, 500.
   */
  readonly limit?: number;
  /**
   * The note the query is shown on, as a vault path (`people/Mara Quill.md`):
   * what `this` in the query names. Without it, a query that says `this` is
   * `invalid`; a note the vault does not have is `not_found`.
   */
  readonly context?: string;
}

export interface ApiRunViewBody {
  /** Lists archived notes too, for a saved view. Default false; a dashboard ignores it. */
  readonly includeArchived?: boolean;
}

/**
 * A card moved on a board, as a drag moves it: to a column (`group`), a lane
 * (`subGroup`), or both. A value is a group's `value` as a run answers it;
 * null is "No value".
 */
export interface ApiMoveCardBody {
  /** The card's note, vault-relative, as other routes answer it. */
  readonly note: string;
  readonly group?: string | null;
  readonly subGroup?: string | null;
  /**
   * Refuse with `conflict` unless the note's `modified` still equals this.
   * Required for a move that finishes the task, so a retry cannot finish it twice.
   */
  readonly ifModified?: number;
}

/** A note added inside a view's group, as "+ New" in it adds one. */
export interface ApiAddViewNoteBody {
  /** Omitted or blank: `New <type>`, numbered past any taken. */
  readonly name?: string;
  /** The group it goes in, as a run answers its `value`; null is "No value". */
  readonly group?: string | null;
  /** The sub-group (a board's lane) it goes in. */
  readonly subGroup?: string | null;
}

/**
 * `POST /v1/notes/{path}/promote`: a checklist line of the note to make a task
 * (P30-03), named by its words — and, where two lines say the same, by its
 * place among the note's boxes, counting from 0 in the order they are written,
 * nested ones after the line they are under.
 */
export interface ApiPromoteLineBody {
  /** The line's words as the note writes them, without its box: "Order chairs". */
  readonly text: string;
  /** Its place among the note's boxes; needed only when another line says the same. */
  readonly line?: number;
}

/** Notes to put in the Archive, or take out of it. */
export interface ApiArchiveBody {
  /** Vault-relative note paths, as other routes answer them: 1 to 100 of them. */
  readonly paths: readonly string[];
}

/** A note waiting in the Inbox to be filed, as the Inbox page lists it. */
export interface ApiInboxItem {
  readonly path: string;
  readonly title: string;
  /** Its `type:`, or null for a plain note. */
  readonly type: string | null;
  /** The folder of the Inbox it arrived in — `Meetings` — or '' for the Inbox itself. */
  readonly arrivedIn: string;
  /** What the meeting import made of it: its outcome, `pending` while it waits, null when not a meeting file. */
  readonly importOutcome: 'imported' | 'duplicate' | 'error' | 'pending' | null;
  /** Why it failed the meeting import, or null. */
  readonly importError: string | null;
  /** What it says as a task, which clarifying it starts from; null for a note that is not a task. */
  readonly task: {
    /** One of the eight GTD statuses, or null when it has none or holds something else. */
    readonly status: string | null;
    /** The path of the project or area it is filed under, or null. */
    readonly project: string | null;
    /** The path of the person it waits on, when `waiting_on` links one. */
    readonly waitingOn: string | null;
    /** Who it waits on as written; '' for nobody. */
    readonly waitingOnNames: string;
    /** `YYYY-MM-DD`, or null. */
    readonly defer: string | null;
    /** `YYYY-MM-DD`, or null. */
    readonly due: string | null;
  } | null;
}

/**
 * `POST /v1/inbox/clarify` (#112): one note waiting in the Inbox, and what is
 * decided about it. A key left out is left as the note has it; `null` takes
 * away what it held. Everything is written in one save. The note may be any
 * task the API reaches, not only one `GET /v1/inbox` lists, but never an
 * archived one; a status must be one the vault's Task type declares, and
 * `waitingOn` is written only when the task is, or is being made, `waiting`.
 */
export interface ApiClarifyInboxBody {
  /** The note to clarify: one `GET /v1/inbox` lists, or any other task in use. */
  readonly path: string;
  /** One of inbox, backlog, next-action, in-progress, waiting, someday, longterm, archive. */
  readonly status?: string;
  /** The path of a project or an area to file it under. */
  readonly project?: string;
  /** The path of the person it waits on, if anyone: Waiting never needs one (#202). */
  readonly waitingOn?: string | null;
  /** `YYYY-MM-DD`: the day it comes back into view. */
  readonly defer?: string | null;
  /** `YYYY-MM-DD`. */
  readonly due?: string | null;
  /** Where it can be done; an empty list takes them away. */
  readonly contexts?: readonly string[];
  /** Makes a plain note a task, starting in the Inbox unless `status` is given. */
  readonly asTask?: boolean;
}

/** What clarifying a note did. */
export interface ApiClarifyOutcome {
  /** Where the note is now. */
  readonly path: string;
  /** Where it was, when it was filed under a project; null when it stayed where it is. */
  readonly movedFrom: string | null;
  /** What could not be done once its properties were written: the filing, or a link left behind. */
  readonly failed: ApiArchiveOutcome['failed'];
  /** Links in other notes rewritten so they still open the note where it went. */
  readonly linksUpdated: number;
}

/** `POST /v1/inbox/process`: notes in the Inbox, and the project or area to file them under. */
export interface ApiProcessInboxBody {
  /** Vault-relative paths of notes in the Inbox: 1 to 100 of them. */
  readonly paths: readonly string[];
  /** The path of a project or an area. */
  readonly project: string;
}

/**
 * `POST /v1/tasks/schedule` (P31-02): a block for a task, as a task let go on
 * the calendar's empty time makes one in the app.
 */
export interface ApiScheduleTaskBody {
  /** The task's vault-relative path: a note of type task. */
  readonly task: string;
  /** When the block starts, as local wall-clock time with no offset: `2026-10-12T09:00`. */
  readonly start: string;
  /**
   * How long it runs: whole minutes, 1 to 1440. Omitted: what the task still
   * needs — its estimate less what its blocks already give it — or 30 when it
   * has no estimate or needs nothing more, as the app sizes a dropped task.
   */
  readonly minutes?: number;
}

/** What a batch of archiving, unarchiving or processing the Inbox did. */
export interface ApiArchiveOutcome {
  /** Every note that moved, in the order asked, from where it was to where it went. */
  readonly moves: readonly { readonly from: string; readonly to: string }[];
  /**
   * Each path that did not move, with why — or that moved and was then not
   * fully updated, under where it went — and each note whose links to them
   * could not be rewritten. The rest of the batch carries on. `code` is
   * `unsaved_in_app` for a note left alone because it is open in DFAI with
   * unsaved typing, which the API never saves.
   */
  readonly failed: readonly {
    readonly path: string;
    readonly reason: string;
    readonly code?: 'unsaved_in_app';
  }[];
  /** Links in other notes rewritten so they still open the notes that moved. */
  readonly linksUpdated: number;
}

/** What processing the Inbox did: what moved out of the `Inbox` folder, and what was filed where it is. */
export interface ApiProcessOutcome extends ApiArchiveOutcome {
  /** Notes filed by their `project` link alone, where they live: a meeting in its month's folder (#214). */
  readonly linked: readonly string[];
}

/** A note in the Archive, as the Archive lists it. */
export interface ApiArchivedNote {
  readonly path: string;
  readonly title: string;
  /** Where unarchiving puts it back. */
  readonly from: string;
  /** The day it was archived, `YYYY-MM-DD`, or null when it does not say. */
  readonly archivedOn: string | null;
}

/**
 * A meeting, as its file says (ADR-0027). A file that failed import may lack
 * any of the contract's keys, so each is null when it is not there.
 */
export interface ApiMeeting {
  readonly path: string;
  /** The meeting's own `title`, else the note's name. */
  readonly title: string;
  /** `YYYY-MM-DD`. */
  readonly date: string | null;
  /** Local time, `HH:MM`. */
  readonly start: string | null;
  readonly end: string | null;
  /** What sort of meeting the provider called it: Standup, 1:1… */
  readonly kind: string | null;
  readonly provider: string | null;
  /** The provider's own id for it. */
  readonly externalId: string | null;
  /**
   * How the import settled the file (`atlas_import_outcome`): `imported`,
   * `duplicate` or `error` (a stamp cleared by hand reads `imported`, as the
   * import reads it); `pending` while it waits in `Inbox/Meetings/` for the
   * Mac that imports; null for a meeting elsewhere the import never handled —
   * one filed before DFAI imported meetings, or made by hand.
   */
  readonly importOutcome: 'imported' | 'duplicate' | 'error' | 'pending' | null;
  /** Why it failed the import contract (`atlas_import_error`), or null when it imported. */
  readonly importError: string | null;
  /** The meeting this is a second copy of, as `atlas_duplicate_of` links it (`[[…]]`), or null. */
  readonly duplicateOf: string | null;
  /**
   * Where the summary Claude writes at the top stands (#186): `written` while
   * the block is the one it wrote; `edited` once the person changed it or took
   * it out; `pending` while the "After a meeting" rule has yet to write one;
   * `none` when no rule will (it is off, the meeting was not let in, has no
   * transcript, is older than the rule's 14 days, or was answered already).
   */
  readonly summary: 'written' | 'pending' | 'edited' | 'none';
  /** Why a pending summary waits — the rule's last failure, as its log says it — present only when pending. */
  readonly summaryPendingWhy?: string;
  /** Present, and true, for an archived meeting — only listed with `includeArchived`. */
  readonly archived?: true;
}

/**
 * A meeting as another program sends it (#93), in the shape n8n's workflow
 * assembles: mapped by the same rules its Code nodes run, into a meeting/v1
 * file in `Inbox/Meetings/`.
 */
export interface ApiReceiveMeetingBody {
  /** Who wrote the notes up: `gemini`, `granola`… — lower-case letters, digits and `-`. */
  readonly provider: string;
  /** The provider's own id for the meeting (the notes email's id): with `provider`, its identity. */
  readonly sourceId: string;
  readonly title: string;
  /** The notes email's subject, which states the meeting's day, and time if given. */
  readonly subject?: string;
  /** When the notes arrived, an ISO instant: a start, less the transcript's length, when nothing states one. */
  readonly arrived?: string;
  readonly attendees?: readonly {
    readonly name?: string | null;
    readonly email?: string | null;
  }[];
  /** The notes, with `## Summary`, `## Decisions`, `## Next steps` and `## Details` headings. */
  readonly summaryMd?: string;
  /** The provider's transcript, as it gives it. */
  readonly transcriptMd?: string;
  /** What sort of meeting it was: Standup, 1:1… */
  readonly category?: string;
  /** The IANA zone an instant is read in. Omitted: the zone this Mac keeps time in. */
  readonly timeZone?: string;
}

/**
 * What became of a sent meeting: `written` into `Inbox/Meetings/` at `path`,
 * or already `in-vault` at `path` (the same provider and id), nothing written.
 */
export interface ApiMeetingReceipt {
  readonly path: string;
  readonly outcome: 'written' | 'in-vault';
}

/**
 * A proposal waiting in `Inbox/Proposals/` (P29-02, ADR-0028): what Claude or
 * an automation suggested, and what accepting it would write.
 */
export interface ApiProposal {
  readonly path: string;
  readonly kind:
    | 'task'
    | 'decision'
    | 'follow-up'
    | 'person'
    | 'link'
    | 'term'
    | 'project'
    | 'dashboard'
    | 'view';
  /** What it would do, in one line: a note's title, or `Note · property → [[Link]]`. */
  readonly headline: string;
  readonly confidence: 'high' | 'medium' | 'low' | null;
  /** The block it cites, as a link — `[[2026-10-01 Standup#^t0003]]` — or null when it cites none. */
  readonly source: string | null;
  /** The rule and run that made it. */
  readonly madeBy: string | null;
  /**
   * Why it was proposed, as the proposal's body says it — for a meeting's
   * item, whose it is and how sure that is. Empty when the body is.
   */
  readonly reason: string;
  /** What Accept writes, as the note holds it. */
  readonly payload: Readonly<Record<string, unknown>>;
  readonly modified: number;
}

/** What answering a proposal did to the proposal: archived, or left where it was and why. */
export interface ApiProposalArchived {
  readonly proposal: string;
  /** Where it went in the Archive; null when it could not move (it is decided all the same). */
  readonly archivedAt: string | null;
  readonly archiveProblem: string | null;
}

/** What accepting a proposal wrote. */
export interface ApiAcceptedProposal extends ApiProposalArchived {
  readonly headline: string;
  /** Each note it made (`created`) or changed (`edited`). */
  readonly wrote: readonly { readonly kind: 'created' | 'edited'; readonly path: string }[];
}

export interface ApiSqlBody {
  /** Run on the index's read-only connection, under its row cap and step budget. */
  readonly sql: string;
  readonly params?: readonly (string | number | null)[];
}

export interface ApiCaptureBody {
  /** The task's name, as typed into quick capture. */
  readonly text: string;
}

/** The kinds an artifact can be, as its `kind` property holds them. */
export type ApiArtifactKind = 'page' | 'deck' | 'design' | 'doc' | 'other';

export interface ApiSaveArtifactBody {
  /** What the artifact is called: its note's name, in `artifacts/`, numbered if taken. */
  readonly title: string;
  /** Its claude.ai link, or wherever else it lives. `http` or `https`. */
  readonly url?: string;
  /** Guessed from `html`, then from `url`, when not given. */
  readonly kind?: ApiArtifactKind;
  /** The project it belongs to, by the project note's name. */
  readonly project?: string;
  readonly tags?: readonly string[];
  /**
   * The page, saved as `index.html` in the artifact's own folder. The whole
   * request must fit the host's 1 MiB body cap; a larger page is sent without
   * this, then written in chunks with `PUT /v1/artifacts/{path}/files/index.html`.
   */
  readonly html?: string;
  /** Markdown for the note's body: notes about the artifact. */
  readonly body?: string;
}

/**
 * One chunk of a file in an artifact's saved copy. Exactly one of `text` and
 * `base64`. At `offset` 0 (the default) the file is created, and refused with
 * `exists` if it is there already; past 0 the chunk is added to the end of a
 * file that must be exactly `offset` bytes long, or it is refused with
 * `conflict`, so a retried or reordered chunk can never corrupt it.
 */
export interface ApiArtifactFileBody {
  /** The chunk as text, written as UTF-8. */
  readonly text?: string;
  /** The chunk as standard padded base64, for a picture or a font. */
  readonly base64?: string;
  readonly offset?: number;
}

/** A file of a saved copy, after a chunk was written to it. */
export interface ApiArtifactFile {
  /** Vault-relative, forward slashes. */
  readonly path: string;
  /** Its length in bytes so far: the `offset` for the next chunk. */
  readonly size: number;
}

/**
 * One chunk of an image for a note. Exactly one of `text` and `base64`.
 *
 * An image that fits in one request is sent whole: offset 0, `last` left out
 * or true. It is checked and saved under the name asked for, numbered clear
 * of any file already there, and the answer is `{ image }`.
 *
 * A larger one is staged outside the notes until it is whole: the first
 * chunk (offset 0, `last: false`) answers `{ upload: { id, size } }`; every
 * next chunk carries that `upload` id and the `size` the last answer gave as
 * its `offset`, and the final one says `last: true`. Only then is the whole
 * image checked and moved into place, answering `{ image }`. Nothing in the
 * vault is ever appended to, and an upload given up on leaves no file there.
 */
export interface ApiNoteImageBody {
  /** The chunk as text, written as UTF-8: an SVG. */
  readonly text?: string;
  /** The chunk as standard padded base64. */
  readonly base64?: string;
  /** Where the chunk goes: 0, the default, or the `size` the last answer gave. */
  readonly offset?: number;
  /** The id the first chunk's answer gave; required past offset 0, refused at it. */
  readonly upload?: string;
  /** Whether this chunk ends the image. Default true. */
  readonly last?: boolean;
}

/** An image being staged a chunk at a time, before its last chunk arrives. */
export interface ApiImageUpload {
  /** Send it as `upload` with every next chunk. */
  readonly id: string;
  /** Bytes received so far: the `offset` for the next chunk. */
  readonly size: number;
}

/** An image saved for a note, once it is whole. */
export interface ApiNoteImage {
  /** Vault-relative, forward slashes: where Settings → Images puts a note's images. */
  readonly path: string;
  /** Its length in bytes. */
  readonly size: number;
  /** The image's destination relative to the note, percent-encoded. */
  readonly src: string;
  readonly alt: string;
  /** `![alt](src)`: what the note writes to show it. The note itself is not changed. */
  readonly markdown: string;
}

/** Who uses the vault, as Settings → Profile says. */
export interface ApiProfile {
  /** The full name; null when none is set — then write `placeholder`, never a guess. */
  readonly name: string | null;
  /** What the person goes by; null when none is set. */
  readonly preferredName: string | null;
  /** What to write where the person's name belongs and none is set: `[Your name]`. */
  readonly placeholder: string;
}

/** A type the add button offers, and the fields it asks for beside the name. */
export interface ApiQuickAddType {
  readonly name: string;
  readonly label: string;
  /** Property keys, in the order the add button asks for them (at most three). */
  readonly fields: readonly string[];
}

export interface ApiQuickAddBody {
  /** The type's name, as `/v1/types` gives it. */
  readonly type: string;
  /** The new note's name. Numbered, never refused, when it is taken. */
  readonly name: string;
  /** Properties by key, as typed into the add button's fields: text, stored as each kind does. */
  readonly values?: Readonly<Record<string, string>>;
}

/** The ranges a calendar view shows, as its switcher offers them. */
export type ApiCalendarRange = 'month' | 'week' | '3day' | 'day' | 'agenda';

export interface ApiCalendarBody {
  /** A day in the range, `YYYY-MM-DD`. Omitted: today. */
  readonly anchor?: string;
  /** Omitted: the range the view was saved with. */
  readonly range?: ApiCalendarRange;
  /** For `agenda` only: how many days it lists, 1 to 366. Omitted: 30. */
  readonly days?: number;
}

/** A note on a calendar. Times are wall-clock, as the note writes them. */
export interface ApiCalendarEvent {
  readonly path: string;
  readonly title: string;
  /** `YYYY-MM-DD`, or `YYYY-MM-DDTHH:mm` when the note is on the clock. */
  readonly start: string;
  /** The same, from the view's end property; null when it has none. */
  readonly end: string | null;
  readonly allDay: boolean;
  /** The days of the range the note is on, in order. */
  readonly on: readonly string[];
}

export interface ApiCalendar {
  readonly range: ApiCalendarRange;
  /** Every day the range shows, in order: a month's grid starts on a Monday. */
  readonly days: readonly string[];
  /** Notes on at least one of those days, all-day first, then by start. */
  readonly events: readonly ApiCalendarEvent[];
  /** Notes the view lists that have no readable date, so are on no day. */
  readonly unscheduled: number;
  /** True when the view's limit or the row cap left notes out. */
  readonly truncated: boolean;
}

/** What one refresh of a source did, as the source note's panel reports it. */
export interface ApiSourceReport {
  /** When it ran, in milliseconds since the epoch. */
  readonly ran: number;
  /** The URL or file it read, as the note names it — a secret by its name, never its value. */
  readonly from: string;
  readonly records: number;
  readonly created: number;
  readonly replaced: number;
  readonly updated: number;
  /** Notes whose record is no longer in the feed: marked, never deleted. */
  readonly missing: number;
  readonly unkeyed: number;
  readonly truncated: boolean;
  /** Why the refresh failed, or null. Counts of what landed first still stand. */
  readonly error: string | null;
}

/** One tag in the vault's tree of tags, as the tags page shows it. */
export interface ApiTag {
  /** The whole name, as it was first written: `para/resource`. Its key in `/v1/tags/{tag}`. */
  readonly name: string;
  /** The last part of it, `resource`. */
  readonly label: string;
  /** Uses of this exact tag. A parent only ever written with a child has none. */
  readonly count: number;
  /** Uses of it and of every tag nested under it. */
  readonly total: number;
  readonly children: readonly ApiTag[];
}

/** A note using a tag, or one nested under it. */
export interface ApiTaggedNote {
  readonly path: string;
  readonly title: string;
  /** How many times the note uses the tag and those nested under it. */
  readonly uses: number;
}

export interface ApiRenameTagBody {
  /** The new name, with or without its `#`. Nested parts are separated by `/`. */
  readonly to: string;
  /** True: answer what the rename would change, and write nothing. */
  readonly dryRun?: boolean;
  /**
   * Required when the new name is a tag in use already, or the parent of one:
   * the two become one, and renaming back cannot part them again. The preview's
   * `mergesInto` says so, and it is asked again just before writing.
   */
  readonly merge?: boolean;
}

/** What renaming a tag changes, worked out from the notes themselves. */
export interface ApiTagRenamePreview {
  /** The tag renamed, as the vault spells it. */
  readonly from: string;
  readonly to: string;
  /** How many notes it rewrites. */
  readonly files: number;
  /** How many uses of the tag, and of those nested under it, it rewrites. */
  readonly uses: number;
  /**
   * A tag in use already — or the parent of one — that this one, or one nested
   * under it, would join; null when none.
   */
  readonly mergesInto: string | null;
  /** The notes it rewrites, each with its uses. */
  readonly notes: readonly ApiTaggedNote[];
  /**
   * Notes using the tag that are not rewritten, with why: in `.atlas` or a
   * hidden folder, which the API may not write, or where the new name could
   * not be written so that it reads back as that tag (ADR-0018).
   */
  readonly skipped: readonly { readonly path: string; readonly reason: string }[];
}

/** What a rename did, note by note. */
export interface ApiTagRenameReport {
  readonly updated: readonly string[];
  /** Notes not rewritten, with why: typed in and not yet saved, changed meanwhile, … */
  readonly failed: readonly { readonly path: string; readonly reason: string }[];
}

/** A person, as a possible duplicate names them. */
export interface ApiDuplicatePerson {
  readonly path: string;
  readonly name: string;
}

/** Why two people may be one (#464). */
export type ApiDuplicateReason =
  | { readonly kind: 'same-email'; readonly email: string }
  | { readonly kind: 'same-name' }
  | { readonly kind: 'alias'; readonly alias: string }
  | {
      readonly kind: 'similar-email';
      readonly left: string;
      readonly right: string;
      /** `same` (dots aside), `first-name` (`mara`, `mara.quill`) or `typo`. */
      readonly local: 'same' | 'first-name' | 'typo';
      readonly sameDomain: boolean;
    };

/** Two people who may be one, surest reason first; `left` sorts before `right` by path. */
export interface ApiDuplicatePair {
  readonly left: ApiDuplicatePerson;
  readonly right: ApiDuplicatePerson;
  readonly reasons: readonly ApiDuplicateReason[];
}

export interface ApiMergePeopleBody {
  /** The person to keep. */
  readonly keep: string;
  /** The people merged into them, then put in the Trash. */
  readonly merge: readonly string[];
  /** True: make the merge. Absent or false: answer what it would do, and write nothing. */
  readonly confirm?: boolean;
  /**
   * With `confirm`: the `version` of the preview the caller was shown. The
   * merge is made only while the vault still gives that preview.
   */
  readonly version?: string;
}

/** What merging people would do, worked out from the notes themselves; nothing written. */
export interface ApiPeopleMergePreview {
  readonly keep: string;
  readonly merge: readonly string[];
  /** Why it cannot be done, or null. */
  readonly refusal: string | null;
  /** Each note written, with how many of its links move to the kept person; the kept note last. */
  readonly notes: readonly { readonly path: string; readonly links: number }[];
  /** How many links, in every note, move to the kept person. */
  readonly links: number;
  /** A value the kept note keeps, though a merged note says otherwise. */
  readonly conflicts: readonly {
    readonly key: string;
    readonly kept: unknown;
    readonly other: unknown;
    readonly from: string;
  }[];
  readonly aliasesAdded: readonly string[];
  readonly emailsAdded: readonly string[];
  /** Each merged body added to the kept note, by the heading it goes under. */
  readonly appended: readonly { readonly from: string; readonly heading: string }[];
  /** What this preview was worked out from: send it back with `confirm` to make this merge. */
  readonly version: string;
}

/** What a merge did, file by file: each file changed whole, or left exactly as it was. */
export interface ApiPeopleMergeReport {
  readonly written: readonly string[];
  /** Planned writes not made, because an earlier one failed. */
  readonly notWritten: readonly string[];
  readonly trashed: readonly string[];
  readonly notTrashed: readonly string[];
  readonly failures: readonly {
    readonly path: string;
    readonly step: 'write' | 'trash';
    readonly reason: string;
  }[];
  readonly links: number;
}

/** A term (P28-05): a name's one right spelling, the ways it is misheard, and what it names. */
export interface ApiTerm {
  readonly path: string;
  /** The right spelling: the term's title. */
  readonly canonical: string;
  readonly variants: readonly string[];
  /** `product`, `person`, `company`, `acronym` or `other`; null when the note names none of these. */
  readonly kind: string | null;
}

/** A note's claim that a spelling means its own right spelling. */
export interface ApiVocabularyClaim {
  /** The spelling as that note writes it. */
  readonly form: string;
  /** What that note says it should be spelt as. */
  readonly canonical: string;
  readonly path: string;
  /** A term's variant, or a person's or a company's name or alias. */
  readonly source: 'term' | 'person' | 'company';
}

/** A spelling DFAI puts right, what to, and every note that says so. */
export interface ApiVocabularyEntry {
  readonly form: string;
  readonly canonical: string;
  readonly claims: readonly ApiVocabularyClaim[];
}

/** A spelling two notes claim for two different right spellings: not used until one lets it go. */
export interface ApiVocabularyConflict {
  readonly form: string;
  readonly claims: readonly ApiVocabularyClaim[];
}

/** The vocabulary, as the Terms page reads it. */
export interface ApiTerms {
  readonly terms: readonly ApiTerm[];
  /** Longest spelling first, matched however cased or spaced. */
  readonly vocabulary: readonly ApiVocabularyEntry[];
  readonly conflicts: readonly ApiVocabularyConflict[];
}

/**
 * An automation (P25), as its file says it and as the Automations page lists
 * it. The API reads automations and never runs, undoes or edits one (ADR-0016).
 */
export interface ApiAutomation {
  /** What its log is kept under, and its key in `/v1/automations/{id}`. */
  readonly id: string;
  readonly name: string;
  /** Its file, in `.atlas/automations`. */
  readonly path: string;
  readonly enabled: boolean;
  /**
   * As its file writes it: `daily at 03:00`, `fridays at 15:00`, `every 6 hours`,
   * `on app open`, `manually`, or `a meeting is created or changed`.
   */
  readonly when: string;
  /** The note that sets it off (P29-01), or null for a rule on a clock, on opening or by hand. */
  readonly note: ApiNoteTrigger | null;
  /** The DFAI query naming its notes. */
  readonly which: string;
  /** Only notes not modified in this many days; null for any. */
  readonly olderThanDays: number | null;
  readonly do: 'archive' | 'set' | 'claude';
  /** What a `set` rule sets; null for any other. */
  readonly set: Readonly<Record<string, SetValue>> | null;
  /** What a `claude` rule asks Claude (P29-03); null for any other. */
  readonly claude: ApiClaudeStep | null;
  /** Its schedule in words, as the app shows it: "Every day at 03:00". */
  readonly schedule: string;
  /** Its action in words: "Archive", "Set status to done". */
  readonly action: string;
  /** Its newest run, or null when it has never run. */
  readonly lastRun: ApiAutomationLastRun | null;
  /**
   * When it next runs by itself, local time `YYYY-MM-DDTHH:MM:SS`; null when
   * it is off, paused until run by hand, or runs only on opening or by hand.
   */
  readonly nextRun: string | null;
  /** Why the app's clock is not running it just now, or null. */
  readonly paused: string | null;
}

/** A rule a note sets off: a note of `type` being created, changed, or either. */
export interface ApiNoteTrigger {
  readonly type: string;
  readonly on: readonly NoteEvent[];
}

export interface ApiAutomationLastRun {
  /** Local time, `YYYY-MM-DDTHH:MM:SS`. */
  readonly at: string;
  /** `failed`: its query did not read, so it changed nothing. */
  readonly kind: 'run' | 'failed';
  readonly trigger: RunTrigger;
  /** "Archived 12 notes. Left 1 alone." */
  readonly summary: string;
}

/** A file in `.atlas/automations` that says it is a rule and cannot be read as one. It never runs. */
export interface ApiBrokenAutomation {
  readonly path: string;
  readonly name: string;
  readonly problem: string;
}

/**
 * A rule's Claude step, as its file writes it (P29-03): the prompt note, the
 * read tools it may call, and what it writes — proposals of a schema, or one
 * new note in `folder`. It never edits a note.
 */
export interface ApiClaudeStep {
  /** The prompt note, in `.atlas/prompts/`. */
  readonly prompt: string;
  readonly tools: readonly string[];
  /** `note`, or the name of a proposal schema: `proposals`, or `meeting-items` (what Claude pulls out of a meeting). */
  readonly output: string;
  /** Where its one new note goes, for `output: note`; null otherwise. */
  readonly folder: string | null;
  /** What DFAI hands it beside its notes (#40): `weekly-review`, or null for its notes alone. */
  readonly data: string | null;
}

/** One entry in a rule's log, as its file records it. */
export interface ApiAutomationLogEntry {
  readonly kind: 'run' | 'undo' | 'failed' | 'turnedOn' | 'seen' | 'letGo';
  /** Local time, `YYYY-MM-DDTHH:MM:SS`. */
  readonly at: string;
  /** "Ran on schedule", "Undid the run of …". */
  readonly heading: string;
  /** "Archived 12 notes. Left 1 alone." */
  readonly summary: string;
  /** What started a run; on `run` and `failed` only. */
  readonly trigger?: RunTrigger;
  /** When the run an `undo` undid ran. */
  readonly of?: string;
  /** Why a `failed` run could not start. */
  readonly problem?: string;
  /** Whether a `run` stopped at the most one run may do. */
  readonly capped?: boolean;
  /** On `letGo`: how many syncs' news a held-back rule let go; a run by hand takes the notes they named. */
  readonly count?: number;
  /** Each thing it did to a note: a move, or a property's value before and after. */
  readonly done: readonly DoneAction[];
  /** Notes it matched and left alone, with why. */
  readonly left: readonly { readonly path: string; readonly reason: string }[];
  /**
   * On a run of a rule a note sets off: each note version it handled, and
   * (`wrote`) the version its own write left. None of them sets it off again.
   */
  readonly versions?: readonly {
    readonly path: string;
    readonly digest: string;
    readonly wrote: boolean;
  }[];
  /** On a run of a rule a note sets off: paths a note it had handled left, ending their history. */
  readonly went?: readonly string[];
  /**
   * On a `run` or `failed` entry of a Claude step: the model asked, how long
   * it took, and (`cut`) each note it was shown only the start of — how many
   * characters of how many. An output that reads a long meeting in parts
   * (`meeting-items`) also says each item it left out of an answer it kept,
   * with why (`dropped`), and each it kept with a fault put right
   * (`adjusted`). `asks` is how many times the model was asked, once it was
   * (what the hourly cap counts); `alreadyMade` how many proposals were made
   * before; `warnings` what the person should know of the run.
   */
  readonly claude?: {
    readonly model: string;
    readonly ms: number;
    readonly cut?: readonly {
      readonly path: string;
      readonly shown: number;
      readonly of: number;
    }[];
    readonly asks?: number;
    readonly alreadyMade?: number;
    readonly dropped?: readonly { readonly title: string; readonly reason: string }[];
    readonly adjusted?: readonly { readonly title: string; readonly reason: string }[];
    readonly warnings?: readonly string[];
  };
}

/** What a rule would do if it ran now. Nothing is written to find out. */
export interface ApiAutomationPlan {
  readonly do: 'archive' | 'set' | 'claude';
  /** What a `set` rule would set on each note; null for any other. */
  readonly set: Readonly<Record<string, SetValue>> | null;
  /** The prompt and tools a `claude` rule's run would use; null for any other. Claude is not asked. */
  readonly claude: ApiClaudeStep | null;
  /** "Would archive 12 notes." */
  readonly summary: string;
  /** The notes it would act on, at most `cap`, in the order it would. */
  readonly notes: readonly { readonly path: string; readonly title: string }[];
  /** Notes it matched and would leave alone, with why: at most 500. */
  readonly passedOver: readonly { readonly path: string; readonly reason: string }[];
  /** How many more it would leave alone than `passedOver` lists. */
  readonly passedOverMore: number;
  /** True when more matched than one run may do; the rest wait for the next run. */
  readonly capped: boolean;
  /** The most one run acts on. */
  readonly cap: number;
}

export interface ApiAutomationList {
  readonly automations: readonly ApiAutomation[];
  readonly broken: readonly ApiBrokenAutomation[];
}

/** The rule an answer is about. */
export interface ApiAutomationRef {
  readonly id: string;
  readonly name: string;
}

export interface ApiAutomationLog {
  readonly automation: ApiAutomationRef;
  /** Newest first. */
  readonly entries: readonly ApiAutomationLogEntry[];
  /** True when the log holds older entries than `limit` let through. */
  readonly truncated: boolean;
}

export interface ApiAutomationDryRun {
  readonly automation: ApiAutomationRef;
  readonly plan: ApiAutomationPlan;
}

/** A task as the weekly review lists it. */
export interface ApiReviewTask {
  readonly path: string;
  readonly title: string;
  /** One of GTD's eight statuses, or null when it holds none of them. */
  readonly status: string | null;
  /** `YYYY-MM-DD`, or null. */
  readonly due: string | null;
  /** `YYYY-MM-DD`: the day it comes back into play, or null. */
  readonly defer: string | null;
  /** How it repeats, as its `recurrence` says, or null when it does not (#260). Always read by the API. */
  readonly recurrence?: string | null;
  /** Who it waits on — a link by what it shows, a plain name as written — joined with ", "; '' for nobody. */
  readonly waitingOn: string;
  /** Its `contexts`, as written, in order. */
  readonly contexts: readonly string[];
  /** The note its `project` links, or null. */
  readonly project: string | null;
  /** That note's title, or null. */
  readonly projectTitle: string | null;
  /** When its file last changed, in milliseconds since the epoch. */
  readonly modified: number;
}

/** A project as the weekly review lists it. */
export interface ApiReviewProject {
  readonly path: string;
  readonly title: string;
  /** Its `status:` as written, or null. */
  readonly status: string | null;
  /** Whether a task in use filed under it is Next Action or In Progress, as the index says. */
  readonly moving: boolean;
}

/** `GET /v1/review/weekly`: the weekly review, as its page shows it. */
export interface ApiWeeklyReview {
  /** The day it was taken, `YYYY-MM-DD`, where the app is. */
  readonly today: string;
  /** Waiting, and untouched for more than 7 days; the longest untouched first. */
  readonly staleWaiting: readonly ApiReviewTask[];
  /** Active, with no Next Action or In Progress task filed under it; by title. */
  readonly projectsWithoutNextAction: readonly ApiReviewProject[];
  /** Due before today and still open (not Someday, Longterm or Archive); the earliest first. */
  readonly overdue: readonly ApiReviewTask[];
  /** Someday or Longterm, and untouched for more than 30 days; the longest untouched first. */
  readonly untouchedSomeday: readonly ApiReviewTask[];
  /**
   * What waits in the one Inbox, as the sidebar counts it: `count` is the notes
   * to file (`toFile`) plus the proposals to answer (`toAnswer`); `more` when
   * there are more notes than it counts.
   */
  readonly inbox: {
    readonly count: number;
    readonly toFile: number;
    readonly toAnswer: number;
    readonly more: boolean;
  };
  /** The index held tasks back, so a task section may be missing items. */
  readonly truncated: boolean;
}

/** A task as the Today page lists it: a review task, and how long it has waited. */
export interface ApiTodayTask extends ApiReviewTask {
  /**
   * For a Waiting task, the whole days (24 hours each) since its file last
   * changed (`modified`) — not a recorded "waiting since". Null otherwise.
   */
  readonly waitingDays: number | null;
}

/** `GET /v1/today`: the Today page, as the app shows it. */
export interface ApiToday {
  /** The day it was taken, `YYYY-MM-DD`, where the app is. */
  readonly today: string;
  /**
   * Every section, in order — `overdue`, `dueToday`, `backToday`,
   * `inProgress`, `nextActions`, `waiting` — empty ones included. A task is
   * in one section only: the first that claims it.
   */
  readonly sections: readonly {
    readonly id: string;
    readonly count: number;
    /**
     * `nextActions` by project (those under none last) and `waiting` by who
     * is waited on (nobody last); the other sections hold one unnamed group,
     * or none when empty.
     */
    readonly groups: readonly {
      readonly key: string;
      readonly label: string | null;
      /** The project's note, for a group of a project's tasks. */
      readonly project: string | null;
      readonly tasks: readonly ApiTodayTask[];
    }[];
  }[];
  /** Active projects with no Next Action or In Progress task: `projectsWithoutNextAction`, counted. */
  readonly stalledProjects: number;
  /** As the weekly review's `inbox`. */
  readonly inbox: ApiWeeklyReview['inbox'];
  /** The index held tasks back, so a section may be missing tasks. */
  readonly truncated: boolean;
}

/**
 * Where an assistant item came from (P32-04): a wiki link that opens it.
 * `block` names the block itself (`[[Kickoff#^t0003]]`); `heading` the
 * heading over it, for a transcript turn the file left without an id, or with
 * one written twice — a read never writes one (ADR-0022); `note` the whole
 * note, also for a `source` block the index no longer holds.
 */
export interface ApiCitation {
  /** Null when the note's name holds what no wiki link can (`C# sync`): cite it by `path`. */
  readonly link: string | null;
  readonly kind: 'block' | 'heading' | 'note';
  /** The note it opens; null for a link that names no note in the vault. */
  readonly path: string | null;
}

/** A note an assistant answer names, cited. */
export interface ApiCitedNote {
  readonly path: string;
  readonly title: string;
  readonly cite: ApiCitation;
}

/** A meeting or a decision, with the day it is dated (null when undated). */
export interface ApiDatedNote extends ApiCitedNote {
  readonly date: string | null;
}

/** A decision, and the turn it came from when its `source` says. */
export interface ApiCitedDecision extends ApiDatedNote {
  readonly source: ApiCitation | null;
}

/** An open task, a waiting-for or a follow-up, as the assistant routes answer it. */
export interface ApiLoopTask extends ApiCitedNote {
  readonly status: string | null;
  readonly due: string | null;
  /** Due before the day asked about and not finished. */
  readonly overdue: boolean;
  /** Who a waiting-for waits on, as the task writes it; null otherwise. */
  readonly waitingOn: string | null;
  /** For a waiting-for, whole days since its file last changed; null otherwise. */
  readonly waitingDays: number | null;
  /** The meeting turn (or note) its `source` says it came from. */
  readonly source: ApiCitation | null;
}

/** A follow-up: how it was reached from the page, and through which meeting. */
export interface ApiFollowUp extends ApiLoopTask {
  /** `direct`: it names the page itself; `meeting`: it was reached only through a meeting of the page. */
  readonly via: 'direct' | 'meeting';
  /** The meeting it was reached through; null when `via` is `direct`. */
  readonly meeting: ApiCitedNote | null;
}

/** The page an assistant answer is about, cited. */
export interface ApiAssistantEntity extends ApiCitedNote {
  /** Its `type:`, as written. */
  readonly type: string;
}

/** A section of the page that could not be answered, and why. */
export interface ApiSectionProblem {
  readonly section: string;
  readonly problem: string;
}

/** `GET /v1/assistant/open-loops`: what is still open around a page. */
export interface ApiOpenLoops {
  readonly entity: ApiAssistantEntity;
  /** The day it was read, `YYYY-MM-DD`: what `overdue` and `waitingDays` count to. */
  readonly date: string;
  /** Open tasks linked with the page that are neither waiting-fors nor follow-ups. */
  readonly openTasks: readonly ApiLoopTask[];
  readonly waitingFor: readonly ApiLoopTask[];
  /**
   * Open `#follow-up` tasks linked with the page or one of its meetings. One
   * reached only through a meeting names no Person but the page's own.
   */
  readonly followUps: readonly ApiFollowUp[];
  readonly truncated: boolean;
  readonly problems: readonly ApiSectionProblem[];
}

/** `GET /v1/assistant/brief`: what to know about a page on a day. */
export interface ApiBrief extends ApiOpenLoops {
  /** The newest meeting dated on or before `date`; null when none. */
  readonly lastTouch: ApiDatedNote | null;
  readonly meetings: readonly ApiDatedNote[];
  /** Every task joined to `lastTouch`, finished or not, and its decisions. */
  readonly lastMeeting: {
    readonly meeting: ApiDatedNote;
    readonly tasks: readonly ApiLoopTask[];
    readonly decisions: readonly ApiCitedNote[];
  } | null;
  readonly decisions: readonly ApiCitedDecision[];
  /** Other notes linked with the page, changed in the 30 days up to `date`. */
  readonly mentions: readonly ApiCitedNote[];
  readonly related: readonly (ApiCitedNote & {
    readonly relation: 'person' | 'company' | 'project';
  })[];
}

/** One thing said in a meeting. */
export interface ApiSpeakerQuote {
  readonly speaker: string;
  readonly time: string | null;
  readonly quote: string;
  /** Whether the quote was cut. */
  readonly cut: boolean;
  readonly cite: ApiCitation;
}

/** `GET /v1/assistant/meetings`: a page's meetings, with who said what in them. */
export interface ApiAssistantMeetings {
  readonly entity: ApiAssistantEntity;
  readonly since: string | null;
  /** The last day a meeting may be dated: the day asked for, else the app's today. */
  readonly until: string;
  readonly about: string | null;
  /** The names a person's turns were matched by; null for a page that does not speak. */
  readonly speakers: readonly string[] | null;
  readonly meetings: readonly (ApiDatedNote & {
    readonly quotes: readonly ApiSpeakerQuote[];
    /** How many turns were wanted before the cap. */
    readonly matched: number;
  })[];
  readonly truncated: boolean;
  readonly problems: readonly ApiSectionProblem[];
}

/** `POST /v1/assistant/propose-tasks`: a meeting's items, drafted as proposals. */
export interface ApiProposedTasks {
  readonly meeting: string;
  /** The proposals written into Inbox/Proposals. */
  readonly proposed: readonly string[];
  /** How many the answer held that were proposed before, open or answered, and so were not again. */
  readonly alreadyProposed: number;
  /**
   * True when Claude was not asked: the meeting's words are those it was
   * drafted from before, and `alreadyProposed` counts what that made.
   */
  readonly unchanged: boolean;
  /** Items left out of the answer, each with why. */
  readonly dropped: readonly { readonly title: string; readonly reason: string }[];
  /** Why the meeting was not asked about at all, when it was not. */
  readonly left: readonly { readonly path: string; readonly reason: string }[];
  readonly warnings: readonly string[];
}

/** `POST /v1/assistant/make-dashboard`: a spec checked, and left as a proposal. */
export interface ApiProposedSpec {
  readonly kind: 'dashboard' | 'view';
  readonly title: string;
  /** The proposal written; null when it was not, and `problem` says why. */
  readonly proposal: string | null;
  /**
   * Why no proposal was written — the same spec proposed before, and what
   * became of it (`already accepted on 2026-10-23`), or a write that failed —
   * with that proposal's path when there is one. Null when one was written.
   */
  readonly problem: { readonly message: string; readonly proposal: string | null } | null;
}

// ---------------------------------------------------------------------------
// Success bodies, per route
// ---------------------------------------------------------------------------

export type ApiSuccessBody =
  | ApiStatus
  | {
      readonly notes: readonly ApiNoteSummary[];
      readonly next: string | null;
      /** How many notes match in all, over every page (#214). */
      readonly total: number;
    }
  | { readonly note: ApiNote }
  | { readonly note: ApiNote; readonly moved: boolean }
  | { readonly note: ApiNote; readonly task: ApiNote }
  | {
      readonly backlinks: readonly ApiNoteSummary[];
      readonly next: string | null;
      /** How many notes link to it in all, over every page (#214). */
      readonly total: number;
    }
  | { readonly hits: readonly ApiSearchHit[] }
  | { readonly types: readonly ApiType[] }
  | { readonly views: readonly ApiView[] }
  | {
      readonly type: string;
      readonly views: readonly ApiTypeView[];
      /** How many views the type has, across every page. */
      readonly total: number;
      /** The `offset` of the next page, or null on the last. */
      readonly next: number | null;
    }
  | {
      readonly templates: readonly ApiTemplate[];
      /** Types no template serves yet: a new note of one starts empty. */
      readonly typesWithoutTemplate: readonly string[];
    }
  | { readonly template: ApiTemplateContent }
  | ApiRows
  | ApiAtlasQueryRows
  | { readonly widgets: readonly unknown[] }
  | { readonly file: ApiArtifactFile }
  | { readonly image: ApiNoteImage }
  | { readonly upload: ApiImageUpload }
  | { readonly types: readonly ApiQuickAddType[] }
  | { readonly profile: ApiProfile }
  | ApiCalendar
  | { readonly report: ApiSourceReport }
  | { readonly tags: readonly ApiTag[] }
  | {
      readonly tag: ApiTag;
      readonly notes: readonly ApiTaggedNote[];
      readonly next: string | null;
      /** How many notes use the tag in all, over every page (#214). */
      readonly total: number;
    }
  | { readonly rename: ApiTagRenamePreview; readonly report?: ApiTagRenameReport }
  | { readonly pairs: readonly ApiDuplicatePair[] }
  | { readonly merge: ApiPeopleMergePreview; readonly report?: ApiPeopleMergeReport }
  | ApiArchiveOutcome
  | ApiProcessOutcome
  | ApiClarifyOutcome
  | {
      readonly notes: readonly ApiArchivedNote[];
      readonly truncated: boolean;
      /** The `offset` for the next page, or null when this was the last. */
      readonly next: number | null;
    }
  | ApiAutomationList
  | ApiAutomationLog
  | ApiAutomationDryRun
  | ApiTerms
  | { readonly items: readonly ApiInboxItem[]; readonly truncated: boolean }
  | {
      readonly meetings: readonly ApiMeeting[];
      readonly truncated: boolean;
      /** The `offset` for the next page, or null when this was the last. */
      readonly next: number | null;
    }
  | { readonly meeting: ApiMeetingReceipt }
  | {
      readonly proposals: readonly ApiProposal[];
      /** Answered, yet still in Inbox/Proposals: the Archive refused them. */
      readonly stranded: readonly {
        readonly path: string;
        readonly headline: string;
        readonly state: 'accepted' | 'rejected';
      }[];
      /** Notes there that say they are proposals and cannot be read, with why. */
      readonly unreadable: readonly { readonly path: string; readonly problem: string }[];
    }
  | { readonly accepted: ApiAcceptedProposal }
  | { readonly rejected: ApiProposalArchived }
  | { readonly review: ApiWeeklyReview }
  | { readonly today: ApiToday }
  | { readonly export: ApiNoteExport }
  | { readonly brief: ApiBrief }
  | { readonly openLoops: ApiOpenLoops }
  | { readonly meetingQuotes: ApiAssistantMeetings }
  | { readonly proposedTasks: ApiProposedTasks }
  | { readonly proposingTasks: { readonly meeting: string; readonly running: true } }
  | { readonly proposedSpec: ApiProposedSpec };

/**
 * Every route, as the router and the MCP server both need to know them.
 *
 * `{path}` is a vault-relative note path, percent-encoded as one segment
 * (slashes as `%2F`), so `notes/Some%2FFolder%2FNote.md`. `{name}` is a file's
 * path inside an artifact's saved copy, a type's name, or a template's name,
 * encoded the same way. `{tag}` is a
 * tag's name, with or without its `#`, encoded the same way (`para%2Fresource`).
 * `{id}` is an automation's id, as `/v1/automations` lists it, encoded the same way.
 */
export const API_ROUTES = [
  {
    method: 'GET',
    path: '/v1/status',
    summary:
      'What DFAI has open, whether its index is ready, and whether Google Calendar is connected.',
  },
  {
    method: 'GET',
    path: '/v1/notes',
    summary: 'List notes. Query: folder, type, date, limit, cursor.',
  },
  { method: 'POST', path: '/v1/notes', summary: 'Create a note, optionally from a template.' },
  {
    method: 'GET',
    path: '/v1/notes/{path}',
    summary: 'Read a note: properties, body and modified time.',
  },
  {
    method: 'PATCH',
    path: '/v1/notes/{path}/properties',
    summary: 'Set or remove frontmatter properties.',
  },
  {
    method: 'POST',
    path: '/v1/notes/{path}/append',
    summary: 'Append markdown to the end of the body.',
  },
  {
    method: 'PUT',
    path: '/v1/notes/{path}/body',
    summary: 'Replace the body. Requires ifModified.',
  },
  { method: 'GET', path: '/v1/notes/{path}/backlinks', summary: 'Notes that link to this one.' },
  {
    method: 'POST',
    path: '/v1/notes/{path}/promote',
    summary: 'Make a checklist line of a note a task of its own, linked both ways.',
  },
  {
    method: 'GET',
    path: '/v1/notes/{path}/export',
    summary:
      'A note as markdown for a Confluence page, as it is, or standalone. Query: format, frontmatter.',
  },
  {
    method: 'PUT',
    path: '/v1/notes/{path}/images/{name}',
    summary: 'Save an image for a note, a chunk at a time, where Settings → Images puts it.',
  },
  {
    method: 'GET',
    path: '/v1/search',
    summary: 'Full-text search. Query: q, limit, includeArchived.',
  },
  { method: 'GET', path: '/v1/types', summary: 'Object types and their properties.' },
  {
    method: 'GET',
    path: '/v1/types/{name}/views',
    summary: "A type's views, in the order its tabs read. Query: limit, offset.",
  },
  {
    method: 'GET',
    path: '/v1/templates',
    summary: 'Every template, with what makes notes from each. Read-only.',
  },
  {
    method: 'GET',
    path: '/v1/templates/{name}',
    summary: "One template's properties and body, by name. Read-only.",
  },
  { method: 'GET', path: '/v1/views', summary: 'Saved views and dashboards.' },
  {
    method: 'POST',
    path: '/v1/views/{path}/run',
    summary: "Run a saved view, or a dashboard's widgets.",
  },
  {
    method: 'POST',
    path: '/v1/views/{path}/calendar',
    summary: "A saved view's notes on a calendar: a month, week, 3 days, a day or an agenda.",
  },
  {
    method: 'POST',
    path: '/v1/views/{path}/move',
    summary:
      'Move a card on a board to another column, lane or both, as a drag does. Requires ifModified to finish a task.',
  },
  {
    method: 'POST',
    path: '/v1/views/{path}/notes',
    summary: "Add a note inside a view's group, given that group's values, as + New does.",
  },
  { method: 'POST', path: '/v1/query', summary: 'Query notes of a type with filters and sorts.' },
  { method: 'POST', path: '/v1/sql', summary: 'Read-only SQL against the index.' },
  {
    method: 'POST',
    path: '/v1/atlas-query',
    summary:
      'Run a DFAI query across types: rows, and its groups and sub-groups. `context` names the note `this` means.',
  },
  {
    method: 'POST',
    path: '/v1/daily',
    summary: "Today's daily note, created from its template if it does not exist yet.",
  },
  { method: 'POST', path: '/v1/capture', summary: 'Capture a task, as quick capture does.' },
  { method: 'GET', path: '/v1/quick-add', summary: 'The types the add button offers.' },
  {
    method: 'GET',
    path: '/v1/profile',
    summary: "The person's name, as Settings → Profile holds it. Read only.",
  },
  {
    method: 'POST',
    path: '/v1/quick-add',
    summary: 'Add a note of a type as the add button does: a name and a few fields.',
  },
  {
    method: 'POST',
    path: '/v1/sources/{path}/refresh',
    summary: 'Refresh a source note now, as its Refresh button does.',
  },
  {
    method: 'POST',
    path: '/v1/artifacts',
    summary: 'Save a Claude artifact: its note, and a copy of its HTML when given.',
  },
  {
    method: 'PUT',
    path: '/v1/artifacts/{path}/files/{name}',
    summary: "Write a file of an artifact's saved copy, a chunk at a time.",
  },
  {
    method: 'POST',
    path: '/v1/artifacts/{path}/thumbnail',
    summary:
      "Picture an artifact's saved copy as its thumbnail and cover, unless its cover was set by hand.",
  },
  {
    method: 'GET',
    path: '/v1/tags',
    summary: 'Every tag in the vault, nested, with its uses. Query: sort (name or frequency).',
  },
  {
    method: 'GET',
    path: '/v1/tags/{tag}/notes',
    summary: 'The notes using a tag or one nested under it. Query: limit, cursor.',
  },
  {
    method: 'POST',
    path: '/v1/tags/{tag}/rename',
    summary: 'Rename a tag in every note using it, as the tags page does; dryRun previews it.',
  },
  {
    method: 'GET',
    path: '/v1/people/duplicates',
    summary:
      'Pairs of people who may be one person: the same name, an alias, or alike addresses; surest first.',
  },
  {
    method: 'POST',
    path: '/v1/people/merge',
    summary:
      'Merge people into one, as the app does: previews unless confirm, then rewrites links and trashes the merged.',
  },
  {
    method: 'GET',
    path: '/v1/archive',
    summary: 'List archived notes, newest first. Query: search, limit, offset.',
  },
  {
    method: 'POST',
    path: '/v1/archive',
    summary: 'Put notes in the Archive, as the app does, rewriting links to them.',
  },
  {
    method: 'POST',
    path: '/v1/unarchive',
    summary: 'Take notes out of the Archive, back where each came from.',
  },
  {
    method: 'GET',
    path: '/v1/inbox',
    summary:
      'What waits in the Inbox, newest first: its folder, and every task still at Inbox; no proposals.',
  },
  {
    method: 'POST',
    path: '/v1/inbox/process',
    summary: "File notes from the Inbox under a project or an area, as the Inbox's Process does.",
  },
  {
    method: 'POST',
    path: '/v1/inbox/clarify',
    summary:
      'Clarify one Inbox note in one save: status, project, waiting on, defer, due, contexts.',
  },
  {
    method: 'POST',
    path: '/v1/tasks/schedule',
    summary:
      'Make a block for a task, from a start for some minutes, linking it. Answers the block.',
  },
  {
    method: 'GET',
    path: '/v1/review/weekly',
    summary:
      'The weekly review: stale waiting-fors, projects with nothing next, overdue, old ideas.',
  },
  {
    method: 'GET',
    path: '/v1/today',
    summary:
      'The Today page: overdue, due today, back from deferral, in progress, next actions, waiting.',
  },
  {
    method: 'GET',
    path: '/v1/assistant/brief',
    summary:
      'A brief on a person, company, project, area or meeting for a day: last meeting, open loops, decisions, mentions — every item cited. Query: entity, date.',
  },
  {
    method: 'GET',
    path: '/v1/assistant/open-loops',
    summary:
      'Open tasks, waiting-fors and follow-ups around a person, company, project or area, each cited. Query: entity.',
  },
  {
    method: 'GET',
    path: '/v1/assistant/meetings',
    summary:
      'A page’s meetings with the turns that answer the question: speaker, quote, block link. Query: entity, since, about, limit.',
  },
  {
    method: 'POST',
    path: '/v1/assistant/propose-tasks',
    summary:
      'Draft a meeting’s tasks, waiting-fors, decisions and follow-ups as proposals, each citing its turn. Body: meeting.',
  },
  {
    method: 'POST',
    path: '/v1/assistant/make-dashboard',
    summary:
      'Check a dashboard or view spec and leave it as a proposal; only Accept in the app writes it into .atlas. Body: spec.',
  },
  {
    method: 'GET',
    path: '/v1/automations',
    summary: 'Every automation: its rule, last and next run, and why one is paused or broken.',
  },
  {
    method: 'GET',
    path: '/v1/automations/{id}/log',
    summary: "An automation's log, newest first. Query: limit.",
  },
  {
    method: 'POST',
    path: '/v1/automations/{id}/dry-run',
    summary: 'What an automation would do if it ran now. Writes nothing.',
  },
  {
    method: 'GET',
    path: '/v1/terms',
    summary: 'The vocabulary: every term, every spelling DFAI puts right, and the conflicts.',
  },
  {
    method: 'GET',
    path: '/v1/meetings',
    summary:
      'Meetings, newest first, with any import error. Query: since, limit, offset, includeArchived.',
  },
  {
    method: 'POST',
    path: '/v1/meetings',
    summary:
      'Send a meeting, as n8n assembles it: mapped and written into Inbox/Meetings, once per provider and id.',
  },
  {
    method: 'GET',
    path: '/v1/proposals',
    summary: 'The open proposals in Inbox/Proposals, newest first, with what each would write.',
  },
  {
    method: 'POST',
    path: '/v1/proposals/{path}/accept',
    summary: 'Accept a proposal, as its Accept button does: write its payload, then archive it.',
  },
  {
    method: 'POST',
    path: '/v1/proposals/{path}/reject',
    summary: 'Reject a proposal: write nothing it proposed, and archive it as rejected.',
  },
] as const;

export type ApiRoute = (typeof API_ROUTES)[number];
