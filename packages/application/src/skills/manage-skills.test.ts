import { describe, expect, it } from 'vitest';
import {
  createVaultPath,
  parentVaultPath,
  SKILL_FILE_UNREADABLE,
  vaultPathName,
  type VaultEntry,
} from '@dfai/domain';
import { NoteChangedError } from '../notes/note-changed-error.ts';
import { fakeMarkdown, fakeVaultFs } from '../testing/fake-ports.ts';
import { VaultAccessError, type VaultFsPort } from '../vault/ports.ts';
import { createSkill, deleteSkill, saveSkill, SkillRefusedError } from './manage-skills.ts';
import { listSkills, readSkill } from './skills.ts';

/**
 * A vault of files and folders in memory that refuses as the host does: a
 * missing file or folder is a `VaultAccessError`, a create never overwrites,
 * and a write is refused when the file changed since `expectedModified`.
 */
function memoryVault(files: Record<string, string> = {}, folders: readonly string[] = []) {
  let clock = 100;
  const notes = new Map(Object.entries(files).map(([path, text]) => [path, { text, modified: 1 }]));
  const dirs = new Set(folders);
  const trashed: string[] = [];
  const writes: string[] = [];
  /** Files the host lists but will not read: too large, or not text. */
  const unreadable = new Set<string>();
  /** Runs as a folder is listed: another program's write in the middle of a walk. */
  const onList = new Map<string, () => void>();
  const allDirs = () => {
    const found = new Set(dirs);
    for (const path of [...notes.keys(), ...dirs]) {
      let parent = parentVaultPath(createVaultPath(path)) as string;
      while (parent !== '') {
        found.add(parent);
        parent = parentVaultPath(createVaultPath(parent));
      }
    }
    return found;
  };
  const entry = (kind: 'file' | 'directory', path: string): VaultEntry =>
    ({
      kind,
      name: vaultPathName(createVaultPath(path)),
      path: createVaultPath(path),
    }) as VaultEntry;
  const fs: VaultFsPort = fakeVaultFs({
    listDirectory: async (folder) => {
      if (folder !== '' && !allDirs().has(folder)) throw new VaultAccessError('no such folder');
      onList.get(folder)?.();
      const under = (path: string) => parentVaultPath(createVaultPath(path)) === folder;
      return [
        ...[...allDirs()].filter(under).map((path) => entry('directory', path)),
        ...[...notes.keys()].filter(under).map((path) => entry('file', path)),
      ];
    },
    readTextFile: async (path) => {
      const note = notes.get(path);
      if (unreadable.has(path)) throw new VaultAccessError('the file is not text');
      if (note === undefined) throw new VaultAccessError('no such file');
      return { ...note };
    },
    createFolder: async ({ path }) => {
      if (allDirs().has(path) || notes.has(path)) throw new VaultAccessError('taken');
      dirs.add(path);
    },
    createNote: async ({ path, contents }) => {
      if (notes.has(path)) throw new VaultAccessError('exists');
      clock += 1;
      notes.set(path, { text: contents, modified: clock });
      writes.push(path);
      return clock;
    },
    writeTextFile: async ({ path, contents, expectedModified }) => {
      if (expectedModified !== null && notes.get(path)?.modified !== expectedModified) {
        throw new VaultAccessError('changed on disk');
      }
      clock += 1;
      notes.set(path, { text: contents, modified: clock });
      writes.push(path);
      return clock;
    },
    trashEntry: async ({ path }) => {
      trashed.push(path);
      for (const key of [...notes.keys()]) if (key.startsWith(`${path}/`)) notes.delete(key);
      for (const dir of [...dirs]) if (dir === path || dir.startsWith(`${path}/`)) dirs.delete(dir);
    },
  });
  /** Another program's edit: the file changes on disk under the app. */
  const editOnDisk = (path: string, text: string) => {
    clock += 1;
    notes.set(path, { text, modified: clock });
  };
  return { fs, notes, trashed, writes, editOnDisk, unreadable, onList };
}

