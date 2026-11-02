import { beforeEach, describe, expect, it } from 'vitest';
import {
  compileAtlasQuery,
  compileInboxQuery,
  compileLinkHintsQuery,
  compileReviewDoneQuery,
  compileReviewTasksQuery,
  createVaultPath,
  createWikiLinkResolver,
  parseAtlasQuery,
  parseObjectType,
  reviewTask,
  type CompiledQuery,
} from '@dfai/domain';
import { toIndexedNote } from '../index/to-indexed-note.ts';
import { viewSpecsFor } from '../query/run-view.ts';
import type { IndexPort, QueryResult } from '../index/ports.ts';
import type { MarkdownPort } from '../notes/ports.ts';

/**
 * What every index answers alike (#666): the queries the app runs — the
 * query language's field SQL, the Inbox, Today's and the review's tasks,
 * the week's wins, link hints, a type's view — and search, backlinks, a
 * type's notes and the manifest. The desktop's stand-in (`sqliteIndexPort`,
 * on the host's statements) and the browser's index (SQLite's WebAssembly)
 * each run this suite, so a query cannot answer one way on the desktop and
 * another on an iPad. A rule here is the host's (`index.rs`).
 */

export interface IndexUnderTest {
  /** A fresh index, opened and empty. */
  readonly make: () => Promise<IndexPort>;
  readonly markdown: MarkdownPort;
}

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 2, 15);

/** A small vault: an Inbox, tasks in a project, a person, a note that links them. */
const VAULT: Readonly<Record<string, { text: string; modified: number }>> = {
  'Inbox/Call the bank.md': { text: '# Call the bank\n', modified: NOW - 1 * DAY },
  'Inbox/Seed order.md': {
    text: '---\ntype: task\nstatus: inbox\n---\n# Seed order\n',
    modified: NOW - 2 * DAY,
  },
  'Tasks/Send the plan.md': {
    text: '---\ntype: task\nstatus: next-action\ndue: 2026-11-03\nproject: "[[Larkspur]]"\n---\nSend it.\n',
    modified: NOW - 3 * DAY,
  },
  'Tasks/Hear from Mara.md': {
    text: '---\ntype: task\nstatus: waiting\nwaiting_on: "[[Mara Quill]]"\n---\nWaiting.\n',
    modified: NOW - 4 * DAY,
  },
  'Tasks/Planted.md': {
    text: '---\ntype: task\nstatus: archive\ncompleted: 2026-10-30\n---\nDone.\n',
    modified: NOW - 5 * DAY,
  },
  'Projects/Larkspur.md': {
    text: '---\ntype: project\nstatus: active\nowner: "[[Mara Quill]]"\n---\nA garden with [[Mara Quill]].\n',
    modified: NOW - 6 * DAY,
  },
  'People/Mara Quill.md': {
    text: '---\ntype: person\naliases:\n  - MQ\n---\nGrows larkspur.\n',
    modified: NOW - 7 * DAY,
  },
  'Notes/Garden journal.md': {
    text: '# Garden journal\n\nThe seed order for [[Larkspur]] came today. #garden\n',
    modified: NOW - 8 * DAY,
  },
};

const TYPES = [
  parseObjectType({
    name: 'task',
    label: 'Task',
    properties: {
      status: { kind: 'select', options: ['inbox', 'next-action', 'waiting', 'archive'] },
      due: 'date',
      project: { kind: 'relation', target: 'project' },
    },
  }),
  parseObjectType({
    name: 'project',
    label: 'Project',
    properties: {
      status: { kind: 'select', options: ['active', 'paused'] },
      owner: { kind: 'relation', target: 'person' },
    },
  }),
  parseObjectType({ name: 'person', label: 'Person', properties: {} }),
];

const PATHS = Object.keys(VAULT).map(createVaultPath);
const resolveLink = createWikiLinkResolver(PATHS);

function indexedVault(markdown: MarkdownPort) {
  return Object.entries(VAULT).map(([path, { text, modified }]) =>
    toIndexedNote({
      file: { path, text, modified, size: text.length },
      notePaths: PATHS,
      markdown,
      resolveLink,
    }),
  );
}

/** A result's rows as objects, by column. */
const records = ({ columns, rows }: QueryResult) =>
  rows.map((row) => Object.fromEntries(columns.map((column, at) => [column, row[at]])));

export function indexContract(name: string, under: IndexUnderTest): void {
  describe(`${name}: the index contract (#666)`, () => {
    let index: IndexPort;
    const ask = async ({ sql, parameters }: CompiledQuery) =>
      records(await index.query(sql, parameters));
    beforeEach(async () => {
      index = await under.make();
      await index.put(indexedVault(under.markdown));
    });

    queriesContract(() => index, ask);
    hostCallsContract(() => index, under.markdown);
  });
}

type Ask = (compiled: CompiledQuery) => Promise<Record<string, unknown>[]>;

