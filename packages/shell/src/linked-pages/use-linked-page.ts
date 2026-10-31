import { useCallback, useEffect, useState } from 'react';
import {
  isLinkedPageType,
  linkedPageType,
  type LinkedRange,
  type LinkedSectionId,
  type ObjectType,
} from '@dfai/domain';
import {
  readLinkedPage,
  type Clock,
  type IndexPort,
  type LinkedRangeStore,
  type LinkedSection,
} from '@dfai/application';

/** A page's linked sections, and the way to turn one between recent and all. */
export interface LinkedPage {
  /** Null until they have been read once for this page as the type it is now. */
  readonly sections: readonly LinkedSection[] | null;
  /** Said in place of the sections when they could not be read at all; null when they were. */
  readonly problem: string | null;
  readonly setRange: (section: LinkedSectionId, range: LinkedRange) => void;
}

/** What a read came to, and the page — its path and its type — it was read for. */
interface Read {
  readonly notePath: string;
  readonly pageType: string;
  readonly sections: readonly LinkedSection[] | null;
  readonly problem: string | null;
}

const UNREAD_PROBLEM = 'What is linked with this page could not be read just now.';

/**
 * A linked page's sections (P30-06) for the note a pane holds: read from the
 * index whenever the page, its type, a section's range or `revision` — the
 * index's count of changes — moves, so a meeting arriving or a task ticked
 * anywhere reaches them. What was last read stays up while it is read again;
 * another page's sections, or the same page's under another type, are never
 * shown in its place. Null where the note is no linked page.
 *
 * A pane is told its path before its note has been read, and until then the
 * type it knows is the last note's: nothing is read until `loadedPath` says
 * the type is this note's own, or a meeting's sections would be asked — and
 * drawn — for a person.
 */
export function useLinkedPage({
  index,
  clock,
  store,
  types,
  notePaths,
  notePath,
  loadedPath = notePath,
  typeName,
  projectStatus = null,
  revision,
}: {
  index: IndexPort;
  clock: Pick<Clock, 'today'>;
  store: LinkedRangeStore;
  types: readonly ObjectType[];
  notePaths: readonly string[];
  /** The note the pane holds; null for none, or one that is not a page of its type (a template). */
  notePath: string | null;
  /**
   * The note `typeName` and `projectStatus` were read from: the one the pane
   * has loaded, null while it has none. Left out by a caller that knows they
   * are `notePath`'s own.
   */
  loadedPath?: string | null;
  typeName: string | null;
  /** The note's own `status`, as written: a project's says whether it should be moving. */
  projectStatus?: string | null;
  revision: string;
}): LinkedPage | null {
  const loaded = notePath !== null && loadedPath === notePath;
  // One spelling of the type, so `Person` reads the ranges left for `person`.
  const pageType =
    loaded && typeName !== null && isLinkedPageType(typeName) ? linkedPageType(typeName) : null;
  const [read, setRead] = useState<Read | null>(null);
  // Counts the ranges changed, so a section turned to All is read again.
  const [turned, setTurned] = useState(0);

  useEffect(() => {
    if (notePath === null || pageType === null) return;
    let cancelled = false;
    const page = { notePath, pageType };
    readLinkedPage({
      index,
      clock,
      types,
      notePaths,
      notePath,
      typeName: pageType,
      projectStatus,
      ranges: store.read(pageType),
    })
      .then((sections) => {
        if (!cancelled) setRead({ ...page, sections, problem: null });
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        // A section's own unanswerable query is said in the section. What lands
        // here is a fault in reading at all: said on the page, and in the
        // console with its cause, never left as a page that looks unlinked.
        console.error('Linked sections could not be read', cause);
        setRead((was) => ({
          ...page,
          sections: was !== null && isFor(was, page) ? was.sections : null,
          problem: UNREAD_PROBLEM,
        }));
      });
    return () => {
      cancelled = true;
    };
  }, [index, clock, store, types, notePaths, notePath, pageType, projectStatus, revision, turned]);

  const setRange = useCallback(
    (section: LinkedSectionId, range: LinkedRange) => {
      if (pageType === null) return;
      store.write(pageType, section, range);
      setTurned((count) => count + 1);
    },
    [store, pageType],
  );

  if (notePath === null || pageType === null) return null;
  const mine = read !== null && isFor(read, { notePath, pageType }) ? read : null;
  return { sections: mine?.sections ?? null, problem: mine?.problem ?? null, setRange };
}

function isFor(read: Read, page: { notePath: string; pageType: string }): boolean {
  return read.notePath === page.notePath && read.pageType === page.pageType;
}
