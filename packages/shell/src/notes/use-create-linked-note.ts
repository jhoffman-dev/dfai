import { useMemo } from 'react';
import { createNote, type MarkdownPort, type VaultFsPort } from '@dfai/application';
import {
  createVaultPath,
  createWikiLinkResolver,
  noteFileName,
  noteTitle,
  wikiLinkTargetFor,
  type VaultPath,
} from '@dfai/domain';
import type { LinkedNoteMaker } from '@dfai/ui';
import { localToday } from '../today.ts';
import type { NotesBeingMade } from './notes-being-made.ts';

/** A name as the notes being made are kept by: the name its file is given, folded. */
const keyOf = (name: string) => noteTitle(createVaultPath(noteFileName(name))).toLowerCase();

/**
 * "Create '<name>'" from the editor's `[[` (#465): makes a blank note of the
 * name typed, where a new note goes from the note in view (`beside`) — as
 * Obsidian makes the note a link names — without opening it, and answers
 * with the link to the note as made: its name cleaned of what a file name
 * cannot hold (`Q3: plan` is `Q3 plan`), or numbered. A note that cannot be
 * made is said through `onProblem`, and the rejection passed on; one made
 * whose link could not be written, too.
 *
 * `named` says which names a note answers to — any note, archived ones too,
 * whose links a new note of that name would take over — and which are being
 * made (`beingMade`, the window's), until the vault's notes list them.
 * Whether a name may be made at all is the domain's rule (`newLinkName`).
 */
export function useCreateLinkedNote({
  fs,
  markdown,
  notePaths,
  beside,
  onChanged,
  onProblem,
  beingMade,
}: {
  fs: VaultFsPort;
  markdown: MarkdownPort;
  notePaths: readonly VaultPath[];
  beside: VaultPath | null;
  onChanged: () => void;
  onProblem: (message: string) => void;
  beingMade: NotesBeingMade;
}): LinkedNoteMaker {
  return useMemo(() => {
    const opens = createWikiLinkResolver(notePaths);
    const listed = new Set(notePaths);
    /** Whether a name is being made: one the vault's notes now list is not, any more. */
    const making = (name: string) => {
      const path = beingMade.get(keyOf(name));
      if (path === undefined) return false;
      if (path === null || !listed.has(path)) return true;
      beingMade.delete(keyOf(name));
      return false;
    };
    return {
      named: (name) => {
        // Asked first, so a note the vault now lists is let go of even when it answers below.
        const pending = making(name);
        return pending || opens(name) !== null;
      },
      make: async (name) => {
        beingMade.set(keyOf(name), null);
        try {
          const path = await createNote({
            fs,
            markdown,
            today: localToday(),
            name,
            beside,
            notePaths,
          });
          beingMade.set(keyOf(name), path);
          onChanged();
          return wikiLinkTargetFor(path, [...notePaths, path]);
        } catch (cause) {
          beingMade.delete(keyOf(name));
          const why = cause instanceof Error ? cause.message : String(cause);
          onProblem(`“${name}” could not be made: ${why}`);
          throw cause;
        }
      },
      notLinked: (name) =>
        onProblem(
          `“${name}” was made, but the link could not be written here: the note changed meanwhile.`,
        ),
    };
  }, [fs, markdown, notePaths, beside, onChanged, onProblem, beingMade]);
}