function queriesContract(index: () => IndexPort, ask: Ask) {
  it('answers a query in the query language: the field SQL it compiles to', async () => {
    const compiled = compileAtlasQuery(
      parseAtlasQuery('FROM task WHERE status != archive SORT BY due'),
      { types: TYPES, resolveLink },
    );
    const rows = await ask(compiled);
    expect(rows.map((row) => row['path'])).toEqual([
      'Tasks/Send the plan.md',
      // No due day, so by title.
      'Tasks/Hear from Mara.md',
      'Inbox/Seed order.md',
    ]);
  });

  it('lists the Inbox newest first, and a page reads on from its key', async () => {
    const first = await ask(compileInboxQuery({ limit: 1 }));
    expect(first.map((row) => row['path'])).toEqual(['Inbox/Call the bank.md']);
    const after = {
      modified: Number(first[0]?.['modified']),
      path: createVaultPath('Inbox/Call the bank.md'),
    };
    const rest = await ask(compileInboxQuery({ after }));
    expect(rest.map((row) => row['path'])).toEqual(['Inbox/Seed order.md']);
  });

  it("reads Today's and the review's tasks, with their project and time", async () => {
    const tasks = (await ask(compileReviewTasksQuery())).map(reviewTask);
    const plan = tasks.find((task) => task.path === 'Tasks/Send the plan.md');
    expect(plan).toMatchObject({
      status: 'next-action',
      due: '2026-11-03',
      project: 'Projects/Larkspur.md',
      modified: NOW - 3 * DAY,
    });
    expect(tasks.find((task) => task.status === 'waiting')?.waitingOn).toBe('Mara Quill');
  });

  it("finds the week's wins by their completed day", async () => {
    const rows = await ask(compileReviewDoneQuery(NOW - 7 * DAY));
    expect(rows.map((row) => row['path'])).toEqual(['Tasks/Planted.md']);
  });

  it('reads the link hints: notes, aliases, and how lately each note is used', async () => {
    const aliases = await ask(compileLinkHintsQuery('aliases', 0));
    expect(aliases.map((row) => [row['path'], row['text']])).toEqual([
      ['People/Mara Quill.md', 'MQ'],
    ]);
    const uses = await ask(compileLinkHintsQuery('uses', 0));
    expect(uses.map((row) => [row['path'], row['uses'], row['last']])).toEqual([
      ['People/Mara Quill.md', 2, NOW - 4 * DAY],
      ['Projects/Larkspur.md', 1, NOW - 3 * DAY],
    ]);
  });

  it("reads a type's view once the views are rebuilt", async () => {
    await index().rebuildViews(viewSpecsFor(TYPES));
    const rows = records(await index().query('SELECT path, status FROM v_project', []));
    expect(rows).toEqual([{ path: 'Projects/Larkspur.md', status: 'active' }]);
  });

  it('refuses a query that would write, and one that carries a second statement', async () => {
    await expect(index().query('DELETE FROM files', [])).rejects.toThrow();
    await expect(index().query('SELECT 1; DELETE FROM files', [])).rejects.toThrow();
    expect((await index().stats()).notes).toBe(PATHS.length);
  });

  it('binds a text, a number and a null as themselves', async () => {
    const rows = records(
      await index().query('SELECT ? AS "text", ? AS "number", ? AS "nothing"', ['a"b', 7, null]),
    );
    expect(rows).toEqual([{ text: 'a"b', number: 7, nothing: null }]);
  });
}

function hostCallsContract(index: () => IndexPort, markdown: MarkdownPort) {
  it('searches titles, file names and bodies, ranked, with the words marked', async () => {
    const hits = await index().search('larkspur', 10);
    expect(hits.map((hit) => hit.path)).toEqual([
      'Projects/Larkspur.md',
      'People/Mara Quill.md',
      'Notes/Garden journal.md',
    ]);
    const journal = hits.find((hit) => hit.path === 'Notes/Garden journal.md');
    expect(journal?.snippet).toContain('<<Larkspur>>');
  });

  it('leaves out the notes under the prefix a search is told to skip', async () => {
    const hits = await index().search('larkspur', 10, { skipPrefix: 'people/' });
    expect(hits.map((hit) => hit.path)).not.toContain('People/Mara Quill.md');
  });

  it('refuses a search that is no search expression', async () => {
    await expect(index().search('"unclosed', 10)).rejects.toThrow();
  });

  it('answers backlinks, a type’s notes and the counts', async () => {
    expect(await index().backlinks(createVaultPath('Projects/Larkspur.md'))).toEqual([
      'Notes/Garden journal.md',
    ]);
    expect(await index().notesOfType('  Person ')).toEqual([
      { path: 'People/Mara Quill.md', title: 'Mara Quill' },
    ]);
    expect(await index().stats()).toMatchObject({ notes: PATHS.length });
  });

  it('holds each note in the manifest by its version, and lets a removed note go', async () => {
    const before = await index().manifest();
    expect(before.find((entry) => entry.path === 'Tasks/Planted.md')).toMatchObject({
      modified: NOW - 5 * DAY,
      type: 'task',
    });
    await index().remove([createVaultPath('Tasks/Planted.md')]);
    const after = await index().manifest();
    expect(after.map((entry) => entry.path)).not.toContain('Tasks/Planted.md');
    expect(await index().search('done', 10)).toEqual([]);
  });

  it('replaces a note put again, its old rows gone', async () => {
    const again = toIndexedNote({
      file: {
        path: 'Notes/Garden journal.md',
        text: '# Garden journal\n\nRain.\n',
        modified: NOW,
        size: 22,
      },
      notePaths: PATHS,
      markdown,
      resolveLink,
    });
    await index().put([again]);
    expect(await index().backlinks(createVaultPath('Projects/Larkspur.md'))).toEqual([]);
    expect((await index().search('rain', 10)).map((hit) => hit.path)).toEqual([
      'Notes/Garden journal.md',
    ]);
  });
}
