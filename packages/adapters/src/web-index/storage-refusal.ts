/** The names a browser gives to refusing a page its private file system. */
const REFUSALS = new Set(['SecurityError', 'UnknownError']);

/** WebKit's words when it refuses OPFS file handles, as in an ephemeral context. */
const TRANSIENT = /unknown transient reason/i;

/** SQLite's words when the browser has no OPFS to offer at all. */
const NO_OPFS = /Missing required OPFS APIs/;

/**
 * Whether a failure to bring up the index's OPFS pool is the browser refusing
 * the page storage (Private Browsing, an ephemeral context, an old Safari),
 * which a session-only index answers for, rather than something wrong that
 * must be seen. Another tab holding the files, a full disk or a bug are not.
 */
export function isStorageRefusal(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { name, message } = error as { name?: unknown; message?: unknown };
  if (typeof name === 'string' && REFUSALS.has(name)) return true;
  return typeof message === 'string' && (TRANSIENT.test(message) || NO_OPFS.test(message));
}
