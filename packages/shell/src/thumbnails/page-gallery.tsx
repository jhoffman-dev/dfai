import { useMemo } from 'react';
import { createVaultPath } from '@dfai/domain';
import type { ThumbnailQueue, VaultFsPort } from '@dfai/application';
import { GalleryView, type CoverSource } from '@dfai/ui';
import { useThumbnailSnapshot } from '../artifacts/use-thumbnails.ts';
import { epochNow } from '../today.ts';
import {
  pagePictureSrc,
  usePageThumbnailRefresh,
  usePicturedPages,
  type PageToPicture,
} from './use-page-thumbnails.ts';

/**
 * A gallery of notes whose type has a thumbnail property: each card fronted
 * by the picture it chose, or by a picture of its page — made when there is
 * none or the note has changed since, and kept in the cache. A card whose
 * page has not been pictured yet shows none until it has.
 */
export function PageGallery({
  covers,
  pages,
  thumbnails,
  fs,
  ...gallery
}: Omit<Parameters<typeof GalleryView>[0], 'covers' | 'fronts'> & {
  covers: CoverSource;
  pages: readonly PageToPicture[];
  thumbnails: ThumbnailQueue;
  fs: VaultFsPort;
}) {
  const queue = useThumbnailSnapshot(thumbnails);
  const pictured = usePicturedPages(fs, thumbnails);
  usePageThumbnailRefresh({ pages, pictured, thumbnails, now: epochNow });
  const shown = useMemo<CoverSource>(() => {
    const paged = new Set(pages.map((page) => page.path));
    return {
      coverOf: (path) =>
        paged.has(path)
          ? pagePictureSrc({ path: createVaultPath(path), pictured, queue })
          : covers.coverOf(path),
      load: covers.load,
    };
  }, [covers, pages, pictured, queue]);
  return <GalleryView {...gallery} covers={shown} fronts="screen" />;
}
