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
import { BlockChangedError, undoScheduling } from '../timeblocks/schedule-task.ts';
import { NoteChangedError } from '../notes/note-changed-error.ts';
import { deleteEntry } from './delete-entry.ts';
import { HOST_CHANGED_ON_DISK, VaultAccessError, type VaultFsPort } from './ports.ts';

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
    writeTextFile: async ({ path, contents, expectedModified, expectedText }) => {
      if (expectedModified !== null && notes.get(path)?.modified !== expectedModified) {
        throw new Error(`${path} changed on disk`);
      }
      // As the host does (#245): the text held to as well, for a same-second edit.
      if (expectedText !== undefined && notes.get(path)?.text !== expectedText) {
        throw new VaultAccessError(HOST_CHANGED_ON_DISK);
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
  it('keeps a block made by a drop when it is edited between the check and the Trash', async () => {
    const block = createVaultPath('Quarterly report block.md');
    const vault = memoryVault({ [block]: 'as made\n' });
    const fs = editedBeforeTrash(vault.fs, () => vault.write(block, 'as made\nTyped meanwhile.\n'));

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
  });
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
      sourceText: '- [[Call Mara]]\n',
      taskModified: vault.notes.get(TASK)!.modified,
      taskText: 'status: inbox\n',
    };
    return { vault, promotion };
  }

  it('keeps the task when it is edited between the check and the Trash', async () => {
    const { vault, promotion } = promoted();
    const fs = editedBeforeTrash(vault.fs, () =>
      vault.write(TASK, 'status: inbox\nTyped meanwhile.\n'),
    );

    await undoPromotion({ fs, openNotes: NO_PANE, promotion }).catch(() => undefined);

    expect(vault.text(TASK)).toBe('status: inbox\nTyped meanwhile.\n');
  });

  it('takes back both halves or neither: a kept task leaves its line linked to it', async () => {
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
  });
});

