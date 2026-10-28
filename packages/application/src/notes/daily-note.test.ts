import { describe, expect, it } from 'vitest';
import { createVaultPath, dailyNoteContents, type VaultEntry, type VaultPath } from '@dfai/domain';
import { fakeMarkdown, fakeVaultFs } from '../testing/fake-ports.ts';
import { dailyNotePath, ensureDailyNote } from './daily-note.ts';

const TODAY = '2026-09-22';
const DAILY = { name: 'Daily', path: createVaultPath('.atlas/templates/Daily.md') };

const markdown = fakeMarkdown();

function vault(template: (path: string) => string = (path) => `from ${path}`) {
  const created: { path: string; contents: string }[] = [];
  const fs = fakeVaultFs({
    readTextFile: async (path) => ({ text: template(path), modified: 1 }),
    createNote: async ({ path, contents }) => {
      created.push({ path, contents });
      return 0;
    },
  });
  return { fs, created };
}

describe("today's note", () => {
  it('is named by the date, in the folder it lives in', () => {
    expect(dailyNotePath(TODAY, createVaultPath('Daily/2026'))).toBe('Daily/2026/2026-09-22.md');
  });

  // #214: today's note is filed in the Daily type's home, dated by the year.
  it('is found in its home folder rather than made again', async () => {
    const { fs, created } = vault();
    const found = await ensureDailyNote({
      fs,
      markdown,
      today: TODAY,
      notePaths: [createVaultPath('Daily/2026/2026-09-22.md')],
      templates: [DAILY],
    });

    expect(found).toEqual({ path: 'Daily/2026/2026-09-22.md', created: false });
    expect(created).toEqual([]);
  });

  it('is found at the root, where it was made before it had a home, rather than made again', async () => {
    const { fs, created } = vault();
    const found = await ensureDailyNote({
      fs,
      markdown,
      today: TODAY,
      notePaths: [createVaultPath('2026-09-22.md')],
      templates: [DAILY],
    });

    expect(found).toEqual({ path: '2026-09-22.md', created: false });
    expect(created).toEqual([]);
  });

  it('is made in the Daily home folder from the Daily template', async () => {
    const { fs, created } = vault();
    const made = await ensureDailyNote({
      fs,
      markdown,
      today: TODAY,
      // A note of the same name in a folder is some other note.
      notePaths: [createVaultPath('Journal/2026-09-22.md')],
      templates: [DAILY],
    });

    expect(made).toEqual({ path: 'Daily/2026/2026-09-22.md', created: true });
    expect(created).toEqual([
      { path: 'Daily/2026/2026-09-22.md', contents: 'from .atlas/templates/Daily.md' },
    ]);
  });

  it('starts as a note of the built-in Daily type when the vault has no Daily template', async () => {
    const { fs, created } = vault();
    await ensureDailyNote({
      fs,
      markdown,
      today: TODAY,
      notePaths: [] as VaultPath[],
      templates: [],
    });

    expect(created).toEqual([
      { path: 'Daily/2026/2026-09-22.md', contents: dailyNoteContents({ day: TODAY, types: [] }) },
    ]);
    expect(created[0]?.contents).toMatch(/^---\ntype: daily\n---\n/);
  });

  // #110: the day's blocks are about the day the clock says, not one fixed in code.
  it("starts with the clock's day in its query blocks", async () => {
    const { fs, created } = vault();
    await ensureDailyNote({ fs, markdown, today: '2026-11-03', notePaths: [], templates: [] });

    const contents = created[0]?.contents ?? '';
    expect(contents).toContain('```atlas-query\n');
    expect(contents).toContain('due <= 2026-11-03');
    expect(contents).not.toContain(TODAY);
  });

  it('is held to the task rules: a Daily template that is a task waiting on nobody is made as it is (#202)', async () => {
    const contents = '---\ntype: task\nstatus: waiting\n---\n';
    const { fs, created } = vault(() => contents);

    await ensureDailyNote({ fs, markdown, today: TODAY, notePaths: [], templates: [DAILY] });
    expect(created).toEqual([{ path: 'Daily/2026/2026-09-22.md', contents }]);
  });

  it('is found, not numbered, when it appears between the listing and the create', async () => {
    const attempts: string[] = [];
    const fs = fakeVaultFs({
      listNotes: async () => [
        { name: '2026-09-22.md', path: createVaultPath('2026-09-22.md'), modified: 1, size: 1 },
      ],
      createNote: async ({ path }) => {
        attempts.push(path);
        throw new Error('a note with that name already exists');
      },
    });

    const found = await ensureDailyNote({
      fs,
      markdown,
      today: TODAY,
      notePaths: [],
      templates: [],
    });

    expect(found).toEqual({ path: '2026-09-22.md', created: false });
    expect(attempts).toEqual(['Daily/2026/2026-09-22.md']);
  });

  it('is found under the spelling the disk has when the create is refused for the name', async () => {
    // Made as `2026-09-22.MD` after the listing; APFS refuses `2026-09-22.md` beside it.
    const fs = fakeVaultFs({
      listNotes: async () => [
        { name: '2026-09-22.MD', path: createVaultPath('2026-09-22.MD'), modified: 1, size: 1 },
      ],
      createNote: async () => {
        throw new Error('a note with that name already exists');
      },
    });

    const found = await ensureDailyNote({
      fs,
      markdown,
      today: TODAY,
      notePaths: [],
      templates: [],
    });

    expect(found).toEqual({ path: '2026-09-22.MD', created: false });
  });

  it("propagates the host's refusal when today's note is still not there", async () => {
    const fs = fakeVaultFs({
      createNote: async () => {
        throw new Error('permission denied');
      },
    });

    await expect(
      ensureDailyNote({ fs, markdown, today: TODAY, notePaths: [], templates: [] }),
    ).rejects.toThrow('permission denied');
  });
});

