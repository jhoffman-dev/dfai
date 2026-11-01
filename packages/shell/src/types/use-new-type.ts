import { useCallback, useState } from 'react';
import type { SidebarIcon } from '@dfai/domain';
import {
  createObjectType,
  type DefinedType,
  type MarkdownPort,
  type VaultFsPort,
} from '@dfai/application';

/**
 * Making a type from the sidebar's "+": the file is written, and the new type
 * is handed on to be opened. A refusal — a taken name, a reserved one — stays
 * on screen in the dialog rather than closing it.
 */
export function useNewType({
  fs,
  markdown,
  types,
  onCreated,
}: {
  fs: VaultFsPort;
  markdown: MarkdownPort;
  types: readonly DefinedType[];
  onCreated: (type: DefinedType) => void;
}) {
  const [error, setError] = useState<string | null>(null);

  const create = useCallback(
    ({ label, icon }: { label: string; icon: SidebarIcon | null }) => {
      createObjectType({ fs, markdown, label, icon, existing: types })
        .then((type) => {
          setError(null);
          onCreated(type);
        })
        .catch((cause: unknown) =>
          setError(cause instanceof Error ? cause.message : String(cause)),
        );
    },
    [fs, markdown, types, onCreated],
  );

  const reset = useCallback(() => setError(null), []);

  return { error, create, reset };
}
