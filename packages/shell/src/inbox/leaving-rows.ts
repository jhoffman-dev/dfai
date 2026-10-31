import type { VaultPath } from '@dfai/domain';
import { readAnswers, type InboxListing, type ReadMoment } from '@dfai/application';

/**
 * A row taken off the page the moment it was clarified, before the index has
 * caught up with the write. Null `settled` while it is being written and
 * until a refresh of the index asked for after that has landed; then the
 * moment it landed, and the index's key when the refresh was asked for, so a
 * read begun since — against an index that has moved on — is what says
 * whether it is still waiting.
 */
export interface LeavingRow {
  readonly path: VaultPath;
  readonly settled: ReadMoment | null;
}

/**
 * The listing as the page shows it: without the rows that have left it and
 * the index has not yet caught up with, and counting them out of the total.
 */
export function withoutLeaving(
  listing: InboxListing,
  leaving: readonly LeavingRow[],
  read: ReadMoment,
): InboxListing {
  const gone = new Set(
    leaving.filter((row) => !readAnswers(row.settled, read)).map((row) => row.path as string),
  );
  if (gone.size === 0) return listing;
  const items = listing.items.filter((item) => !gone.has(item.path));
  return { ...listing, items, total: listing.total - (listing.items.length - items.length) };
}
