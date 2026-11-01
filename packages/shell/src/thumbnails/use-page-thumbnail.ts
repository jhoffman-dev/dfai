import { useCallback, useMemo, useState } from 'react';
import {
  chosenThumbnail,
  clearedThumbnail,
  noteThumbnailKey,
  thumbnailValue,
  type ObjectType,
} from '@dfai/domain';
import {
  embedImage,
  type ImageProbePort,
  type OpenNote,
  type PropertyChanges,
  type ThumbnailQueue,
  type VaultFsPort,
} from '@dfai/application';
import { useThumbnailSnapshot } from '../artifacts/use-thumbnails.ts';
import type { ImagePlacementStore } from '../notes/browser-image-placement-store.ts';
import { epochNow } from '../today.ts';
import { pageThumbnailState, type PageThumbnailState } from './page-thumbnail-view.ts';
import { usePageThumbnailRefresh, usePicturedPages } from './use-page-thumbnails.ts';

/** What saving a chosen picture into the vault needs, as embedding an image does. */
export interface ChosenImagePorts {
  readonly fs: VaultFsPort;
  readonly probe: ImageProbePort;
  readonly placement: ImagePlacementStore;
  /** Local time, `YYYY-MM-DDTHH:mm:ss`. */
  readonly now: () => string;
  /** Told once a picture is written, so the tree and the index see the new file. */
  readonly onSaved: () => void;
}

/** A note's thumbnail property, as its row shows it, and what can be done to it. */
export interface PageThumbnailView extends PageThumbnailState {
  readonly regenerate: () => void;
  readonly clear: () => void;
  readonly choose: (file: File) => void;
}

/**
 * The thumbnail of a note whose type has a thumbnail property (or that has
 * one of its own): what it shows, and Regenerate, Clear and Choose image….
 * While the value is `auto`, the page is pictured again once the note has
 * been saved and left quiet; null for a note with no thumbnail property, and
 * for an artifact, whose row is its own.
 */
export function usePageThumbnail({
  note,
  type,
  thumbnails,
  ports,
  setProperties,
}: {
  note: OpenNote | null;
  type: ObjectType | undefined;
  thumbnails: ThumbnailQueue;
  ports: ChosenImagePorts;
  setProperties: (changes: PropertyChanges) => Promise<void>;
}): PageThumbnailView | null {
  const queue = useThumbnailSnapshot(thumbnails);
  const pictured = usePicturedPages(ports.fs, thumbnails);
  const [chooseError, setChooseError] = useState<string | null>(null);
  const key = note === null ? null : noteThumbnailKey({ type, properties: note.properties });
  const value = key === null || note === null ? null : thumbnailValue(note.properties[key]);
  const pages = useMemo(
    () =>
      note !== null && value?.kind === 'auto' ? [{ path: note.path, modified: note.modified }] : [],
    [note, value?.kind],
  );
  usePageThumbnailRefresh({ pages, pictured, thumbnails, now: epochNow });
  const actions = usePageThumbnailActions({ note, key, thumbnails, ports, setProperties });
  const choose = useCallback(
    (file: File) => {
      setChooseError(null);
      actions.choose(file).catch((cause: unknown) => setChooseError(messageOf(cause)));
    },
    [actions],
  );

  const shown = pageThumbnailState({ note, type, queue, pictured, chooseError });
  if (shown === null) return null;
  return { ...shown, regenerate: actions.regenerate, clear: actions.clear, choose };
}

function usePageThumbnailActions({
  note,
  key,
  thumbnails,
  ports,
  setProperties,
}: {
  note: OpenNote | null;
  key: string | null;
  thumbnails: ThumbnailQueue;
  ports: ChosenImagePorts;
  setProperties: (changes: PropertyChanges) => Promise<void>;
}) {
  const path = note?.path ?? null;
  const regenerate = useCallback(() => {
    if (path !== null) void thumbnails.request({ path, asked: true });
  }, [path, thumbnails]);
  const clear = useCallback(() => {
    if (key === null) return;
    setProperties(clearedThumbnail(key)).catch(() => {
      // Refused only while the note is still opening or changed underneath the
      // pane, which the pane already shows; the value is then simply as it was.
    });
  }, [key, setProperties]);
  const choose = useCallback(
    async (file: File) => {
      if (path === null || key === null) return;
      const { fs, probe, placement, now, onSaved } = ports;
      const saved = await embedImage({
        fs,
        probe,
        notePath: path,
        image: { name: file.name, mimeType: file.type, size: file.size, origin: 'file' },
        readBytes: async () => new Uint8Array(await file.arrayBuffer()),
        placement: placement.read(),
        now: now(),
      });
      onSaved();
      await setProperties(chosenThumbnail(key, saved.path));
    },
    [path, key, ports, setProperties],
  );
  return useMemo(() => ({ regenerate, clear, choose }), [regenerate, clear, choose]);
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
