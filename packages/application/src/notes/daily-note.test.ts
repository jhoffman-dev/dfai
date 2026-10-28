import { describe, expect, it } from 'vitest';
import { createVaultPath, dailyNoteContents, type VaultPath } from '@dfai/domain';
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
      { path: 'Daily/2026/2026-09-22.md', contents: dailyNoteContents(TODAY) },
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
