import { useCallback, useEffect, useState } from 'react';
import {
  artifactKind,
  createVaultPath,
  kindFromHtml,
  noteTitle,
  type VaultPath,
} from '@dfai/domain';
import {
  ArtifactRefusedError,
  notesInUseOfType,
  saveArtifact,
  type ActivityLog,
  type Clock,
  type IndexPort,
  type MarkdownPort,
  type ThumbnailQueue,
  type VaultFsPort,
} from '@dfai/application';
import type { ArtifactChoice, NewArtifactDraft } from '@dfai/ui';
import { withGiveUpRecorded } from '../activity/with-give-up-recorded.ts';
import { pageTextOf, pickedFiles, titleFromFiles } from './picked-files.ts';

const EMPTY: NewArtifactDraft = { url: '', title: '', kind: 'page', project: '', files: [] };

/**
 * The New artifact dialog: what it holds, what it guesses, and saving it.
 *
 * The kind follows the link, then the page, until the person picks one
 * themselves; after that it is theirs. A refusal stays in the dialog. A
 * saved copy is pictured for its thumbnail once it is on disk, without the
 * dialog waiting for it.
 */
export function useNewArtifact({
  thumbnails,
  fs,
  markdown,
  index,
  clock,
  indexKey,
  activity,
  onCreated,
}: {
  thumbnails: Pick<ThumbnailQueue, 'request'>;
  fs: VaultFsPort;
  markdown: MarkdownPort;
  index: IndexPort;
  clock: Clock;
  indexKey: string;
  /** Where an artifact that could not be saved is recorded. */
  activity: Pick<ActivityLog, 'inOpenVault'>;
  onCreated: (path: VaultPath) => void;
}) {
  const [draft, setDraft] = useState<NewArtifactDraft>(EMPTY);
  const [kindChosen, setKindChosen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const projects = useProjects(index, indexKey);

  const start = useCallback((url = '') => {
    setDraft({ ...EMPTY, url, kind: url === '' ? 'page' : artifactKind({ url }) });
    setKindChosen(false);
    setError(null);
  }, []);

  const change = useCallback(
    (next: NewArtifactDraft) => {
      const chosen = kindChosen || next.kind !== draft.kind;
      if (chosen !== kindChosen) setKindChosen(chosen);
      const filesChanged = next.files !== draft.files && next.files.length > 0;
      const title = next.title === '' && filesChanged ? titleFromFiles(next.files) : next.title;
      const kind = chosen || next.url === draft.url ? next.kind : artifactKind({ url: next.url });
      setDraft({ ...next, title, kind });
      if (!chosen && filesChanged) {
        void pageTextOf(next.files).then((html) => {
          if (html !== null) setDraft((now) => ({ ...now, kind: kindFromHtml(html) }));
        });
      }
    },
    [draft, kindChosen],
  );

  const create = useCallback(async () => {
    setSaving(true);
    try {
      const named = {
        activity,
        write: 'artifact',
        path: null,
        refusal: ArtifactRefusedError,
      } as const;
      const saved = await withGiveUpRecorded(named, async () =>
        saveArtifact({
          fs,
          markdown,
          clock,
          artifact: { ...artifactOf(draft), files: await pickedFiles(draft.files) },
        }),
      );
      setError(null);
      onCreated(saved.path);
      if (saved.saved !== null) void thumbnails.request({ path: saved.path, asked: false });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }, [fs, markdown, clock, draft, activity, onCreated, thumbnails]);

  return { draft, error, saving, projects, start, change, create };
}

function artifactOf(draft: NewArtifactDraft) {
  return {
    title: draft.title,
    kind: draft.kind,
    ...(draft.url.trim() !== '' && { url: draft.url.trim() }),
    ...(draft.project !== '' && { project: draft.project }),
  };
}

/** The projects an artifact can belong to, by the name its relation links. */
function useProjects(index: IndexPort, indexKey: string): readonly ArtifactChoice[] {
  const [projects, setProjects] = useState<readonly ArtifactChoice[]>([]);
  useEffect(() => {
    let cancelled = false;
    notesInUseOfType({ index, type: 'project' })
      .then((notes) => {
        if (cancelled) return;
        setProjects(
          notes.map((note) => ({
            value: noteTitle(createVaultPath(note.path)),
            label: note.title,
          })),
        );
      })
      // No index yet, or none that answers: the dialog offers no projects.
      .catch(() => setProjects([]));
    return () => {
      cancelled = true;
    };
  }, [index, indexKey]);
  return projects;
}
