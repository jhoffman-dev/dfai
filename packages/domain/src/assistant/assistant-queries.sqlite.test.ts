import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { createVaultPath, type VaultPath } from '../vault/vault-path.ts';
import {
  ASSISTANT_PATHS_PER_QUERY,
  ASSISTANT_QUERY_MARK,
  blocksHeld,
  compileBlocksQuery,
  compileFollowUpsQuery,
  compileSourcesQuery,
  followUpRowsOf,
  sourcesOf,
} from './assistant-queries.ts';

/**
 * The assistant's statements run for real against SQLite, over the index's
 * own `files`, `props`, `tags`, `relations` and `links` tables: what is
 * asserted is the rows, not the text.
 */
interface Note {
  readonly path: string;
  /** When its file last changed, in milliseconds. */
  readonly modified?: number;
  /** Ids of its blocks. */
  readonly blocks?: readonly string[];
  readonly props?: Record<string, string>;
  readonly tags?: readonly string[];
  /** Notes its frontmatter links to. */
  readonly relations?: readonly string[];
  /** Notes its body links to. */
  readonly links?: readonly string[];
}

function assistantIndex(notes: readonly Note[]) {
  const database = new DatabaseSync(':memory:');
  database.exec(`
    CREATE TABLE files (path TEXT PRIMARY KEY, title TEXT NOT NULL, modified INTEGER NOT NULL);
    CREATE TABLE blocks (path TEXT NOT NULL, idx INTEGER NOT NULL, id TEXT NOT NULL, text TEXT NOT NULL);
    CREATE TABLE props (path TEXT NOT NULL, key TEXT NOT NULL, idx INTEGER NOT NULL DEFAULT 0,
      value_text TEXT, value_num REAL, value_date TEXT, value_json TEXT);
    CREATE TABLE tags (path TEXT NOT NULL, idx INTEGER NOT NULL, tag TEXT NOT NULL, name TEXT NOT NULL);
    CREATE TABLE relations (src TEXT NOT NULL, key TEXT NOT NULL, idx INTEGER NOT NULL,
      target TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', dst TEXT);
    CREATE TABLE links (src TEXT NOT NULL, dst TEXT, target TEXT NOT NULL, kind TEXT NOT NULL);
  `);
  for (const note of notes) {
    database
      .prepare('INSERT INTO files VALUES (?, ?, ?)')
      .run(note.path, note.path.replace(/^.*\//, '').replace(/\.md$/, ''), note.modified ?? 1);
    for (const [at, id] of (note.blocks ?? []).entries()) {
      database.prepare('INSERT INTO blocks VALUES (?, ?, ?, ?)').run(note.path, at, id, 'text');
    }
    for (const [key, value] of Object.entries(note.props ?? {})) {
      const day = /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
      database
        .prepare(
          'INSERT INTO props (path, key, idx, value_text, value_date) VALUES (?, ?, 0, ?, ?)',
        )
        .run(note.path, key, value, day);
    }
    for (const [at, tag] of (note.tags ?? []).entries()) {
      database.prepare('INSERT INTO tags VALUES (?, ?, ?, ?)').run(note.path, at, tag, tag);
    }
    for (const dst of note.relations ?? []) {
      database
        .prepare("INSERT INTO relations VALUES (?, 'x', 0, ?, '', ?)")
        .run(note.path, dst, dst);
    }
    for (const dst of note.links ?? []) {
      database.prepare("INSERT INTO links VALUES (?, ?, ?, 'wikilink')").run(note.path, dst, dst);
    }
  }
  return (compiled: { sql: string; parameters: readonly (string | number)[] } | null) => {
    if (compiled === null) return null;
    expect(compiled.sql.startsWith(ASSISTANT_QUERY_MARK)).toBe(true);
    return database
      .prepare(compiled.sql)
      .all(...compiled.parameters)
      .map((row) => Object.values(row));
  };
}

const MEETING = 'Meetings/Kickoff.md';
const MARA = 'People/Mara Quill.md';
const TOBIAS = 'People/Tobias Fenn.md';
const task = (status: string, more: Record<string, string> = {}) => ({
  type: 'task',
  status,
  ...more,
});

const NOTES: readonly Note[] = [
  { path: MEETING, props: { type: 'meeting' }, relations: ['Tasks/Chase the quote.md'] },
  { path: MARA, props: { type: 'person' } },
  { path: TOBIAS, props: { type: 'person' } },
  // Joined by the meeting's own `tasks`.
  {
    path: 'Tasks/Chase the quote.md',
    props: task('inbox', { due: '2026-10-01', source: '[[Kickoff#^t0002]]' }),
    tags: ['follow-up'],
    modified: Date.UTC(2026, 9, 2, 12),
  },
  // A shared meeting's follow-up that is another person's: it names Tobias, not Mara.
  {
    path: 'Tasks/Tobias to send it.md',
    props: task('waiting', { waiting_on: 'Tobias at the bank' }),
    tags: ['follow-up'],
    relations: [MEETING, TOBIAS],
  },
  // Naming both: it names Mara, so hers.
  {
    path: 'Tasks/Mara and Tobias.md',
    props: task('inbox'),
    tags: ['follow-up'],
    relations: [MEETING, MARA, TOBIAS],
  },
  // Citing the meeting in its `source`.
  {
    path: 'Tasks/Check the rates.md',
    props: task('inbox'),
    tags: ['follow-up'],
    relations: [MEETING],
  },
  // Naming the person in its body.
  { path: 'Tasks/Ask Mara.md', props: task('next-action'), tags: ['follow-up'], links: [MARA] },
  // Linked from the meeting's body.
  { path: 'Tasks/From the notes.md', props: task('inbox'), tags: ['follow-up'] },
  {
    path: 'Tasks/Done already.md',
    props: task('archive'),
    tags: ['follow-up'],
    relations: [MEETING],
  },
  { path: 'Tasks/Not a follow-up.md', props: task('inbox'), relations: [MEETING] },
  { path: 'Tasks/Elsewhere.md', props: task('inbox'), tags: ['follow-up'] },
  {
    path: 'Notes/Follow-up idea.md',
    props: { type: 'note' },
    tags: ['follow-up'],
    relations: [MEETING],
  },
  {
    path: 'Archive/Tasks/Old chase.md',
    props: task('inbox'),
    tags: ['follow-up'],
    relations: [MEETING],
  },
  {
    path: '.atlas/Hidden chase.md',
    props: task('inbox'),
    tags: ['follow-up'],
    relations: [MEETING],
  },
];

const withBodyLink: readonly Note[] = NOTES.map((note) =>
  note.path === MEETING ? { ...note, links: ['Tasks/From the notes.md'] } : note,
);

describe('compileFollowUpsQuery', () => {
  const run = assistantIndex(withBodyLink);
  const compile = ({
    entity = MARA,
    meetings = [MEETING],
    done = 'archive',
    personType = 'person',
  }: {
    entity?: string;
    meetings?: readonly string[];
    done?: string | null;
    personType?: string | null;
  } = {}) =>
    compileFollowUpsQuery({
      entity,
      meetings,
      taskType: 'task',
      personType,
      statusKey: 'status',
      done,
    });
  const rows = (options: Parameters<typeof compile>[0] = {}) =>
    followUpRowsOf(run(compile(options)) ?? []);
  const followUps = (options: Parameters<typeof compile>[0] = {}) =>
    rows(options).map((row) => row.path);

  it('finds the open follow-ups linked either way with the page or its meetings, by any link', () => {
    expect(followUps()).toEqual([
      'Tasks/Ask Mara.md',
      'Tasks/Chase the quote.md',
      'Tasks/Check the rates.md',
      'Tasks/From the notes.md',
      'Tasks/Mara and Tobias.md',
    ]);
  });

  it('leaves out one reached through a shared meeting that names a different person', () => {
    expect(followUps({ entity: MARA })).not.toContain('Tasks/Tobias to send it.md');
    // The same follow-up is Tobias’s own, found by naming him.
    expect(followUps({ entity: TOBIAS })).toContain('Tasks/Tobias to send it.md');
  });

  it('keeps one that names the page itself, though it names another person too', () => {
    expect(rows().find((row) => row.path === 'Tasks/Mara and Tobias.md')).toMatchObject({
      direct: true,
      meeting: null,
    });
  });

  it('says which meeting reached a follow-up that names no one of the page', () => {
    expect(rows().find((row) => row.path === 'Tasks/Check the rates.md')).toMatchObject({
      direct: false,
      meeting: MEETING,
      meetingTitle: 'Kickoff',
    });
  });

  // Follow-up to #110: a type in any case, as FROM finds it.
  it('reads a task and a person whose types are written in capitals or with spaces', () => {
    const spelt = assistantIndex(
      withBodyLink.map((note) => {
        if (note.path === TOBIAS) return { ...note, props: { type: 'Person' } };
        if (note.path === 'Tasks/Chase the quote.md') {
          return { ...note, props: { ...note.props, type: ' TASK ' } };
        }
        return note;
      }),
    );
    const found = followUpRowsOf(spelt(compile()) ?? []).map((row) => row.path);
    expect(found).toContain('Tasks/Chase the quote.md');
    // Tobias is still a person, so his follow-up through the shared meeting stays out.
    expect(found).not.toContain('Tasks/Tobias to send it.md');
  });

  it('keeps every shared-meeting follow-up when the vault has no Person type to tell by', () => {
    expect(followUps({ personType: null })).toContain('Tasks/Tobias to send it.md');
  });

  it('answers each follow-up’s title, status, due, source, who it waits on and the day it changed', () => {
    expect(rows().find((row) => row.path === 'Tasks/Chase the quote.md')).toEqual({
      path: 'Tasks/Chase the quote.md',
      title: 'Chase the quote',
      status: 'inbox',
      due: '2026-10-01',
      source: '[[Kickoff#^t0002]]',
      waitingOn: null,
      modified: '2026-10-02',
      direct: false,
      meeting: MEETING,
      meetingTitle: 'Kickoff',
    });
    expect(rows({ entity: TOBIAS }).find((row) => row.path.endsWith('send it.md'))).toMatchObject({
      status: 'waiting',
      waitingOn: 'Tobias at the bank',
    });
  });

  it('keeps a finished one when the Task type has no finished status', () => {
    expect(followUps({ done: null })).toContain('Tasks/Done already.md');
  });

  it('finds nothing around a note nothing follows up', () => {
    expect(followUps({ entity: 'People/Nobody.md', meetings: [] })).toEqual([]);
  });

  it('finds what names the page itself with no meetings', () => {
    expect(followUps({ meetings: [] })).toEqual(['Tasks/Ask Mara.md', 'Tasks/Mara and Tobias.md']);
  });

  it('binds the status key, so a key with a quote in it is a value and never statement text', () => {
    const key = "status') OR 1=1 --";
    const compiled = compileFollowUpsQuery({
      entity: MARA,
      meetings: [MEETING],
      taskType: 'task',
      personType: 'person',
      statusKey: key,
      done: 'archive',
    });
    expect(compiled.sql).not.toContain(key);
    expect(compiled.parameters).toContain(key);
    expect(followUpRowsOf(run(compiled) ?? []).length).toBeGreaterThan(0);
  });

  it('names each meeting once, and no more than its cap', () => {
    const many = Array.from({ length: ASSISTANT_PATHS_PER_QUERY + 50 }, (_, at) => `N/${at}.md`);
    const compiled = compile({ meetings: [...many, ...many] });
    // The page and its meetings, then the four keys read, the Person type and page, the Task type, the tag, the finished status and the limit.
    expect(compiled.parameters).toHaveLength(ASSISTANT_PATHS_PER_QUERY + 1 + 4 + 2 + 2 + 1 + 1);
    expect(run(compiled)).not.toBeNull();
  });
});

describe('compileBlocksQuery', () => {
  const run = assistantIndex([
    { path: 'Meetings/Kickoff.md', blocks: ['t0001', 't0002'] },
    { path: 'Meetings/Sync.md', blocks: ['t0001'] },
  ]);
  const block = (path: string, id: string) => ({ path: createVaultPath(path), id });
  const held = (blocks: { path: VaultPath; id: string }[]) =>
    blocksHeld(run(compileBlocksQuery(blocks)) ?? []);

  it('answers which of the blocks asked about the index holds, by note and id', () => {
    const holds = held([
      block('Meetings/Kickoff.md', 't0002'),
      block('Meetings/Sync.md', 't0002'),
      block('Meetings/Gone.md', 't0001'),
    ]);
    expect(holds(block('Meetings/Kickoff.md', 't0002'))).toBe(true);
    expect(holds(block('Meetings/Sync.md', 't0002'))).toBe(false);
    expect(holds(block('Meetings/Gone.md', 't0001'))).toBe(false);
  });

  it('asks nothing of no blocks, and names each block once and no more than its cap', () => {
    expect(compileBlocksQuery([])).toBeNull();
    const many = Array.from({ length: ASSISTANT_PATHS_PER_QUERY + 50 }, (_, at) =>
      block(`N/${at}.md`, 't0001'),
    );
    const compiled = compileBlocksQuery([...many, ...many]);
    expect(compiled?.parameters).toHaveLength(ASSISTANT_PATHS_PER_QUERY * 2);
  });
});

describe('compileSourcesQuery', () => {
  const run = assistantIndex(NOTES);

  it('answers the source of each note that has one', () => {
    const sources = sourcesOf(
      run(compileSourcesQuery(['Tasks/Chase the quote.md', 'Tasks/Check the rates.md', MARA])) ??
        [],
    );
    expect([...sources]).toEqual([['Tasks/Chase the quote.md', '[[Kickoff#^t0002]]']]);
  });

  it('asks nothing of no notes', () => {
    expect(compileSourcesQuery([])).toBeNull();
  });

  it('leaves out a row that is not a path and a text', () => {
    expect([
      ...sourcesOf([
        [1, 'x'],
        ['a.md', null],
        ['b.md', '[[B]]'],
      ]),
    ]).toEqual([['b.md', '[[B]]']]);
  });
});

describe('followUpRowsOf', () => {
  it('leaves out a row with no path and names an untitled one by its path', () => {
    expect(
      followUpRowsOf([
        [null, 'x'],
        ['Tasks/A.md', null, 3, null, null, 4, null, 0, null, null],
      ]),
    ).toEqual([
      {
        path: 'Tasks/A.md',
        title: 'Tasks/A.md',
        status: null,
        due: null,
        source: null,
        waitingOn: null,
        modified: null,
        direct: false,
        meeting: null,
        meetingTitle: null,
      },
    ]);
  });
});
