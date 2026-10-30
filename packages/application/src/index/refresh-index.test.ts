import { describe, expect, it, vi } from 'vitest';
import { createVaultPath, digestOf, IMPORT_OUTCOME_KEY, IMPORT_OUTCOMES_PAGE } from '@dfai/domain';
import {
  heldEntries,
  INDEX_BATCH_SIZE,
  IndexSyncAbandoned,
  refreshIndex,
} from './refresh-index.ts';
import { toIndexedNote } from './to-indexed-note.ts';
import { inThreadNoteDeriver, type NoteDeriver } from './note-deriver.ts';
import type { IndexedNote, IndexEntry, IndexPort } from './ports.ts';
import type { VaultFsPort } from '../vault/ports.ts';
import type { MarkdownPort } from '../notes/ports.ts';

/** A markdown port with real-enough behaviour for indexing, without remark. */
const markdown: MarkdownPort = {
  parseBody: () => ({ blocks: [], doc: { type: 'doc', content: [] } }),
  serializeBody: () => '',
  rawParts: () => [],
  noteBlocks: () => ({ quotes: [], hidden: [] }),
  writeTree: () => '',
  addToFrontmatterMap: () => null,
  frontmatterProblem: () => null,
  frontmatterKeyTexts: () => ({}),
  frontmatterProperties: (frontmatter) =>
    frontmatter === null
      ? {}
      : Object.fromEntries(
          frontmatter
            .split('\n')
            .map((line) => /^(\w+):\s*(.*)$/.exec(line))
            .filter((match): match is RegExpExecArray => match !== null)
            .map((match) => [match[1] as string, match[2] as string]),
        ),
  plainText: (body) => body.trim(),
  textRanges: (body: string) => [{ start: 0, end: body.length }],
  updateFrontmatter: (_frontmatter, changes) =>
    `---\n${Object.entries(changes)
      .map(([key, value]) => `${key}: ${String(value)}`)
      .join('\n')}\n---\n`,
};

function fakeVault(files: Record<string, { text: string; modified: number }>) {
  const fs: VaultFsPort = {
    listDirectory: async () => [],
    listFiles: async () => [],
    listNotes: async () =>
      Object.entries(files).map(([path, file]) => ({
        name: path.split('/').at(-1) ?? path,
        path: createVaultPath(path),
        modified: file.modified,
        size: file.text.length,
      })),
    readNotes: async (paths) =>
      paths.flatMap((path) => {
        const file = files[path];
        return file === undefined
          ? []
          : [{ path, text: file.text, modified: file.modified, size: file.text.length }];
      }),
    readBinaryFile: async () => new ArrayBuffer(0),
    createNote: async () => 0,
    createFolder: async () => {},
    moveEntry: async () => {},
    trashEntry: async () => {},
    writeBinaryFile: async () => 0,
    readTextFile: async () => ({ text: '', modified: 0 }),
    writeTextFile: async () => 0,
  };
  return fs;
}

/** An index entry; its version is left out where a test does not care what it is. */
type HeldEntry = Omit<IndexEntry, 'digest' | 'type'> & Partial<Pick<IndexEntry, 'digest' | 'type'>>;

function fakeIndex(entries: HeldEntry[] = []) {
  const written: IndexedNote[] = [];
  const removed: string[] = [];
  const index: IndexPort = {
    open: async () => ({ fresh: false }),
    clear: async () => {},
    manifest: async () => entries.map((entry) => ({ digest: '', type: null, ...entry })),
    put: async (notes) => {
      written.push(...notes);
    },
    remove: async (paths) => {
      removed.push(...paths);
    },
    search: async () => [],
    backlinks: async () => [],
    notesOfType: async () => [],
    rebuildViews: async () => {},
    query: async () => ({ columns: [], rows: [], truncated: false }),
    stats: async () => ({ notes: 0, properties: 0, links: 0 }),
  };
  return { index, written, removed };
}

