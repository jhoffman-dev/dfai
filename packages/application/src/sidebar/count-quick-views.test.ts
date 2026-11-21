import { describe, expect, it, vi } from 'vitest';
import {
  compileViewQuery,
  createVaultPath,
  parseObjectType,
  parseSavedView,
  sidebarEntry,
  type QuickView,
} from '@dfai/domain';
import { fakeIndexPort, fakeVaultFs } from '../testing/fake-ports.ts';
import { jsonMarkdown } from '../testing/json-markdown.ts';
import { atlasQueryIndex } from '../testing/query-index.ts';
import type { MarkdownPort } from '../notes/ports.ts';
import type { IndexPort, QueryResult } from '../index/ports.ts';
import { countQuickViews } from './count-quick-views.ts';

/** Frontmatter as one JSON object, which is enough to read a view. */
const markdown = {
  frontmatterProperties: (frontmatter: string | null) =>
    frontmatter === null
      ? {}
      : (JSON.parse(frontmatter.replace(/^---\n|\n---\n?$/g, '')) as object),
} as unknown as MarkdownPort;

const noteWith = (properties: Record<string, unknown>): string =>
  `---\n${JSON.stringify(properties)}\n---\n\n# A view\n`;

const quickView = (id: QuickView['id'], path: string): QuickView => ({
  id,
  entry: sidebarEntry(createVaultPath(path)),
});

const TODAY = quickView('today', '.atlas/views/Today.md');
const INBOX = quickView('inbox', '.atlas/views/Inbox.md');

const vaultOf = (files: Record<string, string>) =>
  fakeVaultFs({
    readNotes: async (paths) =>
      paths.flatMap((path) => {
        const text = files[path];
        return text === undefined ? [] : [{ path, text, modified: 1, size: text.length }];
      }),
  });

/** What the index answers a COUNT with: one row, one number. */
const rowsOf = (count: number): QueryResult => ({
  columns: ['value'],
  rows: [[count]],
  truncated: false,
});

const COUNT_SHAPE = { aggregate: { kind: 'count', column: null } } as const;