const markdown = fakeMarkdown();
const DRAFT = {
  name: 'weekly-review',
  description: 'Walks through the Friday review.',
  instructions: 'List each project with no next action.',
};
const SKILL_PATH = '.atlas/skills/weekly-review/SKILL.md';
const TEXT =
  '---\nname: weekly-review\ndescription: Walks through it.\nlicense: MIT\n---\n\nStep one.\n';

async function readBack(vault: ReturnType<typeof memoryVault>, name = 'weekly-review') {
  const skill = await readSkill({ fs: vault.fs, markdown, name });
  if (skill === null) throw new Error(`no skill ${name}`);
  return skill;
}

describe('createSkill', () => {
  it('writes the folder and a canonical SKILL.md, making .atlas/skills when it is not there', async () => {
    const vault = memoryVault({}, ['.atlas']);

    const skill = await createSkill({ fs: vault.fs, markdown, draft: DRAFT });

    expect(vault.notes.get(SKILL_PATH)?.text).toBe(
      '---\nname: weekly-review\ndescription: Walks through the Friday review.\n---\n\n' +
        'List each project with no next action.\n',
    );
    expect(skill).toMatchObject({
      name: 'weekly-review',
      folder: '.atlas/skills/weekly-review',
      path: SKILL_PATH,
      problems: [],
    });
    expect(await readBack(vault)).toEqual(skill);
  });

  it('refuses a draft that breaks a rule, writing nothing', async () => {
    const vault = memoryVault({}, ['.atlas']);

    const made = createSkill({ fs: vault.fs, markdown, draft: { ...DRAFT, name: 'ask-claude' } });

    await expect(made).rejects.toThrow(SkillRefusedError);
    await expect(made).rejects.toThrow(/cannot hold “claude”/);
    expect(vault.writes).toEqual([]);
  });

  it('refuses a name that differs only in case from a folder already there', async () => {
    const vault = memoryVault({ '.atlas/skills/Weekly-Review/SKILL.md': TEXT });

    const made = createSkill({ fs: vault.fs, markdown, draft: DRAFT });

    await expect(made).rejects.toThrow('There is already a skill called “weekly-review”.');
    expect(vault.writes).toEqual([]);
  });
});

