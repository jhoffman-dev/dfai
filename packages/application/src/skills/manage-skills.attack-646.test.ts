import { describe, expect, it } from 'vitest';
import { createVaultPath, type VaultEntry } from '@dfai/domain';
import { fakeMarkdown, fakeVaultFs } from '../testing/fake-ports.ts';
import { VaultAccessError } from '../vault/ports.ts';
import { deleteSkill } from './manage-skills.ts';
import { readSkill } from './skills.ts';

/*
 * Attack on PR #646 (#169): a real skill folder whose SKILL.md — not the
 * folder — is a link out of the vault. The host lists SKILL.md as a file
 * marked `link`, and refuses to read it with "path escapes the vault".
 */

const ESCAPES = 'path escapes the vault';
const FOLDER = '.atlas/skills/weekly-review';
const markdown = fakeMarkdown();

function skillMdLinkedOut() {
  const trashed: string[] = [];
  const listings: Record<string, VaultEntry[]> = {
    '.atlas/skills': [{ kind: 'directory', name: 'weekly-review', path: createVaultPath(FOLDER) }],
    [FOLDER]: [
      {
        kind: 'file',
        name: 'SKILL.md',
        path: createVaultPath(`${FOLDER}/SKILL.md`),
        modified: 1,
        size: 10,
        link: true,
      },
    ],
  };
  const fs = fakeVaultFs({
    listDirectory: async (path) => {
      const entries = listings[path];
      if (entries === undefined) throw new VaultAccessError('no such folder');
      return entries;
    },
    readTextFile: async () => {
      throw new VaultAccessError(ESCAPES);
    },
    trashEntry: async ({ path }) => {
      trashed.push(path);
    },
  });
  return { fs, trashed };
}

describe('attack-646: a real skill folder whose SKILL.md links out of the vault', () => {
  // The PR deletes a folder that is a link "whatever it points at, readable or
  // not", and a real folder holding a linked-out subfolder: the Trash takes a
  // link as a link. A linked-out SKILL.md is the same — trashing the folder
  // takes only the link — yet deleteSkill refuses it as unreadable, and the
  // person has no way to delete the skill in the app.
  it.fails('is deleted: the Trash takes the folder, and SKILL.md goes as the link', async () => {
    const { fs, trashed } = skillMdLinkedOut();
    const skill = await readSkill({ fs, markdown, name: 'weekly-review' });
    if (skill === null) throw new Error('no skill');

    await deleteSkill({ fs, skill });

    expect(trashed).toEqual([FOLDER]);
  });

  // "...and says why" (#169): a linked-out folder is told with the host's
  // reason; a linked-out SKILL.md gets only the generic "may be too large,
  // not text, or not allowed", though the listing marks it a link.
  it.fails('says why it cannot be read: SKILL.md is a link the host refuses', async () => {
    const { fs } = skillMdLinkedOut();

    const skill = await readSkill({ fs, markdown, name: 'weekly-review' });

    const why = skill?.problems.find((problem) => problem.field === 'file')?.message ?? '';
    expect(why).toMatch(/link|escapes the vault/);
  });
});
