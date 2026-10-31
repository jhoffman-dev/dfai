/**
 * Attack on PR #694 (#693): the trash callers the fix left unheld. Each test
 * edits a file at the moment between the caller's check and its trash — as
 * `editedBeforeTrash` does, the Trash keeping the host's "unless changed" hold
 * — and asks whether the edit went to the Trash. A caller that checks what it
 * is about to trash and then trashes without `unchanged` loses that edit; the
 * hold only helps a caller that names what it read. All names are made up.
 */
import { describe, expect, it } from 'vitest';
import {
  createVaultPath,
  MIGRATION_RECORD_PATH,
  migrationRecordText,
  type VaultEntry,
} from '@dfai/domain';
import { undoPromotion } from '../checklists/promote-checklist-line.ts';
import { undoTaskMigration } from '../gtd/run-task-migration.ts';
import { deleteSkill } from '../skills/manage-skills.ts';
import { readSkill } from '../skills/skills.ts';
import { editedBeforeTrash } from '../testing/edited-before-trash.ts';
import { fakeIndexPort, fakeMarkdown, fakeVaultFs } from '../testing/fake-ports.ts';
import { undoScheduling } from '../timeblocks/schedule-task.ts';
import { deleteEntry } from './delete-entry.ts';
import type { VaultFsPort } from './ports.ts';

/** Notes in memory, each with the time it was last written; a trash takes a folder's contents too. */
function memoryVault(files: Record<string, string>) {
  let clock = 100;
  const notes = new Map(
    Object.entries(files).map(([path, text]) => [path, { text, modified: (clock += 1) }]),
  );
  const read = (path: string) => {
    const note = notes.get(path);
    if (note === undefined) throw new Error(`no such note: ${path}`);
    return { text: note.text, modified: note.modified };
  };
  const write = (path: string, text: string) => {
    const modified = (clock += 1);
    notes.set(path, { text, modified });
    return modified;
  };
  const children = (folder: string): VaultEntry[] => {
    const prefix = folder === '' ? '' : `${folder}/`;
    const names = new Map<string, 'file' | 'directory'>();
    for (const path of notes.keys()) {
      if (!path.startsWith(prefix)) continue;
      const [name, ...rest] = path.slice(prefix.length).split('/');
      names.set(name!, rest.length === 0 ? 'file' : 'directory');
    }
    return [...names].map(([name, kind]) => {
      const path = createVaultPath(`${prefix}${name}`);
      return kind === 'file'
        ? { kind, name, path, extension: name.split('.').at(-1) ?? '' }
        : { kind, name, path };
    }) as VaultEntry[];
  };
  const fs: VaultFsPort = fakeVaultFs({
    listDirectory: async (folder) => children(folder),
    readTextFile: async (path) => read(path),
    readNotes: async (paths) =>
      paths
        .filter((path) => notes.has(path))
        .map((path) => ({ path, ...read(path), size: read(path).text.length })),
    createNote: async ({ path, contents }) => write(path, contents),
    writeTextFile: async ({ path, contents, expectedModified }) => {
      if (expectedModified !== null && notes.get(path)?.modified !== expectedModified) {
        throw new Error(`${path} changed on disk`);
      }
      return write(path, contents);
    },
    trashEntry: async ({ path }) => {
      for (const each of [...notes.keys()]) {
        if (each === path || each.startsWith(`${path}/`)) notes.delete(each);
      }
    },
  });
  return { fs, notes, text: (path: string) => notes.get(path)?.text, write };
}

const NO_PANE = { state: () => 'closed' as const, reload: () => undefined };

describe('timeblocks/schedule-task undoScheduling, a block edited before its Trash (attack #694)', () => {
  it.fails(
    'keeps a block made by a drop when it is edited between the check and the Trash',
    async () => {
      const block = createVaultPath('Quarterly report block.md');
      const vault = memoryVault({ [block]: 'as made\n' });
      const fs = editedBeforeTrash(vault.fs, () =>
        vault.write(block, 'as made\nTyped meanwhile.\n'),
      );

      await undoScheduling({
        scheduling: {
          kind: 'created',
          block,
          task: createVaultPath('Quarterly report.md'),
          contents: 'as made\n',
        },
        fs,
        index: fakeIndexPort(),
        editors: NO_PANE,
        writeProperties: async () => undefined as never,
        notePaths: [block],
      }).catch(() => undefined);

      expect(vault.text(block)).toBe('as made\nTyped meanwhile.\n');
    },
  );
});