describe('saveSkill', () => {
  it('changes only the frontmatter key that changed, leaving the rest', async () => {
    const vault = memoryVault({ [SKILL_PATH]: TEXT });
    const skill = await readBack(vault);

    const saved = await saveSkill({
      fs: vault.fs,
      markdown,
      skill,
      draft: { name: 'weekly-review', description: 'New words.', instructions: skill.instructions },
    });

    expect(vault.notes.get(SKILL_PATH)?.text).toBe(
      '---\nname: weekly-review\ndescription: New words.\nlicense: MIT\n---\n\nStep one.\n',
    );
    expect(saved.description).toBe('New words.');
    expect(saved.modified).toBe(vault.notes.get(SKILL_PATH)?.modified);
  });

  it('replaces only the body when only the instructions changed, without touching the frontmatter', async () => {
    const vault = memoryVault({ [SKILL_PATH]: TEXT });
    const skill = await readBack(vault);
    const port = { ...markdown, updateFrontmatter: () => 'rewritten' };

    await saveSkill({
      fs: vault.fs,
      markdown: port,
      skill,
      draft: { name: skill.name, description: skill.description, instructions: 'Step two.' },
    });

    expect(vault.notes.get(SKILL_PATH)?.text).toBe(TEXT.replace('Step one.', 'Step two.'));
  });

  it('writes nothing when nothing changed', async () => {
    const vault = memoryVault({ [SKILL_PATH]: TEXT });
    const skill = await readBack(vault);

    const saved = await saveSkill({
      fs: vault.fs,
      markdown,
      skill,
      draft: { name: skill.name, description: skill.description, instructions: skill.instructions },
    });

    expect(vault.writes).toEqual([]);
    expect(saved).toBe(skill);
  });

  it('refuses a SKILL.md changed on disk since it was read, and leaves the change', async () => {
    const vault = memoryVault({ [SKILL_PATH]: TEXT });
    const skill = await readBack(vault);
    vault.editOnDisk(SKILL_PATH, `${TEXT}Another program wrote this.\n`);

    const saved = saveSkill({
      fs: vault.fs,
      markdown,
      skill,
      draft: { ...DRAFT, description: 'Mine.' },
    });

    await expect(saved).rejects.toThrow(NoteChangedError);
    expect(vault.notes.get(SKILL_PATH)?.text).toBe(`${TEXT}Another program wrote this.\n`);
    expect(vault.writes).toEqual([]);
  });

  it('passes the time and text it read, so the host refuses a change it could not see', async () => {
    const vault = memoryVault({ [SKILL_PATH]: TEXT });
    const skill = await readBack(vault);
    const asked: unknown[] = [];
    const fs = {
      ...vault.fs,
      writeTextFile: async (args: Parameters<VaultFsPort['writeTextFile']>[0]) => {
        asked.push(args);
        return 7;
      },
    };

    await saveSkill({ fs, markdown, skill, draft: { ...DRAFT, description: 'Mine.' } });

    expect(asked).toEqual([
      expect.objectContaining({ path: SKILL_PATH, expectedModified: 1, expectedText: TEXT }),
    ]);
  });

  it('refuses a rename and a broken rule', async () => {
    const vault = memoryVault({ [SKILL_PATH]: TEXT });
    const skill = await readBack(vault);

    await expect(
      saveSkill({ fs: vault.fs, markdown, skill, draft: { ...DRAFT, name: 'friday-review' } }),
    ).rejects.toThrow(/cannot be renamed/);
    await expect(
      saveSkill({ fs: vault.fs, markdown, skill, draft: { ...DRAFT, instructions: '' } }),
    ).rejects.toThrow(/Write the skill’s instructions/);
    expect(vault.writes).toEqual([]);
  });

  it('refuses a skill whose frontmatter cannot be read', async () => {
    const vault = memoryVault({ [SKILL_PATH]: TEXT });
    const broken = { ...markdown, frontmatterProblem: () => 'Bad YAML.' };
    const skill = await readSkill({ fs: vault.fs, markdown: broken, name: 'weekly-review' });
    if (skill === null) throw new Error('no skill');

    await expect(
      saveSkill({ fs: vault.fs, markdown: broken, skill, draft: DRAFT }),
    ).rejects.toThrow('SKILL.md cannot be read: Bad YAML.');
  });

  it('puts a name: that differs from the folder right when the person saves the folder’s name', async () => {
    const vault = memoryVault({ [SKILL_PATH]: TEXT.replace('name: weekly-review', 'name: old') });
    const skill = await readBack(vault);
    expect(skill.problems.map(({ field }) => field)).toEqual(['name']);

    const saved = await saveSkill({
      fs: vault.fs,
      markdown,
      skill,
      draft: {
        name: 'weekly-review',
        description: skill.description,
        instructions: skill.instructions,
      },
    });

    expect(saved.problems).toEqual([]);
    expect(vault.notes.get(SKILL_PATH)?.text).toBe(TEXT);
  });
});

