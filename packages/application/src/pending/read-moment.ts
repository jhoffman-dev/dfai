/**
 * Where a read of the index stands among a page's own writes (#217, #260):
 * `at` counts the page's reads begun by then, and `indexKey` is the index's
 * key at that moment. Said of a write, it is the moment the write landed.
 */
export interface ReadMoment {
  readonly at: number;
  readonly indexKey: string;
}

/** The key of an index that is ready, at its revision: the only key a read stands for a write at. */
export function readyIndexKey(revision: number): string {
  return `${READY}${revision}`;
}

const READY = 'ready:';

/**
 * Whether a read already stands for a write the page made, so what the page
 * draws for that write gives way to what the index read. It does once the
 * write has landed, the read began after it, and the read is of an index that
 * is ready and has moved since (#239): a read begun earlier, or of the index
 * from before, is still behind the write, and drawing it would put the row
 * back for a beat. An index that moved because its refresh failed, or is
 * being built again, may not hold the write (#698): the row is drawn as its
 * write left it until the index is ready past it, or the vault is closed.
 */
export function readAnswers(landed: ReadMoment | null, read: ReadMoment): boolean {
  return (
    landed !== null &&
    read.at > landed.at &&
    read.indexKey.startsWith(READY) &&
    read.indexKey !== landed.indexKey
  );
}

/**
 * Asks for the refresh a write that has landed needs, and says when it
 * landed: as that refresh is asked, at the index's own key then (#698). A
 * sync that moves the index after this runs after the write, so a read begun
 * once the index has moved past it stands for the write. Each read is to be
 * stamped with the same key as it begins, not with the index's news: that
 * reaches the page a little late, and a sync that read the vault before the
 * write can move the index just before the write lands, its news just after.
 *
 * The key is taken after the refresh is asked, never before: a sync already
 * running could otherwise move the index between the two, from a read of the
 * vault without the write. A refresh that throws as it is asked is handed to
 * `refreshFailed`, and the write still lands: it was made, and a row held for
 * a refresh that may never come would wait until the vault closed.
 */
export function landedAsRefreshAsked({
  refresh,
  readsBegun,
  indexKeyNow,
  refreshFailed,
}: {
  /** Asks the index to read the vault again. */
  readonly refresh: () => void;
  /** How many reads the page has begun, now. */
  readonly readsBegun: () => number;
  /** The index's own key now. */
  readonly indexKeyNow: () => string;
  /** Told why the refresh could not be asked. */
  readonly refreshFailed: (cause: unknown) => void;
}): ReadMoment {
  let failure: { readonly cause: unknown } | null = null;
  try {
    refresh();
  } catch (cause) {
    failure = { cause };
  }
  const landed = { at: readsBegun(), indexKey: indexKeyNow() };
  if (failure !== null) refreshFailed(failure.cause);
  return landed;
}
