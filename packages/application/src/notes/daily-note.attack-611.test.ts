import { describe, expect, it } from 'vitest';
import { createVaultPath, type VaultEntry } from '@dfai/domain';
import { fakeMarkdown, fakeVaultFs } from '../testing/fake-ports.ts';
import { ensureDailyNote } from './daily-note.ts';

/**
 * Attack on PR #611 (#110): the day written into the note's blocks is the
 * day in its file name, on every edge of the calendar.
 */
const GTD_TASK = {
  name: 'task',
  properties: {
    status: {
      kind: 'select',
      options: [
        'inbox',
        'backlog',
        'next-action',
        'in-progress',
        'waiting',
        'someday',
        'longterm',
        'archive',
      ],
      done: 'archive',
    },
    due: 'date',
    defer: 'date',
  },
};

/** Frontmatter written as one JSON object is a type's; any other is read as lines. */
const lines = fakeMarkdown();
const markdown = {
  ...lines,
  frontmatterProperties: (frontmatter: string | null) => {
    const inner = (frontmatter ?? '').replace(/^---\n|\n---\n?$/g, '');
    return inner.startsWith('{')
      ? (JSON.parse(inner) as Record<string, unknown>)
      : lines.frontmatterProperties(frontmatter);
  },
};

function vaultWithTask() {
  const created: { path: string; contents: string }[] = [];
  const text = `---\n${JSON.stringify(GTD_TASK)}\n---\n`;
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

const DAYS_IN_QUERY = /\d{4}-\d{2}-\d{2}/g;

describe('#611 attack: the day in the blocks is the day in the name', () => {
  it.each(['2026-12-31', '2027-01-01', '2028-02-29', '2026-03-08', '2026-11-01'])(
    'names %s in the file and in every date its blocks compare',
    async (today) => {
      const { fs, created } = vaultWithTask();
      const { path } = await ensureDailyNote({ fs, markdown, today, notePaths: [], templates: [] });
      const contents = created[0]?.contents ?? '';
      expect(path.endsWith(`${today}.md`)).toBe(true);
      const days = contents.match(DAYS_IN_QUERY) ?? [];
      expect(days.length).toBeGreaterThan(0);
      expect(new Set(days)).toEqual(new Set([today]));
    },
  );
});