describe('deleteSkill', () => {
  it('puts the whole folder in the Trash and names the other files it held', async () => {
    const vault = memoryVault({
      [SKILL_PATH]: TEXT,
      '.atlas/skills/weekly-review/scripts/run.sh': 'echo',
      '.atlas/skills/weekly-review/reference.md': 'ref',
    });
    const skill = await readBack(vault);

    const deleted = await deleteSkill({ fs: vault.fs, skill });

    expect(vault.trashed).toEqual(['.atlas/skills/weekly-review']);
    expect([...deleted.otherFiles].sort()).toEqual([
      '.atlas/skills/weekly-review/reference.md',
      '.atlas/skills/weekly-review/scripts/run.sh',
    ]);
    expect(await listSkills({ fs: vault.fs, markdown })).toEqual([]);
  });

  it('refuses while SKILL.md is changed since it was read, trashing nothing', async () => {
    const vault = memoryVault({ [SKILL_PATH]: TEXT });
    const skill = await readBack(vault);
    vault.editOnDisk(SKILL_PATH, 'changed');

    await expect(deleteSkill({ fs: vault.fs, skill })).rejects.toThrow(NoteChangedError);
    expect(vault.trashed).toEqual([]);
  });

  it('refuses when SKILL.md has gone since it was read, or appeared in a folder that had none', async () => {
    const vault = memoryVault({ [SKILL_PATH]: TEXT }, [
      '.atlas/skills/empty',
      '.atlas/skills/weekly-review',
    ]);
    const skill = await readBack(vault);
    const empty = await readBack(vault, 'empty');
    vault.notes.delete(SKILL_PATH);
    vault.editOnDisk('.atlas/skills/empty/SKILL.md', TEXT);

    await expect(deleteSkill({ fs: vault.fs, skill })).rejects.toThrow(NoteChangedError);
    await expect(deleteSkill({ fs: vault.fs, skill: empty })).rejects.toThrow(NoteChangedError);
    expect(vault.trashed).toEqual([]);
  });

  it('trashes a folder that never had a SKILL.md', async () => {
    const vault = memoryVault({}, ['.atlas/skills/empty']);
    const empty = await readBack(vault, 'empty');

    await deleteSkill({ fs: vault.fs, skill: empty });

    expect(vault.trashed).toEqual(['.atlas/skills/empty']);
  });
});

describe('listSkills and readSkill', () => {
  it('lists each folder by name with its problems, and nothing for a vault with no skills folder', async () => {
    expect(await listSkills({ fs: memoryVault().fs, markdown })).toEqual([]);
    const vault = memoryVault(
      {
        [SKILL_PATH]: TEXT,
        '.atlas/skills/daily/SKILL.md': '---\nname: other\ndescription: d\n---\n\nx\n',
        '.atlas/skills/stray.md': 'not a skill',
      },
      ['.atlas/skills/.hidden'],
    );

    const skills = await listSkills({ fs: vault.fs, markdown });

    expect(skills.map(({ name, problems }) => [name, problems.length])).toEqual([
      ['daily', 1],
      ['weekly-review', 0],
    ]);
  });

  it('reads a skill by its folder name in any case, and nothing for a name with no folder', async () => {
    const vault = memoryVault({ [SKILL_PATH]: TEXT });

    expect((await readSkill({ fs: vault.fs, markdown, name: 'WEEKLY-REVIEW' }))?.path).toBe(
      SKILL_PATH,
    );
    for (const name of ['nope', '../weekly-review', 'weekly-review/SKILL.md', '.']) {
      expect(await readSkill({ fs: vault.fs, markdown, name })).toBeNull();
    }
  });

  it('passes on a failure to read that is not a missing file', async () => {
    const vault = memoryVault({ [SKILL_PATH]: TEXT });
    const fs = {
      ...vault.fs,
      readTextFile: async () => {
        throw new Error('disk on fire');
      },
    };

    await expect(listSkills({ fs, markdown })).rejects.toThrow('disk on fire');
  });

  it('passes on a failure to list that is not a missing folder', async () => {
    const fs = fakeVaultFs({
      listDirectory: async () => {
        throw new Error('permission denied');
      },
    });

    await expect(listSkills({ fs, markdown })).rejects.toThrow('permission denied');
  });
});