describe('refreshIndex', () => {
  it('indexes every note when the index is empty', async () => {
    const fs = fakeVault({ 'a.md': { text: 'alpha', modified: 1 } });
    const { index, written } = fakeIndex();

    const result = await refreshIndex({ fs, index, markdown });

    expect(result).toMatchObject({ indexed: 1, removed: 0, unchanged: 0 });
    expect(written.map((note) => note.path)).toEqual(['a.md']);
  });

  it('skips notes that have not changed', async () => {
    const fs = fakeVault({ 'a.md': { text: 'alpha', modified: 1 } });
    const { index, written } = fakeIndex([{ path: 'a.md', modified: 1, size: 5 }]);

    const result = await refreshIndex({ fs, index, markdown });

    expect(result).toMatchObject({ indexed: 0, unchanged: 1 });
    expect(written).toEqual([]);
  });

  it('re-indexes a note whose modification time changed', async () => {
    const fs = fakeVault({ 'a.md': { text: 'alpha', modified: 2 } });
    const { index, written } = fakeIndex([{ path: 'a.md', modified: 1, size: 5 }]);

    await refreshIndex({ fs, index, markdown });
    expect(written).toHaveLength(1);
  });

  it('re-indexes a note whose size changed even at the same timestamp', async () => {
    const fs = fakeVault({ 'a.md': { text: 'alpha and more', modified: 1 } });
    const { index, written } = fakeIndex([{ path: 'a.md', modified: 1, size: 5 }]);

    await refreshIndex({ fs, index, markdown });
    expect(written).toHaveLength(1);
  });

  it('removes notes that are no longer in the vault', async () => {
    const fs = fakeVault({});
    const { index, removed } = fakeIndex([{ path: 'gone.md', modified: 1, size: 1 }]);

    const result = await refreshIndex({ fs, index, markdown });

    expect(removed).toEqual(['gone.md']);
    expect(result.removed).toBe(1);
  });

  it('does not call remove when nothing was deleted', async () => {
    const fs = fakeVault({ 'a.md': { text: 'alpha', modified: 1 } });
    const { index } = fakeIndex([{ path: 'a.md', modified: 1, size: 5 }]);
    const remove = vi.spyOn(index, 'remove');

    await refreshIndex({ fs, index, markdown });
    expect(remove).not.toHaveBeenCalled();
  });

  it('reports progress as it goes', async () => {
    const files = Object.fromEntries(
      Array.from({ length: 3 }, (_, i) => [`n${i}.md`, { text: 'x', modified: 1 }]),
    );
    const { index } = fakeIndex();
    const onProgress = vi.fn();

    await refreshIndex({ fs: fakeVault(files), index, markdown, onProgress });

    expect(onProgress).toHaveBeenCalledWith(3, 3);
  });

  it('indexes an empty vault without failing', async () => {
    const { index } = fakeIndex();
    await expect(refreshIndex({ fs: fakeVault({}), index, markdown })).resolves.toMatchObject({
      indexed: 0,
      removed: 0,
    });
  });

  /**
   * The host used to prune dotted folders before the list ever crossed IPC, so
   * nothing here had to rule them out. Now that it returns what is on disk, this
   * is what keeps `.git` out of search results.
   */
  it('leaves out a note the host found in a hidden directory', async () => {
    const fs = fakeVault({
      'keep.md': { text: 'alpha', modified: 1 },
      '.git/COMMIT_EDITMSG.md': { text: 'wip', modified: 1 },
      'node_modules/pkg/readme.md': { text: 'docs', modified: 1 },
      '.secret/private.md': { text: 'shh', modified: 1 },
    });
    const { index, written } = fakeIndex();

    const result = await refreshIndex({ fs, index, markdown });

    expect(written.map((note) => note.path)).toEqual(['keep.md']);
    expect(result.indexed).toBe(1);
  });

  it('indexes .atlas notes, so searching finds a type or a template', async () => {
    const fs = fakeVault({
      '.atlas/types/task.md': { text: 'task type', modified: 1 },
      '.atlas/views/Board.md': { text: 'the board', modified: 1 },
    });
    const { index, written } = fakeIndex();

    await refreshIndex({ fs, index, markdown });

    // The board has a sidebar section of its own; the type definition does not.
    expect(written.map((note) => note.path)).toEqual(['.atlas/types/task.md']);
  });

  it('does not treat a hidden note as deleted and remove it from the index', async () => {
    // A note the frontend never listed was never indexed, so there is nothing to
    // remove — and a removal here would fight the next refresh forever.
    const fs = fakeVault({ '.git/COMMIT_EDITMSG.md': { text: 'wip', modified: 1 } });
    const { index, removed } = fakeIndex();

    await refreshIndex({ fs, index, markdown });

    expect(removed).toEqual([]);
  });

  it('resolves links against user space only', async () => {
    const fs = fakeVault({
      'a.md': { text: 'see [[private]]', modified: 1 },
      '.secret/private.md': { text: 'shh', modified: 1 },
    });
    const { index, written } = fakeIndex();

    await refreshIndex({ fs, index, markdown });

    expect(written[0]?.links).toEqual([
      { target: 'private', leaf: 'private', path: null, kind: 'wikilink' },
    ]);
  });
});

