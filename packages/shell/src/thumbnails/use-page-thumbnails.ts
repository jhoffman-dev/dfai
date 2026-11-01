import { useEffect, useState } from 'react';
import {
  createVaultPath,
  pageThumbnailPath,
  pageThumbnailSrc,
  pageThumbnailWait,
  type VaultPath,
} from '@dfai/domain';
import {
  picturedPages,
  type ThumbnailQueue,
  type ThumbnailSnapshot,
  type VaultFsPort,
} from '@dfai/application';
import { remadeCover, useThumbnailSnapshot } from '../artifacts/use-thumbnails.ts';

/** A note whose card is fronted by a picture of its page, and when it last changed. */
export interface PageToPicture {
  readonly path: string;
  readonly modified: number;
}

/**
 * Which version of its note each picture in the cache is of, read again
 * whenever the queue has made one — not on every change to the queue, most of
 * which (a picture asked for, one failing) keep nothing new. Null until the
 * first read lands — not empty, which would read as every page wanting a
 * picture.
 */
export function usePicturedPages(
  fs: VaultFsPort,
  thumbnails: ThumbnailQueue,
): ReadonlyMap<string, number> | null {
  const made = useThumbnailSnapshot(thumbnails).madeInAll();
  const [pictured, setPictured] = useState<ReadonlyMap<string, number> | null>(null);
  useEffect(() => {
    let cancelled = false;
    void picturedPages(fs).then((found) => {
      if (!cancelled) setPictured(found);
    });
    return () => {
      cancelled = true;
    };
  }, [fs, made]);
  return pictured;
}

/**
 * The versions of notes asked for through each queue, by path: shared by
 * every surface showing a note — its pane and a gallery listing it — so a
 * version is asked for once however many show it. Keyed by the queue, which
 * is the vault's: a new vault starts with none asked.
 */
const askedThrough = new WeakMap<ThumbnailQueue, Map<string, number>>();

function askedOf(thumbnails: ThumbnailQueue): Map<string, number> {
  let asked = askedThrough.get(thumbnails);
  if (asked === undefined) {
    asked = new Map();
    askedThrough.set(thumbnails, asked);
  }
  return asked;
}

/**
 * Asks for a picture of each page whose picture is missing or of another
 * version of the note — once the note has been quiet a while
 * (`pageThumbnailWait`), so a note being typed in is pictured when it rests,
 * not on every save. Each version of a note is asked for once, from however
 * many surfaces: a picture that failed is not asked for again until the note
 * changes.
 */
export function usePageThumbnailRefresh({
  pages,
  pictured,
  thumbnails,
  now,
}: {
  pages: readonly PageToPicture[];
  /** Null until the cache has been read: nothing is asked for before then. */
  pictured: ReadonlyMap<string, number> | null;
  thumbnails: ThumbnailQueue;
  now: () => number;
}): void {
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (pictured === null) return;
    const asked = askedOf(thumbnails);
    let soonest: number | null = null;
    for (const { path, modified } of pages) {
      if (asked.get(path) === modified) continue;
      const wait = pageThumbnailWait({
        noteModified: modified,
        picturedAt: pictured.get(pageThumbnailPath(createVaultPath(path))) ?? null,
        now: now(),
      });
      if (wait === null) continue;
      if (wait > 0) {
        soonest = Math.min(soonest ?? wait, wait);
        continue;
      }
      asked.set(path, modified);
      void thumbnails.request({ path: createVaultPath(path), asked: false });
    }
    if (soonest === null) return;
    const timer = setTimeout(() => setTick((count) => count + 1), soonest);
    return () => clearTimeout(timer);
  }, [pages, pictured, thumbnails, now, tick]);
}

/**
 * The picture of a note's page as a card or a row loads it: null until there
 * is one, and changed each time it is made again so it is loaded again.
 */
export function pagePictureSrc({
  path,
  pictured,
  queue,
}: {
  path: VaultPath;
  pictured: ReadonlyMap<string, number> | null;
  queue: ThumbnailSnapshot;
}): string | null {
  const made = queue.made(path);
  if (made === 0 && pictured?.has(pageThumbnailPath(path)) !== true) return null;
  return remadeCover(pageThumbnailSrc(path), made);
}