describe('a folder with no SKILL.md is not a dead end (review of #620)', () => {
  it('create, for that exact folder, writes its SKILL.md into it', async () => {
    const vault = memoryVault({}, ['.atlas/skills/weekly-review']);

    const skill = await createSkill({ fs: vault.fs, markdown, draft: DRAFT });

    expect(skill.problems).toEqual([]);
    expect(vault.notes.get(SKILL_PATH)?.text).toMatch(/^---\nname: weekly-review\n/);
  });

  it('create refuses, as already a skill, that folder once it has a SKILL.md, readable or not', async () => {
    const vault = memoryVault({ [SKILL_PATH]: TEXT });

    await expect(createSkill({ fs: vault.fs, markdown, draft: DRAFT })).rejects.toThrow(
      'There is already a skill called “weekly-review”.',
    );
    vault.unreadable.add(SKILL_PATH);
    await expect(createSkill({ fs: vault.fs, markdown, draft: DRAFT })).rejects.toThrow(
      SkillRefusedError,
    );
    expect(vault.notes.get(SKILL_PATH)?.text).toBe(TEXT);
  });

  it('create still refuses a folder of that name in another case', async () => {
    const vault = memoryVault({}, ['.atlas/skills/Weekly-Review']);

    await expect(createSkill({ fs: vault.fs, markdown, draft: DRAFT })).rejects.toThrow(
      'There is already a skill called “weekly-review”.',
    );
    expect(vault.writes).toEqual([]);
  });

  it('save writes the missing SKILL.md, canonically, refusing to overwrite one there now', async () => {
    const vault = memoryVault({}, ['.atlas/skills/weekly-review']);
    const empty = await readBack(vault);

    const saved = await saveSkill({ fs: vault.fs, markdown, skill: empty, draft: DRAFT });

    expect(saved.problems).toEqual([]);
    expect(vault.notes.get(SKILL_PATH)?.text).toBe(
      '---\nname: weekly-review\ndescription: Walks through the Friday review.\n---\n\n' +
        'List each project with no next action.\n',
    );
    await expect(saveSkill({ fs: vault.fs, markdown, skill: empty, draft: DRAFT })).rejects.toThrow(
      NoteChangedError,
    );
  });

  it('takes away the folder it just made when SKILL.md cannot be written, so a retry works', async () => {
    const vault = memoryVault({}, ['.atlas']);
    const failing = {
      ...vault.fs,
      createNote: async () => {
        throw new VaultAccessError('the disk is full');
      },
    };

    await expect(createSkill({ fs: failing, markdown, draft: DRAFT })).rejects.toThrow(
      'the disk is full',
    );

    expect(vault.trashed).toEqual(['.atlas/skills/weekly-review']);
    await createSkill({ fs: vault.fs, markdown, draft: DRAFT });
    expect(vault.notes.has(SKILL_PATH)).toBe(true);
  });

  it('refuses, as already a skill, a name something else took as the folder was made', async () => {
    const vault = memoryVault({ '.atlas/skills/weekly-review': 'a file, not a folder' });

    const made = createSkill({ fs: vault.fs, markdown, draft: DRAFT });

    await expect(made).rejects.toThrow(SkillRefusedError);
    await expect(made).rejects.toThrow('There is already a skill called “weekly-review”.');
  });

  it('passes on a createFolder failure that is not a clash', async () => {
    const vault = memoryVault({}, ['.atlas/skills']);
    const denied = {
      ...vault.fs,
      createFolder: async () => {
        throw new VaultAccessError('permission denied');
      },
    };

    await expect(createSkill({ fs: denied, markdown, draft: DRAFT })).rejects.toThrow(
      'permission denied',
    );
  });
});

describe('a SKILL.md that is there but cannot be read (review of #620)', () => {
  it('is a file problem, not a missing SKILL.md', async () => {
    const vault = memoryVault({ [SKILL_PATH]: TEXT });
    vault.unreadable.add(SKILL_PATH);

    const skill = await readBack(vault);

    expect(skill.problems).toEqual([{ field: 'file', message: SKILL_FILE_UNREADABLE }]);
  });

  it('is not trashed or saved over', async () => {
    const vault = memoryVault({ [SKILL_PATH]: TEXT });
    vault.unreadable.add(SKILL_PATH);
    const skill = await readBack(vault);

    await expect(deleteSkill({ fs: vault.fs, skill })).rejects.toThrow(SkillRefusedError);
    await expect(saveSkill({ fs: vault.fs, markdown, skill, draft: DRAFT })).rejects.toThrow(
      SkillRefusedError,
    );
    expect(vault.trashed).toEqual([]);
    expect(vault.writes).toEqual([]);
  });

  it('refuses a delete when SKILL.md stopped being readable after it was read', async () => {
    const vault = memoryVault({}, ['.atlas/skills/weekly-review']);
    const empty = await readBack(vault);
    vault.editOnDisk(SKILL_PATH, TEXT);
    vault.unreadable.add(SKILL_PATH);

    await expect(deleteSkill({ fs: vault.fs, skill: empty })).rejects.toThrow(NoteChangedError);
    expect(vault.trashed).toEqual([]);
  });
});

