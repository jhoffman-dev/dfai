import {
  CAPTURES_FOLDER,
  isNamedForKey,
  type CaptureFile,
} from '../../packages/domain/src/capture/mapping/capture-to-atlas.ts';

/*
 * The Slack workflow's fallback (#104): when DFAI is not there to take a
 * capture, n8n commits its file to pkm-space itself — once. Whether a file
 * for the message is there already is read from the listing of
 * `Inbox/Captures/`, by the key's hash in its name, whatever title it has.
 */

/** The GitHub contents API's listing of `Inbox/Captures/`, as n8n's HTTP node hands it over. */
export interface FolderListing {
  readonly statusCode: unknown;
  readonly body: unknown;
}

/** The most files GitHub's contents API lists in a folder: a listing that long may be cut short. */
export const GITHUB_LISTING_LIMIT = 1000;

/** A listing GitHub did not give, or gave cut short: never taken for "nothing there", which would write twice. */
export class ListingError extends Error {
  override readonly name = 'ListingError';
}

/** The names in the listing; none when the folder is not there yet (404). */
function namesIn(listing: FolderListing): string[] {
  if (listing.statusCode === 404) return [];
  if (listing.statusCode !== 200 || !Array.isArray(listing.body)) {
    throw new ListingError(
      `GitHub answered ${String(listing.statusCode)} listing ${CAPTURES_FOLDER}, not its files`,
    );
  }
  if (listing.body.length >= GITHUB_LISTING_LIMIT) {
    throw new ListingError(
      `GitHub listed ${listing.body.length} files in ${CAPTURES_FOLDER}, its most, so maybe not all: file your Inbox, or send to DFAI`,
    );
  }
  return listing.body.flatMap((entry: unknown) => {
    const name =
      typeof entry === 'object' && entry !== null ? (entry as { name?: unknown }).name : null;
    return typeof name === 'string' ? [name] : [];
  });
}

/**
 * The path in pkm-space of a file already named for this message's key, or
 * null when there is none. A file named for the key is taken as this
 * message's: its 64-bit hash is the message's (ADR-0049), and a message is
 * never written twice. Note that a note filed out of `Inbox/Captures/` is
 * not seen here; the app's index finds it, so send to DFAI when it runs.
 */
export function heldCapturePath(
  listing: FolderListing,
  file: Pick<CaptureFile, 'keyEnding'>,
): string | null {
  const held = namesIn(listing).find((name) => isNamedForKey(name, file.keyEnding));
  return held === undefined ? null : `${CAPTURES_FOLDER}/${held}`;
}
