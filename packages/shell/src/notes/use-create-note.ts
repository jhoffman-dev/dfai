import { useCallback, useState } from 'react';
import { DEFAULT_NOTE_NAME, splitFrontmatter, type VaultPath } from '@dfai/domain';
import {
  captureToInbox,
  createNote,
  ensureDailyNote,
  templateNoteName,
  type MarkdownPort,
  type NoteTemplate,
  type VaultFsPort,
} from '@dfai/application';
import { localToday } from '../today.ts';

/**
 * Adds a note to the vault and opens it.
 *
 * The new note goes beside the one in view — or, made from a template that is a
 * dashboard or a view, with the others of its kind — and its name is numbered if
 * that one is taken, so the button never has to refuse.
 */
export function useCreateNote({
  fs,
  markdown,
  notePaths,
  beside,
  templates,
  contentsOf,
  onCreated,
}: {
  fs: VaultFsPort;
  markdown: MarkdownPort;
  notePaths: readonly VaultPath[];
  /** The note in view as the note is made, which the new one goes beside. */
  beside: () => VaultPath | null;
  templates: readonly NoteTemplate[];
  contentsOf: (template: NoteTemplate) => Promise<string>;
  onCreated: (path: VaultPath) => void;
}): {
  createNewNote: () => Promise<void>;
  /** A blank note in a folder of the person's choosing: "New note here". */
  createNoteIn: (folder: VaultPath) => Promise<void>;
  createFromTemplate: (templatePath: string) => Promise<void>;
  /** Captures a note with a given name into the Inbox, from a template when there is one. */
  captureNote: (name: string, template: NoteTemplate | null) => Promise<VaultPath | null>;
  /** Today's note, found or made at the root; `today` is `YYYY-MM-DD`. */
  openDailyNote: (today: string) => Promise<VaultPath | null>;
  error: string | null;
} {
  const [error, setError] = useState<string | null>(null);

  const make = useCallback(
    async (
      name: string,
      { contents, folder }: { contents?: string; folder?: VaultPath } = {},
    ): Promise<VaultPath | null> => {
      try {
        const path = await createNote({
          fs,
          markdown,
          today: localToday(),
          name,
          beside: beside(),
          notePaths,
          ...(contents === undefined
            ? {}
            : {
                contents,
                properties: markdown.frontmatterProperties(splitFrontmatter(contents).frontmatter),
              }),
          ...(folder === undefined ? {} : { folder }),
        });
        setError(null);
        onCreated(path);
        return path;
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
        return null;
      }
    },
    [fs, markdown, beside, notePaths, onCreated],
  );

  const captureNote = useCallback(
    async (name: string, template: NoteTemplate | null): Promise<VaultPath | null> => {
      try {
        const contents = template === null ? undefined : await contentsOf(template);
        const path = await captureToInbox({
          fs,
          markdown,
          today: localToday(),
          name,
          notePaths,
          ...(contents === undefined ? {} : { contents }),
        });
        setError(null);
        onCreated(path);
        return path;
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
        return null;
      }
    },
    [fs, markdown, notePaths, contentsOf, onCreated],
  );

  const openDailyNote = useCallback(
    async (today: string): Promise<VaultPath | null> => {
      try {
        const { path, created } = await ensureDailyNote({
          fs,
          markdown,
          today,
          notePaths,
          templates,
        });
        setError(null);
        if (created) onCreated(path);
        return path;
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
        return null;
      }
    },
    [fs, markdown, notePaths, templates, onCreated],
  );

  const createFromTemplate = useCallback(
    async (templatePath: string) => {
      const template = templates.find((candidate) => candidate.path === templatePath);
      if (template === undefined) {
        setError('that template is no longer there');
        return;
      }
      try {
        await make(templateNoteName(template), { contents: await contentsOf(template) });
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [templates, contentsOf, make],
  );

  return {
    createNewNote: useCallback(async () => {
      await make(DEFAULT_NOTE_NAME);
    }, [make]),
    createNoteIn: useCallback(
      async (folder: VaultPath) => {
        await make(DEFAULT_NOTE_NAME, { folder });
      },
      [make],
    ),
    createFromTemplate,
    captureNote,
    openDailyNote,
    error,
  };
}
