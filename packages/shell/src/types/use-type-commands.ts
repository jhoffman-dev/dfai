import { useCallback } from 'react';
import type { VaultPath } from '@dfai/domain';
import type { DefinedType, MarkdownPort, VaultFsPort } from '@dfai/application';
import { useNewType } from './use-new-type.ts';
import type { ReadTypesAgain } from './use-types.ts';
import { useNewNoteOfType } from './use-new-note-of-type.ts';

/**
 * What the window does for types, whatever page shows: what follows a save
 * of a type file, a new type (the window's dialog), and a new note of a
 * type. A type's table is its own tab's (`TypeContainer`).
 */
export function useTypeCommands({
  ports,
  types,
  notePaths,
  onChanged,
  reloadTypes,
  onTypeCreated,
  onNoteCreated,
}: {
  ports: {
    fs: VaultFsPort;
    markdown: MarkdownPort;
  };
  types: readonly DefinedType[];
  notePaths: readonly string[];
  /** Re-reads the tree and the index, after something wrote to the vault. */
  onChanged: () => void;
  reloadTypes: ReadTypesAgain;
  onTypeCreated: (type: DefinedType) => void;
  onNoteCreated: (path: VaultPath) => void;
}) {
  const { fs, markdown } = ports;

  /**
   * After the type editor writes a type file: the type, the tree and the index
   * follow. Settles with the types once they have been read again.
   */
  const onTypeSaved = useCallback(() => {
    onChanged();
    return reloadTypes();
  }, [reloadTypes, onChanged]);

  const newType = useNewType({
    fs,
    markdown,
    types,
    onCreated: (created) => {
      void onTypeSaved();
      onTypeCreated(created);
    },
  });

  const newNoteOfType = useNewNoteOfType({
    fs,
    markdown,
    notePaths,
    onCreated: (path) => {
      onChanged();
      onNoteCreated(path);
    },
  });

  return { onTypeSaved, newType, newNoteOfType };
}
