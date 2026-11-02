import { describe, expect, it } from 'vitest';
import {
  HIGHLIGHTS_PAGE_SIZE,
  HIGHLIGHTS_QUERY_MARK,
  LIBRARY_PAGE_SIZE,
  LIBRARY_QUERY_MARK,
} from '@dfai/domain';
import type { IndexedHighlightRow, IndexedNote, IndexPort, QueryResult } from '../index/ports.ts';
import { sqliteIndexPort } from '../testing/sqlite-index.ts';
import { createVaultPath, type NoteChange } from '@dfai/domain';
import {
  loadAllHighlights,
  loadLibrary,
  MAX_REFRESHED_PATHS,
  readHighlights,
  readLibrary,
  refreshHighlights,
  refreshLibrary,
} from './load-research.ts';

function note(path: string, rest: Partial<IndexedNote> = {}): IndexedNote {
  return {
    path,
    title: path.replace(/^.*\//, '').replace(/\.md$/, ''),
    modified: 0,
    size: 0,
    digest: '',
    type: 'literature',
    body: '',
    summary: '',
    properties: [
      { key: 'type', index: 0, text: 'literature', number: null, date: null, json: null },
    ],
    links: [],
    tags: [],
    relations: [],
    blocks: [],
    checks: [],
    progress: null,
    highlights: [],
    ...rest,
  };
}

const property = (key: string, text: string) => ({
  key,
  index: 0,
  text,
  number: null,
  date: null,
  json: null,
});

const mark = (id: string, rest: Partial<IndexedHighlightRow> = {}): IndexedHighlightRow => ({
  id,
  kind: 'pdf',
  quote: `Quote ${id}`,
  comment: '',
  mark: 'highlight',
  color: 'yellow',
  anchor: '{"v":1,"kind":"pdf","page":1}',
  ...rest,
});

const literature = (extra: ReturnType<typeof property>[] = []) => [
  property('type', 'literature'),
  ...extra,
];

describe('loadLibrary', () => {
  it('reads each literature note: title, author, kind, cover, highlights, tags and projects', async () => {
    const index = sqliteIndexPort();
    await index.put([
      note('Projects/Reading.md', { title: 'Reading list', type: 'project', properties: [] }),
      note('Library/Art.md', {
        title: 'The Art of War',
        modified: 50,
        properties: literature([
          property('kind', 'PDF'),
          property('author', ' Sun Tzu '),
          property('cover', '![[covers/art.jpg]]'),
        ]),
        tags: [
          { key: 'war', name: 'War' },
          { key: 'strategy', name: 'strategy' },
        ],
        relations: [
          {
            key: 'project',
            index: 0,
            target: 'Reading',
            name: 'reading',
            path: 'Projects/Reading.md',
          },
          { key: 'project', index: 1, target: 'Someday', name: 'someday', path: null },
        ],
        highlights: [mark('a1'), mark('a2')],
      }),
      note('Library/Odd.md', {
        properties: literature([
          property('kind', 'scroll'),
          property('cover', 'https://example.com/x.png'),
        ]),
      }),
    ]);

    expect(await loadLibrary({ index })).toEqual([
      {
        path: 'Library/Art.md',
        title: 'The Art of War',
        author: 'Sun Tzu',
        kind: 'pdf',
        highlights: 2,
        modified: 50,
        tags: ['strategy', 'war'],
        projects: [
          { path: 'Projects/Reading.md', name: 'Reading list' },
          { path: null, name: 'Someday' },
        ],
        cover: 'covers/art.jpg',
      },
      {
        path: 'Library/Odd.md',
        title: 'Odd',
        author: null,
        kind: null,
        highlights: 0,
        modified: 0,
        tags: [],
        projects: [],
        cover: null,
      },
    ]);
  });

  it('reads nothing from a vault with no literature note', async () => {
    const index = sqliteIndexPort();
    await index.put([note('Notes/Plain.md', { type: null, properties: [] })]);
    expect(await loadLibrary({ index })).toEqual([]);
  });

  it('reads on to the next page while a page comes back full or cut short', async () => {
    const asked: number[] = [];
    const index = pagedIndex(LIBRARY_QUERY_MARK, LIBRARY_PAGE_SIZE, asked, [
      { rows: LIBRARY_PAGE_SIZE, truncated: false },
      { rows: 3, truncated: true },
      { rows: 1, truncated: false },
    ]);
    expect(await loadLibrary({ index })).toHaveLength(LIBRARY_PAGE_SIZE + 4);
    expect(asked).toEqual([0, LIBRARY_PAGE_SIZE, 2 * LIBRARY_PAGE_SIZE]);
  });

  it('lets a failed read fail the load', async () => {
    const index = { query: () => Promise.reject(new Error('index busy')) };
    await expect(loadLibrary({ index })).rejects.toThrow('index busy');
  });
});

describe('loadAllHighlights', () => {
  it('reads every highlight with its source, style, place and tags, newest note first', async () => {
    const index = sqliteIndexPort();
    await index.put([
      note('Library/Old.md', {
        title: 'Old book',
        modified: 1,
        tags: [{ key: 'stoic', name: 'Stoic' }],
        highlights: [
          mark('k1', {
            kind: 'kindle',
            comment: 'Compare.',
            color: 'blue',
            mark: 'underline',
            anchor: '{"v":1,"kind":"kindle","location":77}',
          }),
        ],
      }),
      note('Library/New.md', {
        title: 'New book',
        modified: 9,
        highlights: [mark('n1', { anchor: '{"v":1,"kind":"pdf","page":3}' }), mark('n2')],
      }),
    ]);

    const read = await loadAllHighlights({ index });
    expect(read.map((each) => each.id)).toEqual(['n1', 'n2', 'k1']);
    expect(read[0]).toEqual({
      path: 'Library/New.md',
      source: 'New book',
      modified: 9,
      index: 0,
      id: 'n1',
      kind: 'pdf',
      quote: 'Quote n1',
      comment: '',
      mark: 'highlight',
      color: 'yellow',
      page: 3,
      location: null,
      tags: [],
    });
    expect(read[2]).toMatchObject({
      kind: 'kindle',
      comment: 'Compare.',
      color: 'blue',
      mark: 'underline',
      page: null,
      location: 77,
      tags: ['stoic'],
    });
  });

  it('reads the sources, then the highlights page after page by key until one comes back short', async () => {
    const total = 2 * HIGHLIGHTS_PAGE_SIZE;
    const sources = Array.from(
      { length: LIBRARY_PAGE_SIZE + 1 },
      (_, at) => `Library/${String(at).padStart(6, '0')}.md`,
    );
    const rowOf = (path: string) => [
      path,
      0,
      'id',
      'pdf',
      'Quote',
      '',
      'highlight',
      'yellow',
      null,
      null,
    ];
    // Two full pages of highlights, one of which is in no source: it is left out.
    const highlights = [...sources.slice(0, total - 1).map(rowOf), rowOf('Archive/Gone.md')];
    const statements: string[] = [];
    const after: unknown[][] = [];
    const index: Pick<IndexPort, 'query'> = {
      query: async (sql, parameters) => {
        statements.push(sql.slice(0, sql.indexOf('*/') + 2));
        if (sql.startsWith(LIBRARY_QUERY_MARK)) {
          const [limit, offset] = parameters.slice(-2).map(Number) as [number, number];
          const rows = sources
            .slice(offset, offset + limit)
            .map((path) => [path, path, 0, null, 'pdf', null, 1, '', '']);
          return { columns: [], rows, truncated: false };
        }
        after.push(parameters.slice(0, 2));
        const from = (after.length - 1) * HIGHLIGHTS_PAGE_SIZE;
        const rows = highlights.slice(from, from + HIGHLIGHTS_PAGE_SIZE);
        return { columns: [], rows, truncated: false };
      },
    };
    expect(await loadAllHighlights({ index })).toHaveLength(total - 1);
    expect(statements).toEqual([
      LIBRARY_QUERY_MARK,
      LIBRARY_QUERY_MARK,
      HIGHLIGHTS_QUERY_MARK,
      HIGHLIGHTS_QUERY_MARK,
      HIGHLIGHTS_QUERY_MARK,
    ]);
    const lastOfFirst = highlights[HIGHLIGHTS_PAGE_SIZE - 1]?.[0];
    const lastOfSecond = highlights[total - 1]?.[0];
    expect(after).toEqual([
      ['', -1],
      [lastOfFirst, 0],
      [lastOfSecond, 0],
    ]);
  });
});

describe('reading 150,000 highlights', () => {
  // Real time, with a margin of ten or more over what it takes: it fails when the read goes back to
  // building an object per row or sorting every highlight, which was a frame of a quarter second.
  it('joins them to their sources as the pages arrive, in a fraction of a second', async () => {
    const SOURCES = 1_500;
    const PER_SOURCE = 100;
    const paths = Array.from(
      { length: SOURCES },
      (_, at) => `Library/${String(at).padStart(4, '0')}.md`,
    );
    const highlights = paths.flatMap((path) =>
      Array.from({ length: PER_SOURCE }, (_, at) => [
        path,
        at,
        `h${at}`,
        'pdf',
        `Quote ${at}`,
        '',
        'highlight',
        'yellow',
        3,
        null,
      ]),
    );
    let served = 0;
    const index: Pick<IndexPort, 'query'> = {
      query: async (sql) => {
        if (sql.startsWith(LIBRARY_QUERY_MARK)) {
          return {
            columns: [],
            rows: paths.map((path, at) => [
              path,
              path,
              at,
              null,
              'pdf',
              null,
              PER_SOURCE,
              'a\u001fb/c',
              '',
            ]),
            truncated: false,
          };
        }
        const rows = highlights.slice(served, served + HIGHLIGHTS_PAGE_SIZE);
        served += rows.length;
        return { columns: [], rows, truncated: false };
      },
    };

    const started = performance.now();
    const read = await readHighlights({ index });
    const took = performance.now() - started;

    expect(read.entries).toHaveLength(SOURCES * PER_SOURCE);
    expect(read.entries[0]?.path).toBe(paths[SOURCES - 1]);
    expect(read.choices.tags.map((tag) => tag.value)).toEqual(['a', 'b', 'b/c']);
    expect(took).toBeLessThan(1_500);
  });
});

describe('readHighlights, counting what it reads', () => {
  it("asks for no page after the one that reaches the Library's count of highlights", async () => {
    const SIZE = HIGHLIGHTS_PAGE_SIZE;
    const paths = Array.from(
      { length: SIZE },
      (_, at) => `Library/${String(at).padStart(5, '0')}.md`,
    );
    let highlightPages = 0;
    const index: Pick<IndexPort, 'query'> = {
      query: async (sql) => {
        if (sql.startsWith(LIBRARY_QUERY_MARK)) {
          return {
            columns: [],
            rows: paths.map((path) => [path, path, 0, null, 'pdf', null, 1, '', '']),
            truncated: false,
          };
        }
        highlightPages += 1;
        const rows = paths.map((path) => [
          path,
          0,
          'id',
          'pdf',
          'Quote',
          '',
          'highlight',
          'yellow',
          null,
          null,
        ]);
        return { columns: [], rows, truncated: false };
      },
    };
    expect((await readHighlights({ index })).entries).toHaveLength(SIZE);
    expect(highlightPages).toBe(1);
  });
});

describe('readHighlights', () => {
  it('lists the sources by when they changed, and offers the choices of what it read', async () => {
    const index = sqliteIndexPort();
    await index.put([
      note('Library/Old.md', {
        modified: 1,
        tags: [{ key: 'a/b', name: 'a/b' }],
        highlights: [mark('o1')],
      }),
      note('Library/New.md', {
        modified: 9,
        highlights: [mark('n1', { color: 'green' }), mark('n2')],
      }),
      note('Library/Empty.md', { modified: 20 }),
    ]);
    const read = await readHighlights({ index });
    expect(read.entries.map((each) => [each.id, each.index])).toEqual([
      ['n1', 0],
      ['n2', 1],
      ['o1', 0],
    ]);
    expect(read.groups.map((group) => group.source.title)).toEqual(['New', 'Old']);
    expect(read.choices.colors.map((each) => [each.value, each.count])).toEqual([
      ['yellow', 2],
      ['green', 1],
    ]);
    expect(read.choices.tags.map((each) => each.value)).toEqual(['a', 'a/b']);
  });
});

describe('refreshLibrary and refreshHighlights', () => {
  const change = (path: string, rest: Partial<NoteChange> = {}): NoteChange => ({
    kind: 'changed',
    path,
    type: 'literature',
    digest: 'x',
    ...rest,
  });

  /** An index of three sources, with every statement it is asked noted. */
  async function watchedIndex() {
    const sqlite = sqliteIndexPort();
    await sqlite.put([
      note('Library/A.md', { modified: 1, highlights: [mark('a1')] }),
      note('Library/B.md', { modified: 2, highlights: [mark('b1')] }),
      note('Library/C.md', { modified: 3, highlights: [mark('c1')] }),
    ]);
    const asked: { sql: string; parameters: readonly (string | number | null)[] }[] = [];
    const index: Pick<IndexPort, 'query'> = {
      query: (sql, parameters) => {
        asked.push({ sql, parameters });
        return sqlite.query(sql, parameters);
      },
    };
    return { sqlite, index, asked };
  }

  it('reads again only the note that changed, and splices it in as a whole read would', async () => {
    const { sqlite, index, asked } = await watchedIndex();
    const previous = await readHighlights({ index });
    await sqlite.put([note('Library/B.md', { modified: 9, highlights: [mark('b1'), mark('b2')] })]);
    asked.length = 0;

    const next = await refreshHighlights({ index, previous, changes: [change('Library/B.md')] });

    expect(next?.entries.map((each) => each.id)).toEqual(['b1', 'b2', 'c1', 'a1']);
    expect(next?.entries).toEqual((await readHighlights({ index })).entries);
    const refreshing = asked.slice(0, 2);
    expect(refreshing.length).toBe(2);
    expect(refreshing.every((each) => each.parameters.includes('Library/B.md'))).toBe(true);
    expect(refreshing.some((each) => each.parameters.includes('Library/A.md'))).toBe(false);
  });

  it('drops a note that left literature, and a note that was removed', async () => {
    const { sqlite, index } = await watchedIndex();
    const previous = await readHighlights({ index });
    await sqlite.put([note('Library/A.md', { type: 'note', properties: [], highlights: [] })]);
    await sqlite.remove([createVaultPath('Library/C.md')]);
    const next = await refreshHighlights({
      index,
      previous,
      changes: [
        change('Library/A.md', { type: 'note', beforeType: 'literature' }),
        change('Library/C.md', { kind: 'removed' }),
      ],
    });
    expect(next?.entries.map((each) => each.id)).toEqual(['b1']);
  });

  it('refreshes the Library the same way', async () => {
    const { sqlite, index, asked } = await watchedIndex();
    const previous = await readLibrary({ index });
    await sqlite.put([note('Library/D.md', { modified: 4, highlights: [mark('d1')] })]);
    asked.length = 0;
    const next = await refreshLibrary({
      index,
      previous,
      changes: [change('Library/D.md', { kind: 'added' })],
    });
    expect(next?.entries.map((each) => each.path)).toEqual([
      'Library/A.md',
      'Library/B.md',
      'Library/C.md',
      'Library/D.md',
    ]);
    expect(asked).toHaveLength(1);
    expect(asked[0]?.parameters).toContain('Library/D.md');
  });

  it('reads nothing for no change, and leaves the whole to be read again for a project or for many notes', async () => {
    const { index, asked } = await watchedIndex();
    const previous = await readLibrary({ index });
    asked.length = 0;
    expect(await refreshLibrary({ index, previous, changes: [] })).toBe(previous);
    expect(
      await refreshLibrary({
        index,
        previous,
        changes: [change('Projects/Reading.md', { type: 'project' })],
      }),
    ).toBeNull();
    const many = Array.from({ length: MAX_REFRESHED_PATHS + 1 }, (_, at) =>
      change(`Library/${at}.md`),
    );
    expect(await refreshLibrary({ index, previous, changes: many })).toBeNull();
    expect(asked).toEqual([]);
  });
});
/** An index that answers `mark`'s statement with the pages given, noting each offset asked for. */
function pagedIndex(
  mark: string,
  size: number,
  asked: number[],
  pages: readonly { rows: number; truncated: boolean }[],
): Pick<IndexPort, 'query'> {
  return {
    query: async (sql, parameters): Promise<QueryResult> => {
      expect(sql.startsWith(mark)).toBe(true);
      const offset = Number(parameters.at(-1));
      asked.push(offset);
      const page = pages[offset / size] ?? { rows: 0, truncated: false };
      return {
        columns: ['path', 'id'],
        rows: Array.from({ length: page.rows }, (_, at) => [
          `Library/${offset + at}.md`,
          `id${at}`,
        ]),
        truncated: page.truncated,
      };
    },
  };
}

describe('loadLibrary, over notes the index cannot date (ADR-0053)', () => {
  it('reads an undated source as unknown, not as the epoch', async () => {
    const index: Pick<IndexPort, 'query'> = {
      query: async () => ({
        columns: [],
        rows: [
          ['Library/Undated.md', 'Undated', null, null, 'pdf', null, 1, '', ''],
          ['Library/Dated.md', 'Dated', 1_700_000_000_000, null, 'pdf', null, 1, '', ''],
        ],
        truncated: false,
      }),
    };
    const entries = await loadLibrary({ index });
    expect(entries.map((entry) => [entry.path, entry.modified])).toEqual([
      ['Library/Undated.md', null],
      ['Library/Dated.md', 1_700_000_000_000],
    ]);
  });
});
