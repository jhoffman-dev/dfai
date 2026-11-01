import { useEffect, useMemo, useState } from 'react';
import { MODIFIED_COLUMN, type BoardRow, type ObjectType, type ViewLayout } from '@dfai/domain';
import {
  PREVIEW_BATCH,
  readNotePreviews,
  type MarkdownPort,
  type NotePreview,
  type VaultFsPort,
} from '@dfai/application';
import type { CoverSource, FeedBodies } from '@dfai/ui';
import { useVaultImages } from '../notes/use-images.ts';
import type { PageToPicture } from '../thumbnails/use-page-thumbnails.ts';

/** What a feed or a gallery draws its notes with. */
export interface NotePreviews {
  readonly bodies: FeedBodies;
  /** Each card's picture, where it names one (`cardFront`'s image). */
  readonly covers: CoverSource;
  /** The notes whose cards are fronted by a picture of their page instead. */
  readonly pages: readonly PageToPicture[];
  readonly shown: number;
  readonly showMore: () => void;
}

/** How many notes a feed draws at first, and adds on each "Show more notes". */
export const FEED_PAGE = 10;

/** How many gallery cards are given their covers: the first screens' worth. */
export const GALLERY_COVERS = 4 * PREVIEW_BATCH;

/**
 * The bodies and covers of the notes a feed or a gallery is showing, read from
 * their files a batch at a time — only the notes on screen, and again when one
 * of them changed. Other layouts read nothing.
 */
export function useNotePreviews({
  fs,
  markdown,
  rows,
  layout,
  viewKey,
  indexKey,
  type,
}: {
  fs: VaultFsPort;
  markdown: MarkdownPort;
  rows: readonly BoardRow[];
  layout: ViewLayout;
  /** The type the view lists, whose thumbnail property fronts its cards. */
  type: ObjectType | null;
  /** Which view this is: a different one starts its feed from the top. */
  viewKey: string;
  indexKey: string;
}): NotePreviews {
  const [page, setPage] = useState({ viewKey, shown: FEED_PAGE });
  // A new view starts at the first page, set while rendering so the old
  // count is never drawn against the new rows.
  if (page.viewKey !== viewKey) setPage({ viewKey, shown: FEED_PAGE });
  const shown = page.viewKey === viewKey ? page.shown : FEED_PAGE;

  const count = layout === 'feed' ? shown : layout === 'gallery' ? GALLERY_COVERS : 0;
  const onScreen = rows.slice(0, count);
  const version = versionOf(onScreen, indexKey);
  // Keyed by the notes and when each changed, not by the rows' identity: the
  // index hands over new rows on every save anywhere in the vault.
  const wanted = useMemo(() => onScreen.map((row) => row.path), [version]);

  const previews = usePreviewReads({ fs, markdown, paths: wanted, version, type });
  const load = useVaultImages({ fs, resetKey: viewKey });

  return useMemo(
    () => ({
      bodies: { bodyOf: (path) => previews.get(path)?.doc, load },
      covers: { coverOf: (path) => imageOf(previews.get(path)), load },
      pages: [...previews.values()]
        .filter((preview) => preview.front.kind === 'page')
        .map(({ path, modified }) => ({ path, modified })),
      shown,
      showMore: () => setPage({ viewKey, shown: shown + FEED_PAGE }),
    }),
    [previews, load, shown, viewKey],
  );
}

function imageOf(preview: NotePreview | undefined): string | null {
  return preview?.front.kind === 'image' ? preview.front.src : null;
}

/**
 * What the notes on screen are, and when each last changed — or, for rows that
 * do not say when (a view written in SQL), the index's own count of changes.
 */
function versionOf(rows: readonly BoardRow[], indexKey: string): string {
  const dated = rows.every((row) => row.values[MODIFIED_COLUMN] !== undefined);
  const notes = rows.map((row) => `${row.path}@${String(row.values[MODIFIED_COLUMN])}`);
  return JSON.stringify(dated ? notes : [...notes, indexKey]);
}

/** Reads `paths` in batches, keeping what earlier reads found until a newer read replaces it. */
function usePreviewReads({
  fs,
  markdown,
  paths,
  version,
  type,
}: {
  fs: VaultFsPort;
  markdown: MarkdownPort;
  paths: readonly string[];
  type: ObjectType | null;
  /** Changes when the notes or their contents do; nothing is read again until it does. */
  version: string;
}): ReadonlyMap<string, NotePreview> {
  const [previews, setPreviews] = useState<ReadonlyMap<string, NotePreview>>(new Map());

  useEffect(() => {
    if (paths.length === 0) return;
    let cancelled = false;
    const readAll = async () => {
      for (let start = 0; start < paths.length && !cancelled; start += PREVIEW_BATCH) {
        const batch = paths.slice(start, start + PREVIEW_BATCH);
        const found = await readNotePreviews({ fs, markdown, paths: batch, type });
        if (cancelled) return;
        setPreviews((before) => {
          const next = new Map(before);
          for (const preview of found) next.set(preview.path, preview);
          return next;
        });
      }
    };
    // A note that cannot be read keeps its summary in the feed; a failed batch
    // is left the same way rather than blanking the notes that did read.
    readAll().catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [fs, markdown, paths, version, type]);

  return previews;
}
