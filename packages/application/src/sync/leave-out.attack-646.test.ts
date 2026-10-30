import { describe, expect, it } from 'vitest';
import { createVaultPath, type VaultEntry } from '@dfai/domain';
import { memorySyncFiles, said, scriptedGit, statusText } from '../testing/fake-git.ts';
import { leaveOut } from './leave-out.ts';

/*
 * Attack on PR #646 (#169): a skill that is a link to another skill in the
 * vault. Git tracks the link itself, `.atlas/skills/alias`, as one entry; the
 * host lists it as a folder, now marked `link`, holding the real skill's files.
 */

const dir = (path: string, link = false): VaultEntry => ({
  kind: 'directory',
  name: path.split('/').at(-1) ?? '',
  path: createVaultPath(path),
  ...(link && { link: true as const }),
});
const file = (path: string): VaultEntry => ({
  kind: 'file',
  name: path.split('/').at(-1) ?? '',
  path: createVaultPath(path),
  modified: 0,
  size: 1,
});

const listings: Record<string, VaultEntry[]> = {
  '.atlas': [dir('.atlas/skills')],
  '.atlas/skills': [dir('.atlas/skills/real'), dir('.atlas/skills/alias', true)],
  '.atlas/skills/real': [file('.atlas/skills/real/SKILL.md')],
  // The host follows a link inside the vault, so the alias lists the real skill's file.
  '.atlas/skills/alias': [file('.atlas/skills/alias/SKILL.md')],
};

const fs = {
  listDirectory: async (folder: ReturnType<typeof createVaultPath>) => {
    const entries = listings[folder];
    if (entries === undefined) throw new Error('no such folder');
    return entries;
  },
};

describe('attack-646: leaveOut with a skill linked to another skill', () => {
  // atlasIgnored walks into the link and finds `.atlas/skills/alias/SKILL.md`,
  // which git can never track (the link is the tracked entry), so every sync
  // warns that the person's .gitignore leaves `.atlas/skills/` out — though
  // both the link and the real skill are in git. The new `link` flag is there
  // to stop the walk; leave-out.ts does not read it.
  it.fails(
    'names nothing as ignored when git tracks the link and the skill it points at',
    async () => {
      const { git } = scriptedGit({
        script: { status: said(statusText()) },
        vault: new Map([
          ['.atlas/skills/real/SKILL.md', 'real'],
          ['.atlas/skills/alias', '../real'],
        ]),
      });
      const { port: files } = memorySyncFiles();

      const { ignored } = await leaveOut({ git, fs, files });

      expect(ignored).toEqual([]);
    },
  );
});
