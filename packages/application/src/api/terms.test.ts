/**
 * P28-05 through the local API: the vocabulary, read-only. `GET /v1/terms`
 * answers what the Terms page reads — every term, every spelling DFAI puts
 * right, and the spellings two notes disagree about — and writes nothing.
 * Terms are written as notes are (`POST /v1/notes` with `type: term`).
 */

import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import type { IndexPort } from '../index/ports.ts';
import { apiFixture, bodyOf, codeOf, OTHER_VAULT } from '../testing/api-fixture.ts';

type Props = Record<string, string | string[]>;

/** The index's `files` and `props`, holding these notes, answering `query` with SQLite. */
function sqliteIndex(notes: Record<string, { title: string; props: Props }>): Partial<IndexPort> {
  const database = new DatabaseSync(':memory:');
  database.exec(`
    CREATE TABLE files (path TEXT PRIMARY KEY, title TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '',
                        modified INTEGER, size INTEGER NOT NULL);
    CREATE TABLE props (path TEXT NOT NULL, key TEXT NOT NULL, idx INTEGER NOT NULL DEFAULT 0,
                        value_text TEXT, value_num REAL, value_date TEXT, value_json TEXT);`);
  const file = database.prepare(
    'INSERT INTO files (path, title, modified, size) VALUES (?, ?, 1, 1)',
  );
  const prop = database.prepare(
    'INSERT INTO props (path, key, idx, value_text) VALUES (?, ?, ?, ?)',
  );
  for (const [path, { title, props }] of Object.entries(notes)) {
    file.run(path, title);
    for (const [key, value] of Object.entries(props)) {
      (Array.isArray(value) ? value : [value]).forEach((item, at) => prop.run(path, key, at, item));
    }
  }
  return {
    query: async (sql, parameters) => {
      const prepared = database.prepare(sql);
      const columns = prepared.columns().map((column) => column.name);
      const rows = (prepared.all(...parameters) as Record<string, unknown>[]).map((row) =>
        columns.map((column) => row[column]),
      );
      return { columns, rows, truncated: false };
    },
  };
}

const NOTES = {
  'Terms/Larkspur.md': {
    title: 'Larkspur',
    props: { type: 'term', kind: 'company', variants: ['lark spur', 'Larks Burr'] },
  },
  'Terms/Larkspur Payroll.md': {
    title: 'Larkspur Payroll',
    props: { type: 'term', kind: 'vendor', variants: ['lark spur'] },
  },
  'People/Mara Quill.md': { title: 'Mara Quill', props: { type: 'person', aliases: 'Mara Quil' } },
  '.atlas/templates/Term.md': { title: 'Term', props: { type: 'term', variants: 'template' } },
  '.hidden/Secret.md': { title: 'Secret', props: { type: 'term' } },
  'Archive/Terms/Retired.md': { title: 'Retired', props: { type: 'term' } },
};

const get = (api: ReturnType<typeof apiFixture>) => api.send({ method: 'GET', path: '/v1/terms' });

describe('GET /v1/terms', () => {
  it('answers the terms, the vocabulary longest first, and the conflicts, as the Terms page reads them', async () => {
    const api = apiFixture({ index: sqliteIndex(NOTES) });
    const response = await get(api);

    expect(response.status).toBe(200);
    const term = (path: string) => ({ path, source: 'term' });
    expect(bodyOf(response)).toEqual({
      terms: [
        {
          path: 'Terms/Larkspur.md',
          canonical: 'Larkspur',
          variants: ['lark spur', 'Larks Burr'],
          kind: 'company',
        },
        {
          path: 'Terms/Larkspur Payroll.md',
          canonical: 'Larkspur Payroll',
          variants: ['lark spur'],
          kind: null,
        },
      ],
      vocabulary: [
        {
          form: 'Larkspur Payroll',
          canonical: 'Larkspur Payroll',
          claims: [
            {
              form: 'Larkspur Payroll',
              canonical: 'Larkspur Payroll',
              ...term('Terms/Larkspur Payroll.md'),
            },
          ],
        },
        {
          form: 'Larks Burr',
          canonical: 'Larkspur',
          claims: [{ form: 'Larks Burr', canonical: 'Larkspur', ...term('Terms/Larkspur.md') }],
        },
        {
          form: 'Mara Quill',
          canonical: 'Mara Quill',
          claims: [
            {
              form: 'Mara Quill',
              canonical: 'Mara Quill',
              path: 'People/Mara Quill.md',
              source: 'person',
            },
          ],
        },
        {
          form: 'Larkspur',
          canonical: 'Larkspur',
          claims: [{ form: 'Larkspur', canonical: 'Larkspur', ...term('Terms/Larkspur.md') }],
        },
      ],
      conflicts: [
        {
          form: 'lark spur',
          claims: [
            { form: 'lark spur', canonical: 'Larkspur', ...term('Terms/Larkspur.md') },
            {
              form: 'lark spur',
              canonical: 'Larkspur Payroll',
              ...term('Terms/Larkspur Payroll.md'),
            },
          ],
        },
      ],
    });
  });

  it('hands out a person’s name as a right spelling and never their aliases', async () => {
    const api = apiFixture({ index: sqliteIndex(NOTES) });
    const body = JSON.stringify(bodyOf(await get(api)));
    expect(body).toContain('"form":"Mara Quill"');
    expect(body).not.toContain('Mara Quil"');
  });

  it('hands out no template, no note in a hidden folder and nothing archived', async () => {
    const api = apiFixture({ index: sqliteIndex(NOTES) });
    const body = JSON.stringify(bodyOf(await get(api)));
    for (const path of [
      '.atlas/templates/Term.md',
      '.hidden/Secret.md',
      'Archive/Terms/Retired.md',
    ]) {
      expect(body).not.toContain(path);
    }
    expect(body).toContain('Terms/Larkspur.md');
  });

  it('answers an empty vocabulary for a vault with no terms, people or companies', async () => {
    const api = apiFixture({ index: sqliteIndex({}) });
    expect(bodyOf(await get(api))).toEqual({ terms: [], vocabulary: [], conflicts: [] });
  });

  it('writes nothing', async () => {
    const api = apiFixture({ index: sqliteIndex(NOTES) });
    await get(api);
    expect(api.writes).toEqual([]);
  });

  it('answers no_vault when the vault is switched while the vocabulary is read', async () => {
    const api = apiFixture({ index: sqliteIndex(NOTES) });
    const query = api.deps.index.query;
    api.deps = {
      ...api.deps,
      index: {
        ...api.deps.index,
        query: async (...args) => {
          api.open = OTHER_VAULT;
          return query(...args);
        },
      },
    };
    expect(codeOf(await get(api))).toBe('no_vault');
  });

  it('fails as internal, never answering an empty vocabulary, when the index cannot be read', async () => {
    const api = apiFixture({
      index: {
        query: async () => {
          throw new Error('index closed');
        },
      },
    });
    expect(codeOf(await get(api))).toBe('internal');
  });
});

describe('a term written through the API', () => {
  it('is a note made by POST /v1/notes with type term, as any note is', async () => {
    const api = apiFixture({ files: { 'Terms/Larkspur.md': '---\ntype: term\n---\n' } });
    const made = await api.send({
      method: 'POST',
      path: '/v1/notes',
      body: { folder: 'Terms', name: 'Quill Desk', properties: { type: 'term', kind: 'product' } },
    });
    expect(made.status).toBe(201);
    expect(api.files.get('Terms/Quill Desk.md')?.text).toBe(
      '---\ntype: term\nkind: product\n---\n',
    );
  });
});
