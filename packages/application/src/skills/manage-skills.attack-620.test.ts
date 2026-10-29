/**
 * Adversarial tests for making, saving and deleting skills (PR #620, #169):
 * another program — a sync, another Mac — changes the skill's folder at each
 * await of a use-case. Nothing it wrote may be overwritten or trashed unless
 * ADR-0050 says so; where it does, the ADR's words are what is checked.
 */

import { describe, expect, it } from 'vitest';
import { createVaultPath, parentVaultPath, vaultPathName, type VaultEntry } from '@dfai/domain';
import { fakeMarkdown, fakeVaultFs } from '../testing/fake-ports.ts';
import { VaultAccessError, type VaultFsPort } from '../vault/ports.ts';
import { createSkill, deleteSkill, saveSkill } from './manage-skills.ts';
import { listSkills, readSkill } from './skills.ts';

type Command = keyof VaultFsPort;

/**
 * A vault in memory that refuses as the host does (a create never overwrites
 * nor makes its parent, a write is refused when the file changed since
 * `expectedModified`), and runs `before[n]` ahead of the n-th host call.
 */
function racingVault(files: Record<string, string> = {}, folders: readonly string[] = []) {
  let clock = 100;
  const notes = new Map(Object.entries(files).map(([path, text]) => [path, { text, modified: 1 }]));
  const dirs = new Set(folders);
  const trashed: { path: string; held: string[] }[] = [];
  const calls: Command[] = [];
  const before = new Map<number, () => void>();
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
  const step = (command: Command) => {
    calls.push(command);
    before.get(calls.length)?.();
  };
  const fs: VaultFsPort = fakeVaultFs({
    listDirectory: async (folder) => {
      step('listDirectory');
      if (folder !== '' && !allDirs().has(folder)) throw new VaultAccessError('no such folder');
      const under = (path: string) => parentVaultPath(createVaultPath(path)) === folder;
      return [
        ...[...allDirs()].filter(under).map((path) => entry('directory', path)),
        ...[...notes.keys()].filter(under).map((path) => entry('file', path)),
      ];
    },
    readTextFile: async (path) => {
      step('readTextFile');
      const note = notes.get(path);
      if (note === undefined) throw new VaultAccessError('no such file');
      return { ...note };
    },
    createFolder: async ({ path }) => {
      step('createFolder');
      if (allDirs().has(path) || notes.has(path)) throw new VaultAccessError('taken');
      dirs.add(path);
    },
    createNote: async ({ path, contents }) => {
      step('createNote');
      if (!allDirs().has(parentVaultPath(path))) throw new VaultAccessError('no such folder');
      if (notes.has(path)) throw new VaultAccessError('a note with that name already exists');
      clock += 1;
      notes.set(path, { text: contents, modified: clock });
      return clock;
    },
    writeTextFile: async ({ path, contents, expectedModified }) => {
      step('writeTextFile');
      if (expectedModified !== null && notes.get(path)?.modified !== expectedModified) {
        throw new VaultAccessError('changed on disk');
      }
      clock += 1;
      notes.set(path, { text: contents, modified: clock });
      return clock;
    },
    trashEntry: async ({ path }) => {
      step('trashEntry');
      const held = [...notes.keys()].filter((key) => key.startsWith(`${path}/`));
      trashed.push({ path, held });
      for (const key of held) notes.delete(key);
      for (const dir of [...dirs]) if (dir === path || dir.startsWith(`${path}/`)) dirs.delete(dir);
    },
  });
  /** Another program writes a file, making its folders as it goes. */
  const syncWrites = (path: string, text: string) => {
    clock += 1;
    notes.set(path, { text, modified: clock });
  };
  return { fs, notes, dirs, trashed, calls, before, syncWrites };
}

const markdown = fakeMarkdown();
const FOLDER = '.atlas/skills/weekly-review';
const SKILL_PATH = `${FOLDER}/SKILL.md`;
const DRAFT = {
  name: 'weekly-review',
  description: 'Walks through the Friday review.',
  instructions: 'List each project with no next action.',
};
const TEXT = '---\nname: weekly-review\ndescription: Walks through it.\n---\n\nStep one.\n';
const SYNCED = '---\nname: weekly-review\ndescription: From the other Mac.\n---\n\nTheirs.\n';

/** The number of the host call `command` is, the first time a run makes it. */
async function callNumbers(run: (vault: ReturnType<typeof racingVault>) => Promise<unknown>) {
  const vault = racingVault({ [SKILL_PATH]: TEXT });
  await run(vault).catch(() => undefined);
  return vault.calls;
}

