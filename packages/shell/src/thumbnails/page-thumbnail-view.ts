import {
  noteThumbnailKey,
  regenerateDiscards,
  thumbnailValue,
  type ObjectType,
  type VaultPath,
} from '@dfai/domain';
import type { ThumbnailSnapshot } from '@dfai/application';
import { pagePictureSrc } from './use-page-thumbnails.ts';

/** What a note's thumbnail row shows. */
export interface PageThumbnailState {
  /** The property it is kept under. */
  readonly key: string;
  /** The picture it names or DFAI made; null for none (yet). */
  readonly shown: string | null;
  readonly cleared: boolean;
  readonly generating: boolean;
  /** Why the last try failed — to make one, or to keep a chosen one. */
  readonly failure: string | null;
  /** The picture Regenerate would put out of the note for good, which it asks about first. */
  readonly discards: string | null;
}

/**
 * A note's thumbnail row, from the note, the queue and the cache: null for a
 * note with no thumbnail property, and for an artifact, whose row is its own.
 */
export function pageThumbnailState({
  note,
  type,
  queue,
  pictured,
  chooseError,
}: {
  note: { readonly path: VaultPath; readonly properties: Readonly<Record<string, unknown>> } | null;
  type: ObjectType | undefined;
  queue: ThumbnailSnapshot;
  pictured: ReadonlyMap<string, number> | null;
  /** Why the last picture chosen could not be kept; null when it could. */
  chooseError: string | null;
}): PageThumbnailState | null {
  if (note === null) return null;
  const { path, properties } = note;
  const key = noteThumbnailKey({ type, properties });
  if (key === null) return null;
  const value = thumbnailValue(properties[key]);
  const state = queue.state(path);
  return {
    key,
    shown:
      value.kind === 'chosen'
        ? value.src
        : value.kind === 'auto'
          ? pagePictureSrc({ path, pictured, queue })
          : null,
    cleared: value.kind === 'cleared',
    generating: state?.kind === 'generating',
    failure: chooseError ?? (state?.kind === 'failed' ? state.reason : null),
    discards: regenerateDiscards({ properties, thumbnailKey: key, notePath: path }),
  };
}
