import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { listSkills, type MarkdownPort, type VaultFsPort } from '@dfai/application';
import { vaultReadKey } from '../reads/query-client.ts';

const NONE: readonly string[] = [];

/**
 * The vault's skills by name, for the automation editor's picker (#169). The
 * Skills page's own read, under its key, so either page reads them once and a
 * change in `.atlas/skills` reads them again; asked only while `enabled`, so
 * nothing is read at launch. A read that fails offers no skills: the picker
 * still shows the one a rule names, and its run says what is wrong.
 */
export function useSkillNames({
  fs,
  markdown,
  vault,
  enabled,
}: {
  fs: VaultFsPort;
  markdown: MarkdownPort;
  vault: string | null;
  enabled: boolean;
}): readonly string[] {
  const { data } = useQuery({
    queryKey: vaultReadKey(vault ?? '', 'skills'),
    queryFn: () => listSkills({ fs, markdown }),
    enabled: enabled && vault !== null,
  });
  return useMemo(() => (data === undefined ? NONE : data.map((skill) => skill.name)), [data]);
}