describe('a create whose SKILL.md cannot be written', () => {
  it('never trashes a SKILL.md a sync put into the folder it had just made', async () => {
    const vault = racingVault({}, ['.atlas/skills']);
    const createNoteCall = (await callNumbersFor(vault)).indexOf('createNote') + 1;
    const racing = racingVault({}, ['.atlas/skills']);
    racing.before.set(createNoteCall, () => racing.syncWrites(SKILL_PATH, SYNCED));

    await createSkill({ fs: racing.fs, markdown, draft: DRAFT }).catch(() => undefined);

    expect(racing.trashed).toEqual([]);
    expect(racing.notes.get(SKILL_PATH)?.text).toBe(SYNCED);
  });

  it('trashes only an empty folder, as ADR-0050 says, never one a sync has put files in', async () => {
    const racing = racingVault({}, ['.atlas/skills']);
    const failing: VaultFsPort = {
      ...racing.fs,
      // The sync lands its file as the write is tried; the write then fails.
      createNote: async () => {
        racing.syncWrites(`${FOLDER}/references/guide.md`, 'Their guide.\n');
        throw new VaultAccessError('the disk is full');
      },
    };

    await createSkill({ fs: failing, markdown, draft: DRAFT }).catch(() => undefined);

    const heldByTrashed = racing.trashed.flatMap(({ held }) => held);
    expect(heldByTrashed).not.toContain(`${FOLDER}/references/guide.md`);
    expect(racing.notes.get(`${FOLDER}/references/guide.md`)?.text).toBe('Their guide.\n');
  });
});

/** The host calls a clean create makes, in order. */
async function callNumbersFor(vault: ReturnType<typeof racingVault>) {
  await createSkill({ fs: vault.fs, markdown, draft: DRAFT });
  return vault.calls;
}

describe('a save while a sync edits SKILL.md', () => {
  it('never writes over the sync’s edit, whichever host call it lands before', async () => {
    const read = async (vault: ReturnType<typeof racingVault>) => {
      const skill = await readSkill({ fs: vault.fs, markdown, name: 'weekly-review' });
      if (skill === null) throw new Error('no skill');
      vault.calls.length = 0;
      return skill;
    };
    const draft = { ...DRAFT, instructions: 'Mine.' };
    const calls = await callNumbers(async (vault) =>
      saveSkill({ fs: vault.fs, markdown, skill: await read(vault), draft }),
    );
    expect(calls).toContain('writeTextFile');

    for (let at = 1; at <= calls.length; at += 1) {
      const vault = racingVault({ [SKILL_PATH]: TEXT });
      const skill = await read(vault);
      vault.before.set(at, () => vault.syncWrites(SKILL_PATH, SYNCED));

      await saveSkill({ fs: vault.fs, markdown, skill, draft }).catch(() => undefined);

      expect({ at, text: vault.notes.get(SKILL_PATH)?.text }).toEqual({ at, text: SYNCED });
    }
  });
});

describe('a delete while a sync edits SKILL.md', () => {
  it('never trashes the sync’s edit made before the last re-read (the window ADR-0050 names)', async () => {
    const read = async (vault: ReturnType<typeof racingVault>) => {
      const skill = await readSkill({ fs: vault.fs, markdown, name: 'weekly-review' });
      if (skill === null) throw new Error('no skill');
      vault.calls.length = 0;
      return skill;
    };
    const calls = await callNumbers(async (vault) =>
      deleteSkill({ fs: vault.fs, skill: await read(vault) }),
    );
    const trashCall = calls.indexOf('trashEntry') + 1;
    expect(trashCall).toBeGreaterThan(1);

    // An edit landing just before the Trash, after the re-read, is the window
    // ADR-0050 documents; every earlier one must stop the delete.
    for (let at = 1; at < trashCall; at += 1) {
      const vault = racingVault({ [SKILL_PATH]: TEXT, [`${FOLDER}/scripts/run.md`]: 'x' });
      const skill = await read(vault);
      vault.before.set(at, () => vault.syncWrites(SKILL_PATH, SYNCED));

      await deleteSkill({ fs: vault.fs, skill }).catch(() => undefined);

      expect({ at, trashed: vault.trashed }).toEqual({ at, trashed: [] });
    }
  });
});

describe('a skills folder the host will not list', () => {
  it('is a failure, not a vault with no skills, when .atlas lists it as there', async () => {
    const vault = racingVault({ [SKILL_PATH]: TEXT });
    const denied: VaultFsPort = {
      ...vault.fs,
      listDirectory: async (folder) => {
        if (folder === '.atlas/skills') {
          throw new VaultAccessError('cannot read: Permission denied (os error 13)');
        }
        return vault.fs.listDirectory(folder);
      },
    };
    const atlas = await denied.listDirectory(createVaultPath('.atlas'));
    expect(atlas.map(({ name, kind }) => `${kind}:${name}`)).toContain('directory:skills');

    await expect(listSkills({ fs: denied, markdown })).rejects.toThrow(VaultAccessError);
  });
});