describe('refreshIndex says what changed (P28-03)', () => {
  const meeting = '---\ntype: meeting\n---\nAgenda';

  it('measures from what the index held when given nothing earlier', async () => {
    const fs = fakeVault({ 'Kickoff.md': { text: meeting, modified: 2 } });
    const { index } = fakeIndex([
      { path: 'Kickoff.md', modified: 1, size: 5, digest: digestOf('Agenda'), type: null },
      { path: 'Gone.md', modified: 1, size: 1, digest: 'aa', type: 'task' },
    ]);

    const { changes } = await refreshIndex({ fs, index, markdown });

    expect(changes).toEqual([
      {
        kind: 'changed',
        path: 'Kickoff.md',
        type: 'meeting',
        digest: digestOf(meeting),
        before: digestOf('Agenda'),
        // It declared no type before: a reader of meetings is told it joined them (#325).
        beforeType: null,
      },
      { kind: 'removed', path: 'Gone.md', type: 'task', digest: 'aa' },
    ]);
  });

  it('does not call a note read again changed when its text is the same', async () => {
    const fs = fakeVault({ 'Kickoff.md': { text: meeting, modified: 2 } });
    const { index, written } = fakeIndex([
      { path: 'Kickoff.md', modified: 1, size: 5, digest: digestOf(meeting), type: 'meeting' },
    ]);

    const { changes } = await refreshIndex({ fs, index, markdown });

    expect(written).toHaveLength(1);
    expect(changes).toEqual([]);
  });

  it('measures from the notes it is given as earlier, over what the index holds', async () => {
    const fs = fakeVault({ 'Kickoff.md': { text: meeting, modified: 1 } });
    const { index } = fakeIndex([
      {
        path: 'Kickoff.md',
        modified: 1,
        size: meeting.length,
        digest: digestOf(meeting),
        type: 'meeting',
      },
    ]);

    const { changes } = await refreshIndex({
      fs,
      index,
      markdown,
      previous: new Map([['Retired.md', { type: 'meeting', digest: digestOf(meeting) }]]),
    });

    expect(changes).toEqual([
      { kind: 'added', path: 'Kickoff.md', type: 'meeting', digest: digestOf(meeting) },
      { kind: 'removed', path: 'Retired.md', type: 'meeting', digest: digestOf(meeting) },
    ]);
  });

  it('keeps the version it knew of a note still listed that could not be read', async () => {
    const fs = {
      ...fakeVault({ 'Kickoff.md': { text: meeting, modified: 2 } }),
      readNotes: async () => [],
    };
    const { index } = fakeIndex();

    const { changes } = await refreshIndex({
      fs,
      index,
      markdown,
      previous: new Map([['Kickoff.md', { type: 'meeting', digest: digestOf(meeting) }]]),
    });

    expect(changes).toEqual([]);
  });

  it('does not report a note it has never been able to read', async () => {
    const fs = {
      ...fakeVault({ 'Kickoff.md': { text: meeting, modified: 1 } }),
      readNotes: async () => [],
    };
    const { index } = fakeIndex();

    const { changes } = await refreshIndex({ fs, index, markdown });

    expect(changes).toEqual([]);
  });
});

describe('refreshIndex says how the meeting import settled each note (#92)', () => {
  const held = '---\ntype: meeting\natlas_import_outcome: imported\n---\nAgenda';
  const edited = `${held} and more`;

  it('reads the stamp from a note it reads again, and from the index for the note it held', async () => {
    const fs = fakeVault({ 'Standup.md': { text: edited, modified: 2 } });
    const { index } = fakeIndex([
      { path: 'Standup.md', modified: 1, size: 5, digest: digestOf(held), type: 'meeting' },
    ]);
    index.query = async (_sql, parameters) => ({
      columns: ['path', 'outcome'],
      rows: parameters.includes('atlas_import_outcome') ? [['Standup.md', 'imported']] : [],
      truncated: false,
    });

    const { changes } = await refreshIndex({ fs, index, markdown });

    expect(changes).toEqual([
      {
        kind: 'changed',
        path: 'Standup.md',
        type: 'meeting',
        digest: digestOf(edited),
        before: digestOf(held),
        importOutcome: 'imported',
        beforeImportOutcome: 'imported',
      },
    ]);
  });
});