describe('checklists/promote-checklist-line undoPromotion, a task edited before its Trash (attack #694)', () => {
  const SOURCE = createVaultPath('Plan.md');
  const TASK = createVaultPath('Call Mara.md');

  function promoted() {
    const vault = memoryVault({ [SOURCE]: '- [[Call Mara]]\n', [TASK]: 'status: inbox\n' });
    const promotion = {
      source: SOURCE,
      task: TASK,
      previous: '- [ ] Call Mara\n',
      sourceModified: vault.notes.get(SOURCE)!.modified,
      taskModified: vault.notes.get(TASK)!.modified,
    };
    return { vault, promotion };
  }

  it.fails('keeps the task when it is edited between the check and the Trash', async () => {
    const { vault, promotion } = promoted();
    const fs = editedBeforeTrash(vault.fs, () =>
      vault.write(TASK, 'status: inbox\nTyped meanwhile.\n'),
    );

    await undoPromotion({ fs, openNotes: NO_PANE, promotion }).catch(() => undefined);

    expect(vault.text(TASK)).toBe('status: inbox\nTyped meanwhile.\n');
  });

  it.fails(
    'takes back both halves or neither: a kept task leaves its line linked to it',
    async () => {
      // Even once the trash is held, the line is put back before the trash is tried:
      // a refused trash leaves the line unlinked from a task that is still there.
      const { vault, promotion } = promoted();
      const fs = editedBeforeTrash(vault.fs, () =>
        vault.write(TASK, 'status: inbox\nTyped meanwhile.\n'),
      );
      const held: VaultFsPort = {
        ...fs,
        trashEntry: (args) =>
          fs.trashEntry({
            ...args,
            unchanged: [{ path: TASK, text: 'status: inbox\n', modified: promotion.taskModified }],
          }),
      };

      await undoPromotion({ fs: held, openNotes: NO_PANE, promotion }).catch(() => undefined);

      expect(vault.text(TASK)).toBe('status: inbox\nTyped meanwhile.\n');
      expect(vault.text(SOURCE)).toBe('- [[Call Mara]]\n');
    },
  );
});

describe('skills/manage-skills deleteSkill, a SKILL.md edited before its Trash (attack #694)', () => {
  const SKILL = '.atlas/skills/weekly-review/SKILL.md';
  const TEXT = '---\nname: weekly-review\ndescription: Look back on the week.\n---\nSteps.\n';

  it.fails(
    'keeps the skill when its SKILL.md is edited between the check and the Trash',
    async () => {
      const vault = memoryVault({ [SKILL]: TEXT });
      const skill = await readSkill({
        fs: vault.fs,
        markdown: fakeMarkdown(),
        name: 'weekly-review',
      });
      expect(skill).not.toBeNull();
      const fs = editedBeforeTrash(vault.fs, () => vault.write(SKILL, `${TEXT}Typed meanwhile.\n`));

      await deleteSkill({ fs, skill: skill! }).catch(() => undefined);

      expect(vault.text(SKILL)).toBe(`${TEXT}Typed meanwhile.\n`);
    },
  );
});

describe('gtd/run-task-migration undoTaskMigration, an edit before its Trash (attack #694)', () => {
  const MADE = createVaultPath('Areas/Home.md');

  function migrated(made: string) {
    const record = migrationRecordText({
      at: '2026-10-08T09:30:00',
      files: [{ kind: 'created', path: MADE, contents: made }],
      finished: true,
    });
    return memoryVault({ [MIGRATION_RECORD_PATH]: record, [MADE]: made });
  }

  it.fails(
    'keeps a file the migration added when it is edited between the check and the Trash',
    async () => {
      const vault = migrated('type: area\n');
      let trashes = 0;
      const fs = editedBeforeTrash(vault.fs, () => {
        trashes += 1;
        vault.write(MADE, 'type: area\nTyped meanwhile.\n');
      });

      await undoTaskMigration({ fs, panes: NO_PANE }).catch(() => undefined);

      expect(trashes).toBe(1);
      expect(vault.text(MADE)).toBe('type: area\nTyped meanwhile.\n');
    },
  );

  it.fails(
    'keeps a record a second run rewrote between the undo reading it and trashing it',
    async () => {
      const vault = migrated('type: area\n');
      const later = migrationRecordText({ at: '2026-10-09T08:00:00', files: [], finished: true });
      // The undo's first trash is the added file; the record is the second.
      let trashes = 0;
      const fs: VaultFsPort = {
        ...vault.fs,
        trashEntry: async (args) => {
          trashes += 1;
          if (args.path === MIGRATION_RECORD_PATH) vault.write(MIGRATION_RECORD_PATH, later);
          await editedBeforeTrash(vault.fs, () => undefined).trashEntry(args);
        },
      };

      await undoTaskMigration({ fs, panes: NO_PANE }).catch(() => undefined);

      expect(trashes).toBe(2);
      expect(vault.text(MIGRATION_RECORD_PATH)).toBe(later);
    },
  );
});

describe('vault/delete-entry deleteEntry, by design not held (probe #694)', () => {
  it('trashes the note as it is at the Trash: the person asked to delete it, edits and all', async () => {
    const note = createVaultPath('Draft.md');
    const vault = memoryVault({ [note]: 'First words.\n' });
    const fs = editedBeforeTrash(vault.fs, () => vault.write(note, 'First words.\nMore.\n'));
    const entry = { kind: 'file', name: 'Draft.md', path: note, extension: 'md' } as const;

    await deleteEntry({
      fs,
      index: fakeIndexPort(),
      editors: { state: () => 'closed', abandon: () => undefined } as never,
      entry,
      notePaths: [note],
    });

    expect(vault.notes.has(note)).toBe(false);
  });
});
