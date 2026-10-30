import { describe, expect, it } from 'vitest';
import {
  createVaultPath,
  parseDatasource,
  templateText,
  type Datasource,
  type HttpRequest,
  type VaultEntry,
} from '@dfai/domain';
import { refreshSource } from './refresh-source.ts';
import type { HttpPort, SqliteSourcePort } from './ports.ts';
import { fakeIndexPort } from '../testing/fake-ports.ts';
import type { IndexPort } from '../index/ports.ts';
import type { MarkdownPort } from '../notes/ports.ts';
import type { VaultFsPort } from '../vault/ports.ts';

const NOW = 1_700_000_000_000;
const VAULT = '/Users/me/Vault';

/**
 * A frontmatter block that round-trips exactly, without a YAML library.
 *
 * The refresh depends on reading back the digest and key it wrote, so a fake
 * that loses values would pass tests the real markdown port would fail. JSON is
 * the shortest thing that cannot lose one.
 */
function fakeMarkdown(): MarkdownPort {
  const read = (frontmatter: string | null): Record<string, unknown> => {
    if (frontmatter === null) return {};
    const body = frontmatter.replace(/^---\n/, '').replace(/\n---\n$/, '');
    return body.trim() === '' ? {} : (JSON.parse(body) as Record<string, unknown>);
  };

  /** A key set to null or undefined is removed, as the real port removes it. */
  const apply = (
    frontmatter: string | null,
    changes: Readonly<Record<string, unknown>>,
  ): Record<string, unknown> =>
    Object.fromEntries(
      Object.entries({ ...read(frontmatter), ...changes }).filter(
        ([, value]) => value !== null && value !== undefined,
      ),
    );

  return {
    frontmatterProperties: read,
    frontmatterProblem: () => null,
    frontmatterKeyTexts: () => ({}),
    plainText: (body) => body,
    textRanges: (body: string) => [{ start: 0, end: body.length }],
    updateFrontmatter: (frontmatter, changes) =>
      `---\n${JSON.stringify(apply(frontmatter, changes))}\n---\n`,
    parseBody: () => ({ blocks: [], doc: { type: 'doc', content: [] } }) as never,
    serializeBody: ({ originalBody }) => originalBody,
    rawParts: () => [],
    noteBlocks: () => ({ quotes: [], hidden: [] }),
    writeTree: () => '',
    addToFrontmatterMap: () => null,
  } as MarkdownPort;
}

const noteWith = (properties: Record<string, unknown>, body: string): string =>
  `---\n${JSON.stringify(properties)}\n---\n${body}`;

function fakeFs(files: Record<string, string>) {
  const written: string[] = [];
  let modified = 100;

  const fs: VaultFsPort = {
    listDirectory: async (path) => {
      const prefix = path === '' ? '' : `${path}/`;
      return Object.keys(files)
        .filter((file) => file.startsWith(prefix) && !file.slice(prefix.length).includes('/'))
        .map(
          (file) =>
            ({
              kind: 'file',
              name: file.slice(prefix.length),
              path: createVaultPath(file),
            }) as VaultEntry,
        );
    },
    listFiles: async () => [],
    listNotes: async () => [],
    readNotes: async (paths) =>
      paths.flatMap((path) =>
        files[path] === undefined
          ? []
          : [{ path, text: files[path], modified: 100, size: files[path].length }],
      ),
    readBinaryFile: async () => new ArrayBuffer(0),
    readTextFile: async (path) => {
      const text = files[path];
      if (text === undefined) throw new Error(`no such file: ${path}`);
      return { text, modified: 100 };
    },
    createNote: async ({ path, contents }) => {
      if (files[path] !== undefined) throw new Error('a note with that name already exists');
      files[path] = contents;
      written.push(path);
      return 0;
    },
    createFolder: async () => {},
    moveEntry: async () => {},
    trashEntry: async () => {},
    writeBinaryFile: async () => 0,
    writeTextFile: async ({ path, contents, expectedModified }) => {
      if (files[path] === undefined) throw new Error(`no such file: ${path}`);
      if (expectedModified !== null && expectedModified !== 100) {
        throw new Error('the note changed on disk since it was opened');
      }
      files[path] = contents;
      written.push(path);
      modified += 1;
      return modified;
    },
  };

  return { fs, files, written };
}