describe('refreshIndex and relations to notes that come and go (P24 review)', () => {
  /** An index that answers the stale-relations question with `holders`, and records it. */
  function indexHolding(entries: HeldEntry[], holders: string[]) {
    const fake = fakeIndex(entries);
    const asked: unknown[][] = [];
    fake.index.query = async (sql, parameters) => {
      asked.push([sql, ...parameters]);
      return sql.includes('FROM relations')
        ? { columns: ['path'], rows: holders.map((path) => [path]), truncated: false }
        : { columns: [], rows: [], truncated: false };
    };
    return { ...fake, asked };
  }

  it('re-reads a note whose relation points at a note that has just been made', async () => {
    const source = '---\nproject: [[Later]]\n---\nbody';
    const fs = fakeVault({
      'a.md': { text: source, modified: 1 },
      'p/Later.md': { text: 'later', modified: 2 },
    });
    const { index, written, asked } = indexHolding(
      [{ path: 'a.md', modified: 1, size: source.length }],
      ['a.md'],
    );

    await refreshIndex({ fs, index, markdown });

    expect(asked.flat()).toContain('later');
    const again = written.find((note) => note.path === 'a.md');
    expect(again?.relations).toEqual([
      { key: 'project', index: 0, target: 'Later', name: 'later', path: 'p/Later.md' },
    ]);
  });

  it('re-reads a note whose relation pointed at a note that has gone', async () => {
    const source = '---\nproject: [[Gone]]\n---\nbody';
    const fs = fakeVault({ 'b.md': { text: source, modified: 1 } });
    const { index, written } = indexHolding(
      [
        { path: 'b.md', modified: 1, size: source.length },
        { path: 'p/Gone.md', modified: 1, size: 4 },
      ],
      ['b.md', 'p/Gone.md'],
    );

    await refreshIndex({ fs, index, markdown });

    // The note that went is not read again; the one that pointed at it is.
    expect(written.map((note) => note.path)).toEqual(['b.md']);
    expect(written[0]?.relations[0]?.path).toBeNull();
  });

  it('asks nothing more when no note came or went', async () => {
    const fs = fakeVault({ 'a.md': { text: 'alpha', modified: 1 } });
    const { index, asked } = indexHolding([{ path: 'a.md', modified: 1, size: 5 }], ['a.md']);
    await refreshIndex({ fs, index, markdown });
    // Only the questions every refresh of a held index asks: how the import settled each note,
    // and which declare its contract (#214).
    expect(asked.filter(([sql]) => String(sql).includes('FROM relations'))).toEqual([]);
    expect(asked).toHaveLength(2);
  });
});

