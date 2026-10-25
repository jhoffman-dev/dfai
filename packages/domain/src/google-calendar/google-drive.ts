/*
 * Google Docs from an export (#501), through the Calendar's sign-in
 * (ADR-0030). Its one scope (`export` in google-scopes.ts) is the narrowest Drive has: the files this
 * app made itself, and no other file in the person's Drive. Google lists it
 * as non-sensitive, so a client needs no verification to ask for it.
 */

/** What a Google Doc is, to Drive: an upload converted to it becomes an editable Doc. */
export const GOOGLE_DOC_MIME_TYPE = 'application/vnd.google-apps.document';

/** What a folder is, to Drive. */
export const GOOGLE_FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder';

/**
 * The most HTML one Doc is made from. Google converts a file to a Doc only
 * up to 50 MB; this leaves room for the request around it.
 */
export const MAX_GOOGLE_DOC_HTML_BYTES = 45 * 1024 * 1024;

/** How long to wait before each try again of a Drive call Google turned away for now: three, then it fails. */
export const DRIVE_RETRY_DELAYS_MS: readonly number[] = [1_000, 2_000, 4_000];

/**
 * The wait before trying a Drive call again, after try number `attempt`
 * (from 1) was answered `status`: only Google's "too many requests" (429)
 * and its own errors (5xx) are worth a second try. Null when it is not
 * tried again: any other answer, or the tries are spent.
 */
export function driveRetryDelay({
  attempt,
  status,
}: {
  attempt: number;
  status: number | null;
}): number | null {
  if (status === null) return null;
  const now = status === 429 || (status >= 500 && status <= 599);
  return now ? (DRIVE_RETRY_DELAYS_MS[attempt - 1] ?? null) : null;
}