describe('skills/manage-skills deleteSkill, a SKILL.md edited before its Trash (attack #694)', () => {
  const SKILL = '.atlas/skills/weekly-review/SKILL.md';
  const TEXT = '---\nname: weekly-review\ndescription: Look back on the week.\n---\nSteps.\n';

  it('keeps the skill when its SKILL.md is edited between the check and the Trash', async () => {
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
  });
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

  it('keeps a file the migration added when it is edited between the check and the Trash', async () => {
    const vault = migrated('type: area\n');
    let trashes = 0;
    const fs = editedBeforeTrash(vault.fs, () => {
      trashes += 1;
      vault.write(MADE, 'type: area\nTyped meanwhile.\n');
    });

    await undoTaskMigration({ fs, panes: NO_PANE }).catch(() => undefined);

    expect(trashes).toBe(1);
    expect(vault.text(MADE)).toBe('type: area\nTyped meanwhile.\n');
  });

  it('keeps a record a second run rewrote between the undo reading it and trashing it', async () => {
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
  });
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

/** Rewrites a note leaving its time as it was, as a disk that keeps the time to the second does. */
function editSameSecond(vault: ReturnType<typeof memoryVault>, path: string, text: string) {
  const note = vault.notes.get(path)!;
  vault.notes.set(path, { ...note, text });
}

describe('what each held caller says when it keeps an edit (#694)', () => {
  const SOURCE = createVaultPath('Plan.md');
  const TASK = createVaultPath('Call Mara.md');
  const LINKED = '- [[Call Mara]]\n';
  const MADE_TASK = 'status: inbox\n';

  function promoted() {
    const vault = memoryVault({ [SOURCE]: LINKED, [TASK]: MADE_TASK });
    const promotion = {
      source: SOURCE,
      task: TASK,
      previous: '- [ ] Call Mara\n',
      sourceModified: vault.notes.get(SOURCE)!.modified,
      sourceText: LINKED,
      taskModified: vault.notes.get(TASK)!.modified,
      taskText: MADE_TASK,
    };
    return { vault, promotion };
  }

  it('undoPromotion refuses a task edited between the check and the Trash, changing neither', async () => {
    const { vault, promotion } = promoted();
    const fs = editedBeforeTrash(vault.fs, () => vault.write(TASK, `${MADE_TASK}Typed.\n`));

    await expect(undoPromotion({ fs, openNotes: NO_PANE, promotion })).rejects.toThrow(
      'Call Mara changed since the line was promoted; nothing was undone.',
    );
    expect(vault.text(SOURCE)).toBe(LINKED);
  });

  it('undoPromotion refuses a task edited in the same second as the promotion', async () => {
    const { vault, promotion } = promoted();
    editSameSecond(vault, TASK, `${MADE_TASK}Typed.\n`);

    await expect(undoPromotion({ fs: vault.fs, openNotes: NO_PANE, promotion })).rejects.toThrow(
      /Call Mara changed since/,
    );
    expect(vault.text(TASK)).toBe(`${MADE_TASK}Typed.\n`);
    expect(vault.text(SOURCE)).toBe(LINKED);
  });

  it('undoPromotion takes back both halves when neither changed', async () => {
    const { vault, promotion } = promoted();
    const fs = editedBeforeTrash(vault.fs, () => undefined);

    await undoPromotion({ fs, openNotes: NO_PANE, promotion });

    expect(vault.notes.has(TASK)).toBe(false);
    expect(vault.text(SOURCE)).toBe('- [ ] Call Mara\n');
  });

  it('undoPromotion says the task went to the Trash when its line then could not be put back', async () => {
    const { vault, promotion } = promoted();
    const fs = {
      ...vault.fs,
      writeTextFile: async (args: Parameters<VaultFsPort['writeTextFile']>[0]) => {
        // Typing lands in the same second, between the check and the write back.
        editSameSecond(vault, SOURCE, `${LINKED}Typed.\n`);
        return vault.fs.writeTextFile(args);
      },
    };

    await expect(undoPromotion({ fs, openNotes: NO_PANE, promotion })).rejects.toThrow(
      'Call Mara went to the Trash, but its line was not put back: Plan changed since the line was promoted. Put the task back from the Trash to keep both as they were.',
    );
    expect(vault.text(SOURCE)).toBe(`${LINKED}Typed.\n`);
  });

  it('undoScheduling refuses a block edited between the check and the Trash', async () => {
    const block = createVaultPath('Quarterly report block.md');
    const vault = memoryVault({ [block]: 'as made\n' });
    const fs = editedBeforeTrash(vault.fs, () => vault.write(block, 'as made\nTyped.\n'));

    await expect(
      undoScheduling({
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
      }),
    ).rejects.toThrow(new BlockChangedError(block));
  });

  it('deleteSkill refuses a SKILL.md edited between the check and the Trash, and trashes an unchanged one', async () => {
    const SKILL = '.atlas/skills/weekly-review/SKILL.md';
    const TEXT = '---\nname: weekly-review\ndescription: Look back on the week.\n---\nSteps.\n';
    const read = async (vault: ReturnType<typeof memoryVault>) =>
      (await readSkill({ fs: vault.fs, markdown: fakeMarkdown(), name: 'weekly-review' }))!;
    const edited = memoryVault({ [SKILL]: TEXT });
    const skill = await read(edited);
    const editing = editedBeforeTrash(edited.fs, () => edited.write(SKILL, `${TEXT}Typed.\n`));
    await expect(deleteSkill({ fs: editing, skill })).rejects.toThrow(new NoteChangedError(SKILL));

    const kept = memoryVault({ [SKILL]: TEXT });
    const holding = editedBeforeTrash(kept.fs, () => undefined);
    await deleteSkill({ fs: holding, skill: await read(kept) });
    expect(kept.notes.has(SKILL)).toBe(false);
  });

  it('undoTaskMigration names the added file and the record it kept, with why', async () => {
    const MADE = createVaultPath('Areas/Home.md');
    const later = migrationRecordText({ at: '2026-10-09T08:00:00', files: [], finished: true });
    const vault = memoryVault({
      [MIGRATION_RECORD_PATH]: migrationRecordText({
        at: '2026-10-08T09:30:00',
        files: [{ kind: 'created', path: MADE, contents: 'type: area\n' }],
        finished: true,
      }),
      [MADE]: 'type: area\n',
    });
    const fs: VaultFsPort = {
      ...vault.fs,
      trashEntry: async (args) => {
        const now = args.path === MADE ? 'type: area\nTyped.\n' : later;
        await editedBeforeTrash(vault.fs, () => vault.write(args.path, now)).trashEntry(args);
      },
    };

    const undone = await undoTaskMigration({ fs, panes: NO_PANE });

    expect(undone?.restored).toEqual([]);
    expect(undone?.left).toEqual([
      {
        path: MADE,
        reason: 'It has changed since the migration wrote it, so it was left as it is.',
      },
      {
        path: MIGRATION_RECORD_PATH,
        reason:
          'The migration’s record changed while it was being undone, so it was kept: run Undo again to see what is left.',
      },
    ]);
    expect(vault.text(MADE)).toBe('type: area\nTyped.\n');
    expect(vault.text(MIGRATION_RECORD_PATH)).toBe(later);
  });

  it('undoTaskMigration does not write over a record rewritten in the same second', async () => {
    const MADE = createVaultPath('Areas/Home.md');
    const later = migrationRecordText({ at: '2026-10-09T08:00:00', files: [], finished: true });
    const vault = memoryVault({
      [MIGRATION_RECORD_PATH]: migrationRecordText({
        at: '2026-10-08T09:30:00',
        files: [{ kind: 'created', path: MADE, contents: 'type: area\n' }],
        finished: true,
      }),
      [MADE]: 'type: area\n',
    });
    // Unsaved typing keeps the file for a retry, so the record is rewritten rather than trashed.
    const typing = { state: () => 'dirty' as const, reload: () => undefined };
    const fs = {
      ...vault.fs,
      writeTextFile: async (args: Parameters<VaultFsPort['writeTextFile']>[0]) => {
        editSameSecond(vault, MIGRATION_RECORD_PATH, later);
        return vault.fs.writeTextFile(args);
      },
    };

    await expect(undoTaskMigration({ fs, panes: typing })).rejects.toThrow(HOST_CHANGED_ON_DISK);
    expect(vault.text(MIGRATION_RECORD_PATH)).toBe(later);
  });

  it('undoTaskMigration trashes the added file and the record when neither changed', async () => {
    const MADE = createVaultPath('Areas/Home.md');
    const vault = memoryVault({
      [MIGRATION_RECORD_PATH]: migrationRecordText({
        at: '2026-10-08T09:30:00',
        files: [{ kind: 'created', path: MADE, contents: 'type: area\n' }],
        finished: true,
      }),
      [MADE]: 'type: area\n',
    });
    const fs = editedBeforeTrash(vault.fs, () => undefined);

    const undone = await undoTaskMigration({ fs, panes: NO_PANE });

    expect(undone).toEqual({ restored: [MADE], left: [] });
    expect(vault.notes.has(MADE)).toBe(false);
    expect(vault.notes.has(MIGRATION_RECORD_PATH)).toBe(false);
  });
});
