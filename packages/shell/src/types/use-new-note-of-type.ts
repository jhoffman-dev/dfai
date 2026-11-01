import { useCallback, useState } from 'react';
import type { ObjectType, VaultPath } from '@dfai/domain';
import { createNoteOfType, type MarkdownPort, type VaultFsPort } from '@dfai/application';
import { localToday } from '../today.ts';

/**
 * "New book" at the foot of a type's table: `createNoteOfType`'s note — from
 * the type's template when it has one — opened once it is written, or why not.
 */
export function useNewNoteOfType({
  fs,
  markdown,
  notePaths,
  onCreated,
}: {
  fs: VaultFsPort;
  markdown: MarkdownPort;
  notePaths: readonly string[];
  onCreated: (path: VaultPath) => void;
}) {
  const [error, setError] = useState<string | null>(null);

  const create = useCallback(
    (type: ObjectType) => {
      createNoteOfType({ fs, markdown, type, notePaths, today: localToday() })
        .then((path) => {
          setError(null);
          onCreated(path);
        })
        .catch((cause: unknown) =>
          setError(cause instanceof Error ? cause.message : String(cause)),
        );
    },
    [fs, markdown, notePaths, onCreated],
  );

  return { create, error };
}
