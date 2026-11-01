import { useCallback, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  loadTemplates,
  readTemplate,
  type NoteTemplate,
  type VaultFsPort,
} from '@dfai/application';
import { vaultReadKey } from '../reads/query-client.ts';
import { readState, type ReadState } from '../reads/read-state.ts';

/** The templates folder as listed, or where listing it has got to. */
export type TemplatesState = ReadState<{ readonly templates: readonly NoteTemplate[] }>;

const NO_TEMPLATES: readonly NoteTemplate[] = [];

/**
 * The templates the vault offers, listed once per vault and again when its
 * templates folder changes (#259): one copy for the new-note menu and the
 * Templates page.
 */
export function useTemplates({ fs, vaultKey }: { fs: VaultFsPort; vaultKey: string | null }): {
  /** For the menus: none while listing, or when the folder could not be listed. */
  templates: readonly NoteTemplate[];
  listed: TemplatesState;
  contentsOf: (template: NoteTemplate) => Promise<string>;
} {
  const { data, error } = useQuery({
    queryKey: vaultReadKey(vaultKey ?? '', 'templates'),
    queryFn: () => loadTemplates({ fs }),
    enabled: vaultKey !== null,
  });
  const listed = useMemo(
    () =>
      readState({ data, error }, 'The templates could not be read', (templates) => ({
        templates,
      })),
    [data, error],
  );
  return {
    templates: vaultKey === null || error !== null ? NO_TEMPLATES : (data ?? NO_TEMPLATES),
    listed,
    contentsOf: useCallback((template) => readTemplate({ fs, template }), [fs]),
  };
}