describe('toIndexedNote', () => {
  const notePaths = ['a.md', 'Notes/Target.md'].map(createVaultPath);

  const build = (text: string) =>
    toIndexedNote({
      file: { path: 'a.md', text, modified: 7, size: text.length },
      notePaths,
      markdown,
    });

  it('takes the title from the filename when the note gives no other', () => {
    expect(build('body').title).toBe('a');
  });

  it('takes the title the page is headed by: the title property, else the filename', () => {
    expect(build('---\ntitle: Today\n---\n# Something else\n').title).toBe('Today');
    // A heading in the body is not the page's name: the page head never shows
    // it, so a list that did would disagree with the page (U-09).
    expect(build('\n# Runs in WebKit\n\nbody').title).toBe('a');
    expect(build('intro\n\n# Later heading\n').title).toBe('a');
  });

  it('indexes the body without its frontmatter', () => {
    expect(build('---\ntitle: Today\n---\nthe body').body).toBe('the body');
  });

  it('turns frontmatter into properties', () => {
    expect(build('---\nstatus: draft\n---\nbody').properties).toEqual([
      { key: 'status', index: 0, text: 'draft', number: null, date: null, json: null },
    ]);
  });

  it('records a link and where it resolves to', () => {
    expect(build('see [[Target]] here').links).toEqual([
      { target: 'Target', leaf: 'target', path: 'Notes/Target.md', kind: 'wikilink' },
    ]);
  });

  it('records each property written as a link, resolved the way a link in the body is', () => {
    expect(build('---\nproject: "[[target]]"\nowner: "[[Nobody]]"\n---\nbody').relations).toEqual([
      { key: 'project', index: 0, target: 'target', name: 'target', path: 'Notes/Target.md' },
      { key: 'owner', index: 0, target: 'Nobody', name: 'nobody', path: null },
    ]);
  });

  it('records each block with an id, as the editor reads the body (P26-01)', () => {
    const parseBody = vi.fn(() => ({
      blocks: [],
      doc: {
        type: 'doc' as const,
        content: [
          {
            type: 'paragraph',
            attrs: { anchor: 'f3k9x2' },
            content: [{ type: 'text', text: 'Plan' }],
          },
          { type: 'paragraph', content: [{ type: 'text', text: 'No id' }] },
        ],
      },
    }));
    const note = toIndexedNote({
      file: { path: 'a.md', text: 'Plan ^f3k9x2\n\nNo id\n', modified: 1, size: 20 },
      notePaths,
      markdown: { ...markdown, parseBody },
    });
    expect(note.blocks).toEqual([{ id: 'f3k9x2', text: 'Plan' }]);
    expect(parseBody).toHaveBeenCalledWith('Plan ^f3k9x2\n\nNo id\n');
  });

  it('records each checklist box and the progress through them (P30-03)', () => {
    const box = (text: string, checked: boolean) => ({
      type: 'taskItem',
      attrs: { checked },
      content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
    });
    const parseBody = vi.fn(() => ({
      blocks: [],
      doc: {
        type: 'doc' as const,
        content: [
          {
            type: 'taskList',
            content: [
              box('One', true),
              box('Two', false),
              box('Three', true),
              box('Four', false),
              box('Five', false),
            ],
          },
        ],
      },
    }));
    const body = '- [x] One\n- [ ] Two\n- [x] Three\n- [ ] Four\n- [ ] Five\n';
    const note = toIndexedNote({
      file: { path: 'a.md', text: body, modified: 1, size: body.length },
      notePaths,
      markdown: { ...markdown, parseBody },
    });
    expect(note.checks).toEqual([
      { done: true, text: 'One' },
      { done: false, text: 'Two' },
      { done: true, text: 'Three' },
      { done: false, text: 'Four' },
      { done: false, text: 'Five' },
    ]);
    expect(note.progress).toBe(40);
    expect(note.blocks).toEqual([]);
    expect(parseBody).toHaveBeenCalledTimes(1);
  });

  it('reads ids and boxes from one parse of a body that may hold both', () => {
    const parseBody = vi.fn(markdown.parseBody);
    toIndexedNote({
      file: { path: 'a.md', text: '- [ ] One ^a1\n', modified: 1, size: 14 },
      notePaths,
      markdown: { ...markdown, parseBody },
    });
    expect(parseBody).toHaveBeenCalledTimes(1);
  });

  it('does not parse a body with no box and no caret, and gives it no progress', () => {
    const parseBody = vi.fn(markdown.parseBody);
    const note = toIndexedNote({
      file: { path: 'a.md', text: '- a list\n', modified: 1, size: 9 },
      notePaths,
      markdown: { ...markdown, parseBody },
    });
    expect(note.checks).toEqual([]);
    expect(note.progress).toBeNull();
    expect(parseBody).not.toHaveBeenCalled();
  });

  it('does not parse a body with no caret in it for block ids', () => {
    const parseBody = vi.fn(markdown.parseBody);
    const note = toIndexedNote({
      file: { path: 'a.md', text: 'plain', modified: 1, size: 5 },
      notePaths,
      markdown: { ...markdown, parseBody },
    });
    expect(note.blocks).toEqual([]);
    expect(parseBody).not.toHaveBeenCalled();
  });

  it('records a link that points nowhere, so it can be found later', () => {
    expect(build('see [[Missing]] here').links).toEqual([
      { target: 'Missing', leaf: 'missing', path: null, kind: 'wikilink' },
    ]);
  });

  it('records every use of a tag, the tags property first, keyed without case', () => {
    expect(
      build('---\ntags: Project, para/area\n---\nsee #Idea and #idea, and #tag me#').tags,
    ).toEqual([
      { key: 'project', name: 'Project' },
      { key: 'para/area', name: 'para/area' },
      { key: 'idea', name: 'Idea' },
      { key: 'idea', name: 'idea' },
      { key: 'tag me', name: 'tag me' },
    ]);
  });

  it('records no tags for a note without any, nor a heading', () => {
    expect(build('# Heading\n\nplain text').tags).toEqual([]);
  });

  it('keeps the file facts for change detection', () => {
    expect(build('body')).toMatchObject({ modified: 7, size: 4 });
  });

  it('keeps a digest of the whole text and the type the note declares (P28-03)', () => {
    const text = '---\ntype: meeting\n---\nAgenda';
    expect(build(text)).toMatchObject({ digest: digestOf(text), type: 'meeting' });
    expect(build('Agenda')).toMatchObject({ digest: digestOf('Agenda'), type: null });
  });

  it('keeps how the meeting import settled the note, and nothing when it has not (#92)', () => {
    expect(build('---\natlas_import_outcome: error\n---\n')).toMatchObject({
      importOutcome: 'error',
    });
    expect(build('Agenda')).not.toHaveProperty('importOutcome');
  });
});

describe('heldEntries: the import stamps of the notes the index holds (#92 review)', () => {
  const entries: HeldEntry[] = [
    { path: 'Inbox/Meetings/Standup.md', modified: 1, size: 5, digest: 'aa', type: 'meeting' },
    { path: 'Projects/Notes.md', modified: 1, size: 5, digest: 'bb', type: null },
  ];

  it('asks only about notes where meeting files land', async () => {
    const { index } = fakeIndex(entries);
    const asked: string[] = [];
    index.query = async (sql) => {
      asked.push(sql);
      return { columns: [], rows: [], truncated: false };
    };

    await heldEntries(index);

    // The stamps, and which notes declare the contract (#214): each only where meeting files land.
    expect(asked).toHaveLength(2);
    for (const sql of asked) {
      expect(sql).toContain(`lower(path) LIKE 'inbox/meetings/%'`);
      expect(sql).toContain(`lower(path) GLOB 'meetings/[0-9][0-9][0-9][0-9]/[0-9][0-9]/*'`);
    }
  });

  it('reads every page of stamps, not only the first', async () => {
    const { index } = fakeIndex(entries);
    const page = Array.from({ length: IMPORT_OUTCOMES_PAGE }, (_, n) => [
      `Inbox/Meetings/${n}.md`,
      'imported',
    ]);
    let pages = 0;
    index.query = async (_sql, parameters) => {
      // The declarations are asked apart, once the stamps are in (#214).
      if (parameters?.[0] !== IMPORT_OUTCOME_KEY)
        return { columns: [], rows: [], truncated: false };
      pages++;
      return {
        columns: [],
        rows: pages === 1 ? page : [['Inbox/Meetings/Standup.md', 'error']],
        truncated: false,
      };
    };

    const held = await heldEntries(index);

    expect(pages).toBe(2);
    expect(held.get('Inbox/Meetings/Standup.md')?.importOutcome).toBe('error');
  });

  it('takes the notes where meetings land as already arrived when the host cut the stamps short', async () => {
    const { index } = fakeIndex(entries);
    index.query = async () => ({ columns: [], rows: [], truncated: true });

    const held = await heldEntries(index);

    expect(held.get('Inbox/Meetings/Standup.md')).toMatchObject({ arrivalHeard: true });
    expect(held.get('Projects/Notes.md')).not.toHaveProperty('arrivalHeard');
  });

  it('takes them as already arrived when the stamps cannot be asked for, and still answers', async () => {
    const { index } = fakeIndex(entries);
    index.query = async () => {
      throw new Error('no such column');
    };

    const held = await heldEntries(index);

    expect(held.size).toBe(2);
    expect(held.get('Inbox/Meetings/Standup.md')).toMatchObject({ arrivalHeard: true });
  });
});

