/**
 * The local API's wire: how the Rust host hands a request to the app and gets
 * an answer, and the errors any route can give. One part of `../contract.ts`.
 *
 * Everything here is data. No behaviour belongs in this file.
 */

/** Every path the API serves starts with this. A breaking change gets `/v2`. */
export const API_VERSION_PREFIX = '/v1';

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

/** The Tauri event the host emits a request on, and the command that answers. */
export const API_REQUEST_EVENT = 'api-request';

export const API_RESPOND_COMMAND = 'api_respond';

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
  /**
   * `mode=semantic` on a vault where search by meaning has not been turned on
   * from the app: the API never turns it on, since that fetches a 91 MB model.
   */
  | 'semantic_off'
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
  semantic_off: 409,
  query_failed: 422,
  thumbnail_failed: 422,
  internal: 500,
};
