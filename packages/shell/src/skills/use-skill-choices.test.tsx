// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { createVaultPath, type VaultEntry } from '@dfai/domain';
import { fakeVaultFs, VaultAccessError } from '@dfai/application';
import { remarkMarkdown } from '@dfai/adapters';
import { queryWrapper } from '../reads/query-wrapper.tsx';
import { useSkillChoices } from './use-skill-choices.ts';

/**
 * #629 review: the editor's skill picker is told which skills a run could
 * not ask with — one with problems the Skills page shows, and one the page
 * passes that is too long to hand over (an emoji counts two there).
 */

const skillFile = (name: string, description: string, instructions: string) =>
  ['---', `name: ${name}`, `description: ${description}`, '---', '', instructions, ''].join('\n');

const FILES: Record<string, string> = {
  '.atlas/skills/good-skill/SKILL.md': skillFile('good-skill', 'Tidies notes.', 'Tidy them.'),
  '.atlas/skills/no-description/SKILL.md': skillFile('no-description', '', 'Tidy them.'),
  '.atlas/skills/emoji-skill/SKILL.md': skillFile('emoji-skill', 'Smiles.', '😀'.repeat(15_000)),
};

const entry = (kind: VaultEntry['kind'], path: string) =>
  ({
    kind,
    name: path.slice(path.lastIndexOf('/') + 1),
    path: createVaultPath(path),
  }) as VaultEntry;

const fs = fakeVaultFs({
  listDirectory: async (path) => {
    if (path === '.atlas/skills') {
      return Object.keys(FILES).map((file) =>
        entry('directory', file.slice(0, -'/SKILL.md'.length)),
      );
    }
    const file = `${path}/SKILL.md`;
    if (FILES[file] !== undefined) return [entry('file', file)];
    throw new VaultAccessError('no such folder');
  },
  readTextFile: async (path) => {
    const text = FILES[path];
    if (text === undefined) throw new VaultAccessError('no such file');
    return { text, modified: 1 };
  },
});

describe('useSkillChoices', () => {
  it('marks each skill a run could not ask with, and why', async () => {
    const { result } = renderHook(
      () =>
        useSkillChoices({ fs, markdown: remarkMarkdown, vault: '/vaults/larkspur', enabled: true }),
      { wrapper: queryWrapper().wrapper },
    );
    await waitFor(() => expect(result.current).toHaveLength(3));
    expect([...result.current].sort((a, b) => a.name.localeCompare(b.name))).toEqual([
      { name: 'emoji-skill', unusable: 'too-long' },
      { name: 'good-skill', unusable: null },
      { name: 'no-description', unusable: 'problems' },
    ]);
  });

  it('reads nothing until it is enabled', async () => {
    let asked = 0;
    const counting = {
      ...fs,
      listDirectory: async (path: Parameters<typeof fs.listDirectory>[0]) => {
        asked += 1;
        return fs.listDirectory(path);
      },
    };
    const { result } = renderHook(
      () =>
        useSkillChoices({
          fs: counting,
          markdown: remarkMarkdown,
          vault: '/vaults/larkspur',
          enabled: false,
        }),
      { wrapper: queryWrapper().wrapper },
    );
    await new Promise((settled) => setTimeout(settled, 0));
    expect(result.current).toEqual([]);
    expect(asked).toBe(0);
  });
});