describe('countQuickViews', () => {
  it('counts what each view holds, by running the view in the file', async () => {
    const fs = vaultOf({
      [TODAY.entry.path]: noteWith({ atlas: 'view', type: 'task', limit: 10 }),
      [INBOX.entry.path]: noteWith({ atlas: 'view', type: 'task', limit: 20 }),
    });
    const query = vi.fn(async (_sql: string, parameters: readonly unknown[]) =>
      rowsOf(parameters.includes(10) ? 4 : 11),
    );

    const counts = await countQuickViews({
      fs,
      markdown,
      index: fakeIndexPort({ query }),
      quick: [TODAY, INBOX],
      types: [],
      notePaths: [],
    });

    expect([...counts]).toEqual([
      ['today', 4],
      ['inbox', 11],
    ]);
  });

  it('runs the view’s own filters, not just its type', async () => {
    const view = {
      atlas: 'view',
      type: 'task',
      filters: [{ key: 'status', operator: 'is', value: 'backlog' }],
    };
    const fs = vaultOf({ [INBOX.entry.path]: noteWith(view) });
    const query = vi.fn(async () => rowsOf(0));

    await countQuickViews({
      fs,
      markdown,
      index: fakeIndexPort({ query }),
      quick: [INBOX],
      types: [],
      notePaths: [],
    });

    const parsed = parseSavedView(view);
    if (parsed === null) throw new Error('the fixture is not a view');
    const expected = compileViewQuery(parsed, COUNT_SHAPE);
    expect(parsed.filters).toHaveLength(1);
    expect(query).toHaveBeenCalledWith(expected.sql, expected.parameters);
  });

  it('counts a view filtered by a list from the notes whose items match (#923)', async () => {
    const view = {
      atlas: 'view',
      type: 'meeting',
      filters: [{ key: 'people', operator: 'contains', value: 'Mara' }],
    };
    const meeting = parseObjectType({
      name: 'meeting',
      properties: { people: { kind: 'relation', target: 'person', many: true } },
    });
    const query = vi.fn<IndexPort['query']>(async () => rowsOf(3));

    const counts = await countQuickViews({
      fs: vaultOf({ [INBOX.entry.path]: noteWith(view) }),
      markdown,
      index: fakeIndexPort({ query }),
      quick: [INBOX],
      types: [meeting],
      notePaths: [],
    });

    expect(query.mock.calls[0]?.[0]).toContain('"path" IN (SELECT p.path FROM props AS p');
    expect(query.mock.calls[0]?.[1]).toEqual(['people', 'Mara', 500]);
    expect(counts.get('inbox')).toBe(3);
  });

  it('asks the index for a count rather than fetching the rows to count them', async () => {
    const fs = vaultOf({ [INBOX.entry.path]: noteWith({ atlas: 'view', type: 'task' }) });
    const query = vi.fn<IndexPort['query']>(async () => rowsOf(7));

    const counts = await countQuickViews({
      fs,
      markdown,
      index: fakeIndexPort({ query }),
      quick: [INBOX],
      types: [],
      notePaths: [],
    });

    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]?.[0]).toMatch(/^SELECT COUNT\(\*\) AS "value"/);
    expect(counts.get('inbox')).toBe(7);
  });

  it('counts no more than the view shows, capped at its limit', async () => {
    const fs = vaultOf({
      [TODAY.entry.path]: noteWith({ atlas: 'view', type: 'task', limit: 10 }),
    });
    const query = vi.fn(async () => rowsOf(42));

    const counts = await countQuickViews({
      fs,
      markdown,
      index: fakeIndexPort({ query }),
      quick: [TODAY],
      types: [],
      notePaths: [],
    });

    expect(counts.get('today')).toBe(10);
  });

  it('counts a DFAI query view by running it, up to its own limit', async () => {
    const types = [
      parseObjectType({
        name: 'task',
        properties: { status: { kind: 'select', options: ['backlog', 'done'] } },
      }),
    ];
    const notes = {
      'Tasks/A.md': noteWith({ type: 'task', status: 'backlog' }),
      'Tasks/B.md': noteWith({ type: 'task', status: 'backlog' }),
      'Tasks/C.md': noteWith({ type: 'task', status: 'done' }),
      'Inbox/D.md': noteWith({ type: 'task', status: 'done' }),
    };
    const query = atlasQueryIndex({ files: notes, markdown: jsonMarkdown() });
    const view = (text: string) =>
      vaultOf({ [INBOX.entry.path]: noteWith({ atlas: 'view', layout: 'list', query: text }) });
    const count = async (text: string) =>
      (
        await countQuickViews({
          fs: view(text),
          markdown,
          index: fakeIndexPort({ query }),
          quick: [INBOX],
          types,
          notePaths: Object.keys(notes),
        })
      ).get('inbox');

    expect(await count("FROM task WHERE status = backlog OR path STARTS WITH 'Inbox/'")).toBe(3);
    expect(await count('FROM task LIMIT 2')).toBe(2);
    expect(await count('FROM nothing')).toBeUndefined();
  });

  it('has nothing to count when there are no quick views', async () => {
    const readNotes = vi.fn();
    const counts = await countQuickViews({
      fs: fakeVaultFs({ readNotes }),
      markdown,
      index: fakeIndexPort(),
      quick: [],
      types: [],
      notePaths: [],
    });
    expect(counts.size).toBe(0);
    expect(readNotes).not.toHaveBeenCalled();
  });

  it('leaves the count off a view the index cannot run, and keeps the others', async () => {
    const fs = vaultOf({
      [TODAY.entry.path]: noteWith({ atlas: 'view', type: 'task', limit: 10 }),
      [INBOX.entry.path]: noteWith({ atlas: 'view', type: 'task', limit: 20 }),
    });
    const query = vi.fn(async (_sql: string, parameters: readonly unknown[]) => {
      if (parameters.includes(10)) throw new Error('no such column');
      return rowsOf(3);
    });

    const counts = await countQuickViews({
      fs,
      markdown,
      index: fakeIndexPort({ query }),
      quick: [TODAY, INBOX],
      types: [],
      notePaths: [],
    });

    expect([...counts]).toEqual([['inbox', 3]]);
  });

  it('leaves the count off a view that is gone, or is no longer a view', async () => {
    const fs = vaultOf({ [INBOX.entry.path]: noteWith({ type: 'task' }) });
    const query = vi.fn(async () => rowsOf(5));

    const counts = await countQuickViews({
      fs,
      markdown,
      index: fakeIndexPort({ query }),
      quick: [TODAY, INBOX],
      types: [],
      notePaths: [],
    });

    expect(counts.size).toBe(0);
    expect(query).not.toHaveBeenCalled();
  });

  it('has no counts when the files cannot be read at all', async () => {
    const fs = fakeVaultFs({
      readNotes: async () => {
        throw new Error('the vault moved');
      },
    });
    const counts = await countQuickViews({
      fs,
      markdown,
      index: fakeIndexPort(),
      quick: [TODAY],
      types: [],
      notePaths: [],
    });
    expect(counts.size).toBe(0);
  });
});