/** A vault of this many small notes, for a build that takes more than one batch. */
function manyNotes(count: number) {
  return Object.fromEntries(
    Array.from({ length: count }, (_, n) => [`Note ${n}.md`, { text: `note ${n}`, modified: 1 }]),
  );
}

/** The in-thread deriver, watched: what it was handed, batch by batch, and whether it was let go. */
function watchedDeriver() {
  const batches: number[] = [];
  let ended = 0;
  const deriver: NoteDeriver = {
    begin(notePaths) {
      const deriving = inThreadNoteDeriver(markdown).begin(notePaths);
      return {
        derive: async (files) => {
          batches.push(files.length);
          return deriving.derive(files);
        },
        end: () => {
          ended += 1;
        },
      };
    },
  };
  return { deriver, batches, ended: () => ended };
}

describe('refreshIndex, with the notes derived elsewhere (#135)', () => {
  it('reads no note itself, and hands the deriver no more than a batch at a time', async () => {
    const fs = fakeVault(manyNotes(INDEX_BATCH_SIZE * 2 + 20));
    const { index, written } = fakeIndex();
    const { deriver, batches, ended } = watchedDeriver();
    // What the calling thread would run, were it to read a note: none of it may be asked.
    const untouched: MarkdownPort = {
      ...markdown,
      frontmatterProperties: vi.fn(markdown.frontmatterProperties),
      plainText: vi.fn(markdown.plainText),
      textRanges: vi.fn(markdown.textRanges),
      parseBody: vi.fn(markdown.parseBody),
    };

    await refreshIndex({ fs, index, markdown: untouched, deriver });

    expect(batches).toEqual([INDEX_BATCH_SIZE, INDEX_BATCH_SIZE, 20]);
    expect(written).toHaveLength(INDEX_BATCH_SIZE * 2 + 20);
    expect(untouched.frontmatterProperties).not.toHaveBeenCalled();
    expect(untouched.plainText).not.toHaveBeenCalled();
    expect(untouched.textRanges).not.toHaveBeenCalled();
    expect(untouched.parseBody).not.toHaveBeenCalled();
    expect(ended()).toBe(1);
  });

  it('keeps a batch small enough that one message to the host stays short', () => {
    expect(INDEX_BATCH_SIZE).toBeLessThanOrEqual(50);
  });

  it('writes the same rows whether the notes are derived here or elsewhere', async () => {
    const files = {
      'a.md': { text: '---\ntype: task\n---\nSee [[b]] #alpha\n', modified: 1 },
      'b.md': { text: '- [ ] one\n- [x] two\n', modified: 2 },
    };
    const here = fakeIndex();
    const elsewhere = fakeIndex();

    await refreshIndex({ fs: fakeVault(files), index: here.index, markdown });
    await refreshIndex({
      fs: fakeVault(files),
      index: elsewhere.index,
      markdown,
      deriver: watchedDeriver().deriver,
    });

    expect(elsewhere.written).toEqual(here.written);
    expect(here.written).toHaveLength(2);
  });

  it('says which notes could not be read as notes, and indexes the rest', async () => {
    const fs = fakeVault({
      'a.md': { text: 'alpha', modified: 1 },
      'broken.md': { text: 'cannot be read', modified: 1 },
      'c.md': { text: 'gamma', modified: 1 },
    });
    const { index, written } = fakeIndex();
    const failing: MarkdownPort = {
      ...markdown,
      plainText: (body) => {
        if (body.includes('cannot be read')) throw new Error('unexpected end of note');
        return markdown.plainText(body);
      },
    };

    const result = await refreshIndex({ fs, index, markdown: failing });

    expect(written.map((note) => note.path)).toEqual(['a.md', 'c.md']);
    expect(result.failed).toEqual([{ path: 'broken.md', problem: 'unexpected end of note' }]);
  });

  it('reports no failures when every note was read', async () => {
    const fs = fakeVault({ 'a.md': { text: 'alpha', modified: 1 } });
    const result = await refreshIndex({ fs, index: fakeIndex().index, markdown });
    expect(result.failed).toEqual([]);
  });

  it('stops between batches once it is no longer wanted, and lets the deriver go', async () => {
    const fs = fakeVault(manyNotes(INDEX_BATCH_SIZE * 3));
    const { index, written } = fakeIndex();
    const { deriver, batches, ended } = watchedDeriver();
    let wanted = true;
    const put = index.put;
    index.put = async (notes) => {
      await put(notes);
      wanted = false;
    };

    await expect(
      refreshIndex({ fs, index, markdown, deriver, stillWanted: () => wanted }),
    ).rejects.toBeInstanceOf(IndexSyncAbandoned);

    expect(batches).toEqual([INDEX_BATCH_SIZE]);
    expect(written).toHaveLength(INDEX_BATCH_SIZE);
    expect(ended()).toBe(1);
  });

  it('writes nothing it derived for a vault closed while it was deriving', async () => {
    const fs = fakeVault(manyNotes(3));
    const { index, written } = fakeIndex();
    let wanted = true;
    const deriver: NoteDeriver = {
      begin: (notePaths) => {
        const deriving = inThreadNoteDeriver(markdown).begin(notePaths);
        return {
          derive: async (files) => {
            wanted = false;
            return deriving.derive(files);
          },
          end: () => {},
        };
      },
    };

    await expect(
      refreshIndex({ fs, index, markdown, deriver, stillWanted: () => wanted }),
    ).rejects.toBeInstanceOf(IndexSyncAbandoned);
    expect(written).toEqual([]);
  });

  it('lets the deriver go when the index refuses a batch', async () => {
    const fs = fakeVault(manyNotes(2));
    const { index } = fakeIndex();
    const { deriver, ended } = watchedDeriver();
    index.put = async () => {
      throw new Error('disk full');
    };

    await expect(refreshIndex({ fs, index, markdown, deriver })).rejects.toThrow('disk full');
    expect(ended()).toBe(1);
  });

  it('counts as indexed only the notes it could read', async () => {
    const fs = fakeVault({
      'a.md': { text: 'alpha', modified: 1 },
      'broken.md': { text: 'cannot be read', modified: 1 },
    });
    const failing: MarkdownPort = {
      ...markdown,
      plainText: (body) => {
        if (body.includes('cannot be read')) throw new Error('unexpected end of note');
        return markdown.plainText(body);
      },
    };

    const result = await refreshIndex({ fs, index: fakeIndex().index, markdown: failing });

    expect(result).toMatchObject({ indexed: 1, unchanged: 0 });
  });

  it('names the vault on every write, so the host can refuse one that arrives late', async () => {
    const fs = fakeVault({ 'a.md': { text: 'alpha', modified: 1 } });
    const { index } = fakeIndex([{ path: 'gone.md', modified: 1, size: 1 }]);
    const put = vi.fn(index.put);
    const remove = vi.fn(index.remove);

    await refreshIndex({
      fs,
      index: { ...index, put, remove },
      markdown,
      vault: '/vaults/Larkspur',
    });

    expect(put).toHaveBeenCalledWith(expect.any(Array), { vault: '/vaults/Larkspur' });
    expect(remove).toHaveBeenCalledWith(['gone.md'], { vault: '/vaults/Larkspur' });
  });

  it('gives up, rather than fails, when the host refuses a batch for a vault since closed', async () => {
    const fs = fakeVault({ 'a.md': { text: 'alpha', modified: 1 } });
    const { index } = fakeIndex();
    let wanted = true;
    index.put = async () => {
      wanted = false;
      throw new Error('another vault was opened before this could be indexed');
    };

    await expect(
      refreshIndex({ fs, index, markdown, stillWanted: () => wanted }),
    ).rejects.toBeInstanceOf(IndexSyncAbandoned);
  });

  it('stops waiting for a batch to be derived the moment it is abandoned', async () => {
    const fs = fakeVault({ 'a.md': { text: 'alpha', modified: 1 } });
    const { index, written } = fakeIndex();
    const abandon = new AbortController();
    let ended = 0;
    let asked = () => {};
    const reached = new Promise<void>((resolve) => (asked = resolve));
    const never: NoteDeriver = {
      begin: () => ({
        derive: () => {
          asked();
          return new Promise(() => {});
        },
        end: () => void (ended += 1),
      }),
    };

    const refreshing = refreshIndex({
      fs,
      index,
      markdown,
      deriver: never,
      abandoned: abandon.signal,
    });
    await reached;
    abandon.abort();

    await expect(refreshing).rejects.toBeInstanceOf(IndexSyncAbandoned);
    expect(written).toEqual([]);
    expect(ended).toBe(1);
  });

  it('says why the notes were read in the window, when the deriver had to', async () => {
    const fs = fakeVault(manyNotes(INDEX_BATCH_SIZE + 1));
    const inWindow: NoteDeriver = {
      begin: (notePaths) => {
        const deriving = inThreadNoteDeriver(markdown).begin(notePaths);
        return {
          derive: async (files) => ({
            ...(await deriving.derive(files)),
            inWindow: 'The worker could not be started.',
          }),
          end: () => {},
        };
      },
    };

    const slow = await refreshIndex({ fs, index: fakeIndex().index, markdown, deriver: inWindow });
    const usual = await refreshIndex({ fs, index: fakeIndex().index, markdown });

    expect(slow.inWindow).toBe('The worker could not be started.');
    expect(usual.inWindow).toBeNull();
  });
});

