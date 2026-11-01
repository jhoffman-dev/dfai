import { useCallback, useEffect, useState } from 'react';
import {
  ARTIFACT_KEYS,
  clearedCover,
  isArtifactLink,
  isArtifactNote,
  savedCopyValues,
  savedFolderOf,
} from '@dfai/domain';
import {
  addArtifactCopy,
  ArtifactRefusedError,
  loadArtifactCopy,
  type ActivityLog,
  type Clock,
  type ExternalLinkPort,
  type OpenNote,
  type PropertyChanges,
  type ThumbnailQueue,
  type VaultFsPort,
} from '@dfai/application';
import type { ArtifactViewerCopy } from '@dfai/ui';
import { withGiveUpRecorded } from '../activity/with-give-up-recorded.ts';
import { pickedFiles } from './picked-files.ts';
import { remadeCover, useThumbnailSnapshot } from './use-thumbnails.ts';

/** An artifact's thumbnail, as its note shows it. */
export interface ArtifactThumbnailView {
  /** The cover the note holds; null for none. */
  readonly cover: string | null;
  /** What to load for it: changed each time one is made, so a remade picture is loaded again. */
  readonly shown: string | null;
  readonly generating: boolean;
  /** Why the last try failed; null when it did not. */
  readonly failure: string | null;
  /** Whether there is a copy to picture. */
  readonly canGenerate: boolean;
  readonly regenerate: () => void;
  readonly clear: () => void;
}

/** What the pane shows under an artifact's properties; null for any other note. */
export interface ArtifactCopyView {
  readonly url: string | null;
  readonly copy: ArtifactViewerCopy;
  readonly adding: boolean;
  readonly error: string | null;
  readonly openLink: () => void;
  readonly reload: () => void;
  readonly addCopy: (files: File[]) => void;
  readonly thumbnail: ArtifactThumbnailView;
}

/**
 * An artifact note's saved copy, read from the vault and made into one
 * document for the frame — again whenever the note names another folder, or
 * Reload asks. Files dropped on a note with no copy become its copy, and the
 * note is told through its pane, which owns its writes; the copy is then
 * pictured for its thumbnail.
 */
export function useArtifactCopy({
  note,
  fs,
  clock,
  links,
  thumbnails,
  setProperties,
  activity,
  onChanged,
}: {
  note: OpenNote | null;
  fs: VaultFsPort;
  clock: Clock;
  links: ExternalLinkPort;
  thumbnails: ThumbnailQueue;
  setProperties: (changes: PropertyChanges) => Promise<void>;
  /** Where a copy that could not be saved is recorded. */
  activity: Pick<ActivityLog, 'inOpenVault'>;
  onChanged: () => void;
}): ArtifactCopyView | null {
  const isArtifact = note !== null && isArtifactNote(note.properties);
  const saved = note === null ? null : savedFolderOf(note.properties);
  const url = linkOf(note);
  const path = note?.path ?? null;
  const [copy, setCopy] = useState<ArtifactViewerCopy>({ kind: 'loading' });
  const [reads, setReads] = useState(0);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isArtifact) return;
    let cancelled = false;
    setCopy({ kind: 'loading' });
    void loadArtifactCopy({ fs, properties: saved === null ? {} : { saved } })
      .then((loaded) => {
        if (!cancelled) setCopy(loaded.kind === 'ready' ? loaded : { kind: loaded.kind });
      })
      .catch(() => {
        // Anything unreadable shows as a copy that is not there, never as a broken page.
        if (!cancelled) setCopy({ kind: 'missing' });
      });
    return () => {
      cancelled = true;
    };
  }, [fs, isArtifact, saved, reads]);

  const addCopy = useCallback(
    (files: File[]) => {
      if (path === null) return;
      setAdding(true);
      const named = { activity, write: 'artifact', path, refusal: ArtifactRefusedError } as const;
      void withGiveUpRecorded(named, async () => {
        const inputs = await pickedFiles(files);
        const { copy: added } = await addArtifactCopy({
          fs,
          notePath: path,
          files: inputs,
          today: clock.today(),
        });
        await setProperties(savedCopyValues(added));
      })
        .then(() => {
          setError(null);
          onChanged();
          void thumbnails.request({ path, asked: false });
        })
        .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
        .finally(() => setAdding(false));
    },
    [fs, path, clock, setProperties, activity, onChanged, thumbnails],
  );
  const thumbnail = useThumbnail({
    note,
    thumbnails,
    canGenerate: copy.kind === 'ready',
    setProperties,
  });

  const openLink = useCallback(() => {
    if (url !== null) void links.open(url).catch((cause: unknown) => setError(String(cause)));
  }, [links, url]);
  const reload = useCallback(() => setReads((count) => count + 1), []);

  if (!isArtifact) return null;
  return { url, copy, adding, error, openLink, reload, addCopy, thumbnail };
}

/** The note's thumbnail: where it is, whether one is being made, and the two things to do with it. */
function useThumbnail({
  note,
  thumbnails,
  canGenerate,
  setProperties,
}: {
  note: OpenNote | null;
  thumbnails: ThumbnailQueue;
  canGenerate: boolean;
  setProperties: (changes: PropertyChanges) => Promise<void>;
}): ArtifactThumbnailView {
  const queue = useThumbnailSnapshot(thumbnails);
  const path = note?.path ?? null;
  const cover = coverOf(note);
  const state = path === null ? null : queue.state(path);
  const made = path === null ? 0 : queue.made(path);

  const regenerate = useCallback(() => {
    if (path !== null) void thumbnails.request({ path, asked: true });
  }, [path, thumbnails]);
  const clear = useCallback(() => {
    setProperties(clearedCover()).catch(() => {
      // Refused only while the note is still opening or changed underneath the
      // pane, which the pane already shows; the cover is then simply as it was.
    });
  }, [setProperties]);

  return {
    cover,
    shown: cover === null ? null : remadeCover(cover, made),
    generating: state?.kind === 'generating',
    failure: state?.kind === 'failed' ? state.reason : null,
    canGenerate,
    regenerate,
    clear,
  };
}

function coverOf(note: OpenNote | null): string | null {
  const cover = note?.properties[ARTIFACT_KEYS.cover];
  return typeof cover === 'string' && cover.trim() !== '' ? cover.trim() : null;
}

function linkOf(note: OpenNote | null): string | null {
  const url = note?.properties[ARTIFACT_KEYS.url];
  return typeof url === 'string' && isArtifactLink(url) ? url.trim() : null;
}