/**
 * #110: the day's blocks go only into a vault whose Task type can run them,
 * judged from `.atlas/types` as it is when the note is made.
 */
describe("today's note in a vault with a Task type of its own", () => {
  const GTD_STATUSES = [
    'inbox',
    'backlog',
    'next-action',
    'in-progress',
    'waiting',
    'someday',
    'longterm',
    'archive',
  ];
  const PLAIN = '---\ntype: daily\n---\n\n## What happened\n\n## What is next\n';

  /** Frontmatter written as one JSON object is a type's; any other is read as lines. */
  const lines = fakeMarkdown();
  const typesMarkdown = {
    ...lines,
    frontmatterProperties: (frontmatter: string | null) => {
      const inner = (frontmatter ?? '').replace(/^---\n|\n---\n?$/g, '');
      return inner.startsWith('{')
        ? (JSON.parse(inner) as Record<string, unknown>)
        : lines.frontmatterProperties(frontmatter);
    },
  };

  function vaultWithTask(task: Record<string, unknown>) {
    const created: { path: string; contents: string }[] = [];
    const text = `---\n${JSON.stringify(task)}\n---\n`;
    const path = createVaultPath('.atlas/types/task.md');
    const fs = fakeVaultFs({
      listDirectory: async (folder) =>
        folder === '.atlas/types' ? [{ kind: 'file', name: 'task.md', path } as VaultEntry] : [],
      readNotes: async (paths) =>
        paths.includes(path) ? [{ path, text, modified: 1, size: text.length }] : [],
      createNote: async ({ path: made, contents }) => {
        created.push({ path: made, contents });
        return 0;
      },
    });
    return { fs, created };
  }

  const make = (fs: ReturnType<typeof vaultWithTask>['fs']) =>
    ensureDailyNote({ fs, markdown: typesMarkdown, today: TODAY, notePaths: [], templates: [] });

  it('starts with the day when the Task type is on GTD, with due and defer as dates', async () => {
    const { fs, created } = vaultWithTask({
      name: 'task',
      properties: {
        status: { kind: 'select', options: GTD_STATUSES, done: 'archive' },
        due: 'date',
        defer: 'date',
      },
    });
    await make(fs);

    expect(created).toHaveLength(1);
    expect(created[0]?.contents).toContain('## Due and overdue\n\n```atlas-query\n');
    expect(created[0]?.contents).toContain(`due <= ${TODAY}`);
  });

  it('starts with the two headings alone when the Task type keeps statuses of its own', async () => {
    const { fs, created } = vaultWithTask({
      name: 'task',
      properties: {
        status: { kind: 'select', options: ['todo', 'doing', 'done'], done: 'done' },
        due: 'date',
        defer: 'date',
      },
    });
    await make(fs);

    expect(created).toEqual([{ path: 'Daily/2026/2026-09-22.md', contents: PLAIN }]);
  });

  it('starts with the two headings alone when the Task type has no defer', async () => {
    const { fs, created } = vaultWithTask({
      name: 'task',
      properties: {
        status: { kind: 'select', options: GTD_STATUSES, done: 'archive' },
        due: 'date',
      },
    });
    await make(fs);

    expect(created[0]?.contents).toBe(PLAIN);
  });
});