const csvSource = (extra: Record<string, unknown> = {}): Datasource => {
  const source = parseDatasource({
    atlas: 'source',
    format: 'csv',
    file: 'feeds/people.csv',
    into: 'People',
    type: 'person',
    key: 'id',
    name: 'name',
    body: 'note',
    map: { role: 'role' },
    ...extra,
  });
  if (source === null) throw new Error('the test asked for a source that does not parse');
  return source;
};

const PEOPLE = 'id,name,role,note\n1,Ada,engineer,Writes the notes\n2,Grace,admiral,Compiles\n';

const NO_SQLITE: SqliteSourcePort = {
  query: () => Promise.reject(new Error('this test reads no SQLite file')),
  pick: async () => null,
};

const refresh = ({
  fs,
  index = fakeIndexPort(),
  http = { get: async () => '' },
  sqlite = NO_SQLITE,
  source = csvSource(),
}: {
  fs: VaultFsPort;
  index?: IndexPort;
  http?: HttpPort;
  sqlite?: SqliteSourcePort;
  source?: Datasource;
}) =>
  refreshSource({
    fs,
    markdown: fakeMarkdown(),
    index,
    http,
    sqlite,
    sourcePath: '.atlas/sources/People.md',
    source,
    vault: VAULT,
    now: NOW,
  });

