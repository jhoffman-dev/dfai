import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { isPageThumbnailPath } from '@dfai/domain';
import {
  createThumbnailQueue,
  generateThumbnail,
  type DefinedType,
  type PageSnapshotPort,
  type ThumbnailQueue,
  type ThumbnailResult,
  type ThumbnailSnapshot,
} from '@dfai/application';
import type { NotePorts } from '../notes/use-note.ts';
import type { PaneEditors } from '../panes/open-editors.ts';
import { writeNoteProperties } from '../query/use-view-writes.ts';
import { notePageRenderer } from '../thumbnails/note-page-renderer.ts';

/**
 * The thumbnails being made in the vault open now — artifacts' and every
 * other note's — shared by every pane and the gallery. A new queue per
 * vault: `notes` is bound to the vault, so a picture that finishes after a
 * switch is refused rather than written into the next one. A note's
 * properties are written through its pane when one holds it, as any write
 * from outside a pane is; and a page is never pictured unasked while a pane
 * holds edits to it not yet saved — it is being typed in.
 */
export function useThumbnailQueue({
  notes,
  snapshot,
  editors,
  types,
  onChanged,
}: {
  /** Bound to the vault open now: a new vault is a new `notes`, and so a new queue. */
  notes: NotePorts;
  snapshot: PageSnapshotPort;
  editors: PaneEditors;
  /** The vault's types, which say which property a note's thumbnail is. */
  types: readonly DefinedType[];
  /** Re-reads the tree and the index once a thumbnail has been written. */
  onChanged: () => void;
}): ThumbnailQueue {
  const changed = useRef(onChanged);
  const typesNow = useRef(types);
  useEffect(() => {
    changed.current = onChanged;
    typesNow.current = types;
  }, [onChanged, types]);

  return useMemo(() => {
    const { fs, markdown } = notes;
    const deps = { fs, markdown, snapshot, renderer: notePageRenderer };
    return createThumbnailQueue({
      generate: async ({ path, asked }) => {
        let wroteNote = false;
        const result = await generateThumbnail({
          deps,
          typeOf: (name) => typesNow.current.find((type) => type.name === name),
          notePath: path,
          asked,
          unsaved: editors.stateOf(path) === 'dirty',
          setProperties: async (values) => {
            wroteNote = true;
            await writeNoteProperties({ editors, fs, markdown, path, values });
          },
        });
        if (thumbnailWroteVault({ result, wroteNote })) changed.current();
        return result;
      },
    });
  }, [notes, snapshot, editors]);
}

/**
 * Whether making a thumbnail wrote into the vault, so the tree and the index
 * must be read again: an artifact's picture, kept in its copy, or a note's
 * properties written. A picture of a page alone is kept in the cache, which
 * neither shows.
 */
export function thumbnailWroteVault({
  result,
  wroteNote,
}: {
  result: ThumbnailResult;
  wroteNote: boolean;
}): boolean {
  return wroteNote || (result.kind === 'made' && !isPageThumbnailPath(result.path));
}

/**
 * The queue of the vault open now, as one object for the life of the app — so
 * the local API, which serves once, reaches the queue a request arrives in.
 */
export function useThumbnailsNow(
  queue: Pick<ThumbnailQueue, 'requestOrFail'>,
): Pick<ThumbnailQueue, 'requestOrFail'> {
  const current = useRef(queue);
  useEffect(() => {
    current.current = queue;
  }, [queue]);
  return useMemo(() => ({ requestOrFail: (job) => current.current.requestOrFail(job) }), []);
}

/**
 * A cover as it should be loaded once its thumbnail has been made `made`
 * times: marked with the count after `#`, which no image lookup reads, so a
 * picture made again under the same name is loaded again rather than the one
 * already on screen.
 */
export function remadeCover(cover: string, made: number): string {
  return made === 0 ? cover : `${cover}#${made}`;
}

/** The queue as it stands, re-rendering whenever it changes. */
export function useThumbnailSnapshot(queue: ThumbnailQueue): ThumbnailSnapshot {
  return useSyncExternalStore(queue.subscribe, queue.snapshot);
}