describe('refreshIndex reads again the notes it is told were changed elsewhere (#245)', () => {
  it('re-reads a named note whose time and size are as held, and says it changed', async () => {
    const fs = fakeVault({ 'Plan.md': { text: 'omega', modified: 1_000 } });
    const { index, written } = fakeIndex([
      { path: 'Plan.md', modified: 1_000, size: 5, digest: digestOf('alpha'), type: null },
    ]);

    const result = await refreshIndex({ fs, index, markdown, recheck: ['Plan.md'] });

    expect(written.map((note) => note.path)).toEqual(['Plan.md']);
    expect(result).toMatchObject({ indexed: 1, unchanged: 0 });
    expect(result.changes).toEqual([
      {
        kind: 'changed',
        path: 'Plan.md',
        type: null,
        digest: digestOf('omega'),
        before: digestOf('alpha'),
      },
    ]);
  });

  it('leaves such a note alone when nothing names it, as an ordinary refresh does', async () => {
    const fs = fakeVault({ 'Plan.md': { text: 'omega', modified: 1_000 } });
    const { index, written } = fakeIndex([
      { path: 'Plan.md', modified: 1_000, size: 5, digest: digestOf('alpha'), type: null },
    ]);

    const result = await refreshIndex({ fs, index, markdown });

    expect(written).toEqual([]);
    expect(result).toMatchObject({ indexed: 0, unchanged: 1, changes: [] });
  });

  it('does not call a named note changed when its bytes are the ones held', async () => {
    const fs = fakeVault({ 'Plan.md': { text: 'alpha', modified: 1_000 } });
    const { index } = fakeIndex([
      { path: 'Plan.md', modified: 1_000, size: 5, digest: digestOf('alpha'), type: null },
    ]);

    const { changes } = await refreshIndex({ fs, index, markdown, recheck: ['Plan.md'] });

    expect(changes).toEqual([]);
  });

  it('ignores a named path that is not a note in the vault', async () => {
    const fs = fakeVault({ 'Plan.md': { text: 'alpha', modified: 1_000 } });
    const { index, written } = fakeIndex([
      { path: 'Plan.md', modified: 1_000, size: 5, digest: digestOf('alpha'), type: null },
    ]);

    await refreshIndex({ fs, index, markdown, recheck: ['Gone.md', 'Pictures/a.png'] });

    expect(written).toEqual([]);
  });

  it('on a 2,000-note vault, reads only the note named, and each note once', async () => {
    const files = Object.fromEntries(
      Array.from({ length: 2_000 }, (_, at) => [
        `Notes/n${String(at).padStart(4, '0')}.md`,
        { text: `note ${String(at).padStart(4, '0')}`, modified: 1_000 },
      ]),
    );
    const held = Object.entries(files).map(([path, file]) => ({
      path,
      modified: file.modified,
      size: file.text.length,
      digest: digestOf(file.text),
      type: null,
    }));
    const changed = 'Notes/n0042.md';
    files[changed] = { text: 'note 4200', modified: 1_000 };
    files['Notes/n0007.md'] = { text: 'note 0007, longer', modified: 1_000 };
    const fs = fakeVault(files);
    const read: string[] = [];
    const readNotes = fs.readNotes.bind(fs);
    fs.readNotes = (paths) => {
      read.push(...paths);
      return readNotes(paths);
    };
    const { index } = fakeIndex(held);

    const result = await refreshIndex({
      fs,
      index,
      markdown,
      recheck: [changed, changed, 'Notes/n0007.md'],
    });

    expect(read.sort()).toEqual(['Notes/n0007.md', changed]);
    expect(result).toMatchObject({ indexed: 2, unchanged: 1_998 });
  });
});