describe('refreshSource', () => {
  it('writes a note per record, keyed by the field the source names', async () => {
    const vault = fakeFs({ 'feeds/people.csv': PEOPLE });

    const report = await refresh({ fs: vault.fs });

    expect(report.error).toBeNull();
    expect(report.created).toBe(2);
    expect(Object.keys(vault.files)).toContain('People/1.md');
    expect(Object.keys(vault.files)).toContain('People/2.md');
  });

  it('writes the mapped fields, the type and where the note came from', async () => {
    const vault = fakeFs({ 'feeds/people.csv': PEOPLE });

    await refresh({ fs: vault.fs });

    const note = vault.files['People/1.md'] ?? '';
    expect(JSON.parse(note.split('---\n')[1] ?? '{}')).toMatchObject({
      type: 'person',
      title: 'Ada',
      role: 'engineer',
      atlas_source: '.atlas/sources/People.md',
      atlas_source_key: '1',
    });
  });

  it('writes the record body with nothing added, so the digest still matches it', async () => {
    const vault = fakeFs({ 'feeds/people.csv': PEOPLE });

    await refresh({ fs: vault.fs });
    // A second refresh of unchanged text: the note is DFAI's to replace, which
    // it can only know if the body it wrote hashes to the digest beside it.
    const second = await refresh({ fs: vault.fs });

    expect(second.created).toBe(0);
    expect(second.replaced).toBe(2);
    expect(second.updated).toBe(0);
  });

  it('refreshes a note whose record changed', async () => {
    const vault = fakeFs({ 'feeds/people.csv': PEOPLE });
    await refresh({ fs: vault.fs });

    vault.files['feeds/people.csv'] = 'id,name,role,note\n1,Ada,director,Runs the place\n';
    const report = await refresh({ fs: vault.fs });

    expect(report.replaced).toBe(1);
    expect(vault.files['People/1.md']).toContain('Runs the place');
    expect(vault.files['People/1.md']).toContain('"role":"director"');
  });

  it('keeps a body you have edited and refreshes only the properties', async () => {
    const vault = fakeFs({ 'feeds/people.csv': PEOPLE });
    await refresh({ fs: vault.fs });

    const mine = (vault.files['People/1.md'] ?? '').replace(
      'Writes the notes',
      'My own notes about Ada',
    );
    vault.files['People/1.md'] = mine;

    vault.files['feeds/people.csv'] = 'id,name,role,note\n1,Ada,director,Writes the notes\n';
    const report = await refresh({ fs: vault.fs });

    expect(report.updated).toBe(1);
    expect(report.replaced).toBe(0);
    expect(vault.files['People/1.md']).toContain('My own notes about Ada');
    expect(vault.files['People/1.md']).toContain('"role":"director"');
  });

  it('marks a note whose record has gone rather than deleting it', async () => {
    const vault = fakeFs({ 'feeds/people.csv': PEOPLE });
    await refresh({ fs: vault.fs });

    vault.files['feeds/people.csv'] = 'id,name,role,note\n1,Ada,engineer,Writes the notes\n';
    const report = await refresh({ fs: vault.fs });

    expect(report.missing).toBe(1);
    expect(vault.files['People/2.md']).toContain('"atlas_source_missing":true');
  });

  it('marks a missing note once rather than rewriting it on every refresh', async () => {
    const vault = fakeFs({ 'feeds/people.csv': PEOPLE });
    await refresh({ fs: vault.fs });
    vault.files['feeds/people.csv'] = 'id,name,role,note\n1,Ada,engineer,Writes the notes\n';
    await refresh({ fs: vault.fs });

    const before = vault.written.length;
    const report = await refresh({ fs: vault.fs });

    expect(report.missing).toBe(1);
    expect(vault.written.slice(before)).not.toContain('People/2.md');
  });

  it('takes the mark off again when the record comes back', async () => {
    const vault = fakeFs({ 'feeds/people.csv': PEOPLE });
    await refresh({ fs: vault.fs });
    vault.files['feeds/people.csv'] = 'id,name,role,note\n1,Ada,engineer,Writes the notes\n';
    await refresh({ fs: vault.fs });
    expect(vault.files['People/2.md']).toContain('atlas_source_missing');

    vault.files['feeds/people.csv'] = PEOPLE;
    const report = await refresh({ fs: vault.fs });

    expect(report.missing).toBe(0);
    expect(vault.files['People/2.md']).not.toContain('atlas_source_missing');
    expect(vault.files['People/2.md']).toContain('"title":"Grace"');
  });

  it('leaves notes produced by another source alone', async () => {
    const vault = fakeFs({
      'feeds/people.csv': PEOPLE,
      'People/elsewhere.md': noteWith(
        { type: 'person', atlas_source: '.atlas/sources/Other.md', atlas_source_key: '1' },
        'Not ours.',
      ),
    });

    const report = await refresh({ fs: vault.fs });

    expect(report.missing).toBe(0);
    expect(vault.files['People/elsewhere.md']).toContain('Not ours.');
  });

  it('finds a note it produced that you have moved out of the folder', async () => {
    const vault = fakeFs({ 'feeds/people.csv': PEOPLE });
    await refresh({ fs: vault.fs });

    const moved = vault.files['People/1.md'] ?? '';
    delete vault.files['People/1.md'];
    vault.files['Archive/Ada.md'] = moved;

    const index = fakeIndexPort({
      notesOfType: async () => [{ path: 'Archive/Ada.md', title: 'Ada' }],
    });
    const report = await refresh({ fs: vault.fs, index });

    expect(report.created).toBe(0);
    expect(report.missing).toBe(0);
    expect(vault.written).toContain('Archive/Ada.md');
    expect(vault.files['People/1.md']).toBeUndefined();
  });

  it('counts the records it could not follow because they have no key', async () => {
    const vault = fakeFs({ 'feeds/people.csv': 'id,name\n,Nobody\n3,Alan\n' });

    const report = await refresh({ fs: vault.fs });

    expect(report.unkeyed).toBe(1);
    expect(report.created).toBe(1);
  });

  it('fetches over HTTP when the source names a URL', async () => {
    const vault = fakeFs({});
    const asked: string[] = [];
    const http: HttpPort = {
      get: async ({ request }) => {
        asked.push(templateText(request.url));
        return PEOPLE;
      },
    };

    const report = await refresh({
      fs: vault.fs,
      http,
      source: csvSource({ file: null, url: 'https://example.test/people.csv' }),
    });

    expect(asked).toEqual(['https://example.test/people.csv']);
    expect(report.created).toBe(2);
    expect(report.from).toBe('https://example.test/people.csv');
  });

  it('names the vault it ran in, whose secrets the host fills in and no other', async () => {
    const vaults: string[] = [];
    const http: HttpPort = {
      get: async ({ vault }) => {
        vaults.push(vault);
        return PEOPLE;
      },
    };

    await refresh({
      fs: fakeFs({}).fs,
      http,
      source: csvSource({ file: null, url: 'https://example.test/people.csv' }),
    });

    expect(vaults).toEqual([VAULT]);
  });

  it('reports a feed that answered with an error instead of throwing', async () => {
    const vault = fakeFs({});
    const http: HttpPort = {
      get: async () => {
        throw new Error('the feed answered 404');
      },
    };

    const report = await refresh({
      fs: vault.fs,
      http,
      source: csvSource({ file: null, url: 'https://example.test/gone.csv' }),
    });

    expect(report.error).toBe('the feed answered 404');
    expect(report.created).toBe(0);
    expect(report.ran).toBe(NOW);
  });

  it('reports a vault file that is not there', async () => {
    const vault = fakeFs({});

    const report = await refresh({ fs: vault.fs });

    expect(report.error).toContain('no such file');
    expect(vault.written).toEqual([]);
  });

  it('reports text that will not parse, and writes nothing', async () => {
    const vault = fakeFs({ 'feeds/people.json': 'not json at all' });

    const report = await refresh({
      fs: vault.fs,
      source: csvSource({ format: 'json', file: 'feeds/people.json' }),
    });

    expect(report.error).toContain('this is not JSON');
    expect(vault.written).toEqual([]);
  });

  it('reports a write that was refused, and keeps the count of what landed', async () => {
    const vault = fakeFs({ 'feeds/people.csv': PEOPLE });
    let allowed = 1;
    const fs: VaultFsPort = {
      ...vault.fs,
      createNote: async (args) => {
        if (allowed <= 0) throw new Error('the disk is full');
        allowed -= 1;
        await vault.fs.createNote(args);
        return 0;
      },
    };

    const report = await refresh({ fs });

    expect(report.created).toBe(1);
    expect(report.error).toBe('the disk is full');
  });

  it('reads JSON under the pointer the source names', async () => {
    const vault = fakeFs({
      'feeds/people.json': JSON.stringify({ data: { items: [{ id: '7', name: 'Katherine' }] } }),
    });

    const report = await refresh({
      fs: vault.fs,
      source: csvSource({ format: 'json', file: 'feeds/people.json', pointer: 'data.items' }),
    });

    expect(report.created).toBe(1);
    expect(vault.files['People/7.md']).toContain('Katherine');
  });

  it('reads a calendar as its events', async () => {
    const vault = fakeFs({
      'feeds/team.ics': [
        'BEGIN:VCALENDAR',
        'BEGIN:VEVENT',
        'UID:standup-1',
        'SUMMARY:Standup',
        'DTSTART:20260921T090000Z',
        'END:VEVENT',
        'END:VCALENDAR',
        '',
      ].join('\r\n'),
    });

    const report = await refresh({
      fs: vault.fs,
      source: csvSource({
        format: 'ics',
        file: 'feeds/team.ics',
        into: 'Calendar',
        type: 'event',
        key: null,
        name: null,
        body: null,
        map: { dtstart: 'date' },
      }),
    });

    expect(report.created).toBe(1);
    expect(vault.files['Calendar/standup-1.md']).toContain('"date":"2026-09-21"');
    expect(vault.files['Calendar/standup-1.md']).toContain('"title":"Standup"');
  });

  it('reports a refusal that arrived as something other than an Error', async () => {
    const vault = fakeFs({});
    const http: HttpPort = { get: () => Promise.reject('the host said no') };

    const report = await refresh({
      fs: vault.fs,
      http,
      source: csvSource({ file: null, url: 'https://example.test/people.csv' }),
    });

    expect(report.error).toBe('the host said no');
  });

  it('looks past whatever else is sitting in the folder', async () => {
    const vault = fakeFs({
      'feeds/people.csv': PEOPLE,
      'People/notes.txt': 'not a note',
      'People/Sub/deeper.md': noteWith({ atlas_source: '.atlas/sources/People.md' }, 'Nested.'),
    });

    const report = await refresh({ fs: vault.fs });

    expect(report.error).toBeNull();
    expect(report.created).toBe(2);
  });

  it('treats a note that says it came from here but names no record as gone', async () => {
    const vault = fakeFs({
      'feeds/people.csv': PEOPLE,
      'People/stray.md': noteWith(
        { type: 'person', atlas_source: '.atlas/sources/People.md' },
        'Mine.',
      ),
    });

    const report = await refresh({ fs: vault.fs });

    expect(report.created).toBe(2);
    expect(report.missing).toBe(1);
    expect(vault.files['People/stray.md']).toContain('Mine.');
  });

  it('says where it read from and when it ran', async () => {
    const vault = fakeFs({ 'feeds/people.csv': PEOPLE });

    const report = await refresh({ fs: vault.fs });

    expect(report.from).toBe('feeds/people.csv');
    expect(report.ran).toBe(NOW);
    expect(report.records).toBe(2);
    expect(report.truncated).toBe(false);
  });

  it('sends secrets as names for the host to fill in, never as values', async () => {
    const vault = fakeFs({});
    const asked: HttpRequest[] = [];
    const http: HttpPort = {
      get: async ({ request }) => {
        asked.push(request);
        return PEOPLE;
      },
    };

    const report = await refresh({
      fs: vault.fs,
      http,
      source: csvSource({
        file: null,
        url: 'https://example.test/{{secret:feed}}/people.csv',
        auth: { secret: 'github' },
      }),
    });

    expect(report.created).toBe(2);
    expect(asked).toEqual([
      {
        url: [{ text: 'https://example.test/' }, { secret: 'feed' }, { text: '/people.csv' }],
        headers: [{ name: 'Authorization', value: [{ text: 'Bearer ' }, { secret: 'github' }] }],
      },
    ]);
    // What the panel says it read from is the reference, as the note has it.
    expect(report.from).toBe('https://example.test/{{secret:feed}}/people.csv');
  });
});

