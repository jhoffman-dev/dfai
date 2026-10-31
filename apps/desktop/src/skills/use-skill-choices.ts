import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { skillRunProblem } from '@dfai/domain';
import { listSkills, type MarkdownPort, type VaultFsPort } from '@dfai/application';
import type { SkillChoice } from '@dfai/ui';
import { vaultReadKey } from '../reads/query-client.ts';

const NONE: readonly SkillChoice[] = [];

/**
 * The vault's skills, for the automation editor's picker (#169), each with
 * why a run could not ask with it, if it could not (`skillRunProblem`). The
 * Skills page's own read, under its key, so either page reads them once and a
 * change in `.atlas/skills` reads them again; asked only while `enabled`, so
 * nothing is read at launch. A read that fails offers no skills: the picker
 * still shows the one a rule names, and its run says what is wrong.
 */
export function useSkillChoices(read: SkillChoicesRead): readonly SkillChoice[] {
  return useSkillChoicesRead(read).choices;
}

interface SkillChoicesRead {
  /** Null while no vault is open: nothing is read. */
  fs: VaultFsPort | null;
  markdown: MarkdownPort;
  vault: string | null;
  enabled: boolean;
}

/** The same read, and whether it is still under way: the chat's picker says so (#169). */
export function useSkillChoicesRead({ fs, markdown, vault, enabled }: SkillChoicesRead): {
  readonly choices: readonly SkillChoice[];
  readonly loading: boolean;
} {
  const { data, isLoading } = useQuery({
    queryKey: vaultReadKey(vault ?? '', 'skills'),
    queryFn: () => (fs === null ? [] : listSkills({ fs, markdown })),
    enabled: enabled && vault !== null && fs !== null,
  });
  const choices = useMemo(
    () =>
      data === undefined
        ? NONE
        : data.map((skill) => ({
            name: skill.name,
            unusable: skillRunProblem(skill)?.kind ?? null,
          })),
    [data],
  );
  return useMemo(() => ({ choices, loading: isLoading }), [choices, isLoading]);
}
