import { useCallback } from 'react';
import { newPropertyValue, type PropertyKind } from '@dfai/domain';
import {
  addTypeProperty,
  type DefinedType,
  type MarkdownPort,
  type VaultFsPort,
} from '@dfai/application';
import type { NewProperty } from '@dfai/ui';
import type { ReadTypesAgain } from './use-types.ts';

/**
 * "Add a property" on a note: onto its type, so every note of the type has it,
 * or into this note alone.
 *
 * Onto the type, the type file is written and the types read again, which is
 * what puts the row on the page. Into the note, it goes through the pane's own
 * property write — an edit in progress is saved with it, never lost to it —
 * starting at the empty value of its kind.
 */
export function useAddProperty({
  fs,
  markdown,
  typeName,
  types,
  setProperty,
  rememberKind,
  onTypeSaved,
}: {
  fs: VaultFsPort;
  markdown: MarkdownPort;
  typeName: string | null;
  types: readonly DefinedType[];
  setProperty: (key: string, value: unknown) => void;
  rememberKind: (key: string, kind: PropertyKind) => void;
  /** Reads the types, the tree and the index again after a type file is written. */
  onTypeSaved: ReadTypesAgain;
}): (property: NewProperty) => Promise<string> {
  return useCallback(
    async (property: NewProperty) => {
      if (property.scope === 'note') {
        rememberKind(property.key, property.kind);
        setProperty(property.key, newPropertyValue(property.kind));
        return property.key;
      }
      const type = types.find((candidate) => candidate.name === typeName);
      if (type === undefined) throw new Error(`There is no type called “${typeName ?? ''}”`);
      const added = await addTypeProperty({
        fs,
        markdown,
        type,
        types: types.map((candidate) => candidate.name),
        property,
      });
      void onTypeSaved();
      return added.key;
    },
    [fs, markdown, typeName, types, setProperty, rememberKind, onTypeSaved],
  );
}