describe('refreshSource, SQLite', () => {
  const sqliteSource = (extra: Record<string, unknown> = {}) =>
    csvSource({
      format: 'sqlite',
      file: 'data/team.db',
      query: 'SELECT id, name, role, note FROM people',
      ...extra,
    });

  it('runs the query and writes a note per row', async () => {
    const vault = fakeFs({});
    const asked: { file: string; sql: string }[] = [];
    const sqlite: SqliteSourcePort = {
      query: async (args) => {
        asked.push(args);
        return {
          columns: ['id', 'name', 'role', 'note'],
          rows: [
            [1, 'Ada', 'engineer', 'Writes the notes'],
            [2, 'Grace', null, 'Compiles'],
          ],
          truncated: false,
        };
      },
      pick: async () => null,
    };

    const report = await refresh({ fs: vault.fs, sqlite, source: sqliteSource() });

    expect(asked).toEqual([
      { file: 'data/team.db', sql: 'SELECT id, name, role, note FROM people' },
    ]);
    expect(report.error).toBeNull();
    expect(report.created).toBe(2);
    expect(report.from).toBe('data/team.db');
    expect(vault.files['People/1.md']).toContain('"role":"engineer"');
    expect(vault.files['People/2.md']).not.toContain('"role"');
  });

  it('says so when the host stopped reading the rows short', async () => {
    const vault = fakeFs({});
    const sqlite: SqliteSourcePort = {
      query: async () => ({ columns: ['id', 'name'], rows: [[1, 'Ada']], truncated: true }),
      pick: async () => null,
    };

    const report = await refresh({ fs: vault.fs, sqlite, source: sqliteSource() });

    expect(report.truncated).toBe(true);
  });

  it('reports a file the host refused to open', async () => {
    const vault = fakeFs({});
    const sqlite: SqliteSourcePort = {
      query: () => Promise.reject(new Error('this database has changes waiting in its WAL')),
      pick: async () => null,
    };

    const report = await refresh({ fs: vault.fs, sqlite, source: sqliteSource() });

    expect(report.error).toMatch(/WAL/);
    expect(report.created).toBe(0);
  });
});
