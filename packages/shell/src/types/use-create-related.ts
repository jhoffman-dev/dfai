import { useCallback } from 'react';
import {
  createRelatedNote,
  type DefinedType,
  type MarkdownPort,
  type RelatedNote,
  type VaultFsPort,
} from '@dfai/application';
import { relatedNoteKind, type VaultPath } from '@dfai/domain';
import type { CreateRelated } from '@dfai/ui';
import { localToday } from '../today.ts';

/** What a note made from a relation's picker is made with. */
type CreateRelatedPorts = {
  fs: VaultFsPort;
  markdown: MarkdownPort;
  types: readonly DefinedType[];
  notePaths: readonly VaultPath[];
  beside: VaultPath | null;
  onChanged: () => void;
};

/**
 * "Create company '…'" in a relation's picker, for the note at `beside`:
 * makes the note through `createRelatedNote` and answers with the link the
 * relation writes — "Create area" a Project whose PARA is area (#213). A type
 * the vault no longer defines is refused in so many words.
 */
export function useCreateRelated(ports: CreateRelatedPorts): CreateRelated {
  const make = useMakeRelated(ports);
  return useCallback(async (request) => `[[${(await make(request)).target}]]`, [make]);
}

/**
 * The note {@link useCreateRelated} makes, as made: where it is and how a
 * link to it is written — for a picker valued by path, as the Inbox's is.
 */
export function useMakeRelated({
  fs,
  markdown,
  types,
  notePaths,
  beside,
  onChanged,
}: CreateRelatedPorts): (request: { target: string; name: string }) => Promise<RelatedNote> {
  return useCallback(
    async ({ target, name }) => {
      const kind = relatedNoteKind({ target, types });
      if (kind === null) throw new Error(`There is no ${target} type to make one of.`);
      const made = await createRelatedNote({
        fs,
        markdown,
        type: kind.type,
        values: kind.values,
        name,
        beside,
        notePaths,
        today: localToday(),
      });
      onChanged();
      return made;
    },
    [fs, markdown, types, notePaths, beside, onChanged],
  );
}