describe('deleting, after the review of #620', () => {
  it('checks SKILL.md after walking the folder, right before the Trash', async () => {
    const vault = memoryVault({
      [SKILL_PATH]: TEXT,
      '.atlas/skills/weekly-review/scripts/run.sh': 'echo',
    });
    const skill = await readBack(vault);
    vault.onList.set('.atlas/skills/weekly-review/scripts', () =>
      vault.editOnDisk(SKILL_PATH, 'a sync wrote this mid-walk'),
    );

    await expect(deleteSkill({ fs: vault.fs, skill })).rejects.toThrow(NoteChangedError);
    expect(vault.trashed).toEqual([]);
  });

  it('does not name dotfiles among the other files', async () => {
    const vault = memoryVault({
      [SKILL_PATH]: TEXT,
      '.atlas/skills/weekly-review/.DS_Store': 'x',
      '.atlas/skills/weekly-review/scripts/.DS_Store': 'x',
      '.atlas/skills/weekly-review/reference.md': 'ref',
    });
    const skill = await readBack(vault);

    const deleted = await deleteSkill({ fs: vault.fs, skill });

    expect(deleted.otherFiles).toEqual(['.atlas/skills/weekly-review/reference.md']);
    expect(vault.trashed).toEqual(['.atlas/skills/weekly-review']);
  });
});

describe('after the attack on #620', () => {
  it('never trashes the person’s own empty folder when writing SKILL.md into it fails', async () => {
    const vault = memoryVault({}, ['.atlas/skills/weekly-review']);
    const failing = {
      ...vault.fs,
      createNote: async () => {
        throw new VaultAccessError('the disk is full');
      },
    };

    await expect(createSkill({ fs: failing, markdown, draft: DRAFT })).rejects.toThrow(
      'the disk is full',
    );
    expect(vault.trashed).toEqual([]);
  });

  it.each([
    ['a folder it made', [] as string[]],
    ['the person’s own empty folder', ['.atlas/skills/weekly-review']],
  ])(
    'refuses as already a skill a SKILL.md that appeared in %s as it was written',
    async (_label, folders) => {
      const vault = memoryVault({}, ['.atlas/skills', ...folders]);
      const racing = {
        ...vault.fs,
        createNote: async () => {
          vault.editOnDisk(SKILL_PATH, 'theirs');
          throw new VaultAccessError('a note with that name already exists');
        },
      };

      const made = createSkill({ fs: racing, markdown, draft: DRAFT });

      await expect(made).rejects.toThrow(SkillRefusedError);
      await expect(made).rejects.toThrow('There is already a skill called “weekly-review”.');
      expect(vault.trashed).toEqual([]);
      expect(vault.notes.get(SKILL_PATH)?.text).toBe('theirs');
    },
  );

  it('writes changed instructions with CRLF when the file is, though its body is not', async () => {
    const text =
      '---\r\nname: weekly-review\r\ndescription: Walks.\r\nlicense: MIT\r\n---\r\nStep one.\n';
    const vault = memoryVault({ [SKILL_PATH]: text });
    const skill = await readBack(vault);

    await saveSkill({
      fs: vault.fs,
      markdown,
      skill,
      // The fake port reads `key: value` lines ending in LF only; the body is what is checked.
      draft: { name: skill.name, description: 'Walks.', instructions: 'A.\nB.' },
    });

    expect(vault.notes.get(SKILL_PATH)?.text.endsWith('\nA.\r\nB.\r\n')).toBe(true);
  });
});
