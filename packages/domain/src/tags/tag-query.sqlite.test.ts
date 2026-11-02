import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  compileTagCountsQuery,
  compileTaggedNotesQuery,
  compileTagUsesQuery,
  TAG_PAGE_SIZE,
} from './tag-query.ts';

/** The index's tables, as `apps/desktop/src-tauri/src/index.rs` creates them. */
function index() {
  const database = new DatabaseSync(':memory:');
  database.exec(`
    CREATE TABLE files (path TEXT PRIMARY KEY, title TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '',
                        modified INTEGER, size INTEGER NOT NULL);
    CREATE TABLE tags (path TEXT NOT NULL, idx INTEGER NOT NULL, tag TEXT NOT NULL,
                       name TEXT NOT NULL);`);
  const file = database.prepare(
    'INSERT INTO files (path, title, modified, size) VALUES (?, ?, 1, 1)',
  );
  const tag = database.prepare('INSERT INTO tags VALUES (?, ?, ?, ?)');
  return { database, file, tag };
}

describe('the tag queries, run against the index’s tables', () => {
  it('counts every use of each tag, shown as its first use by path then place', () => {
    const { database, tag } = index();
    tag.run('b.md', 0, 'idea', 'IDEA');
    tag.run('a.md', 1, 'idea', 'idea');
    tag.run('a.md', 0, 'idea', 'Idea');
    tag.run('a.md', 2, 'para/x', 'para/x');
    const { sql, parameters } = compileTagCountsQuery(0);
    expect(database.prepare(sql).all(...parameters)).toEqual([
      { key: 'idea', name: 'Idea', count: 3 },
      { key: 'para/x', name: 'para/x', count: 1 },
    ]);
  });

  it('counts each tag’s uses note by note, shown as its first use in that note', () => {
    const { database, tag } = index();
    tag.run('b.md', 0, 'idea', 'IDEA');
    tag.run('a.md', 1, 'idea', 'idea');
    tag.run('a.md', 0, 'idea', 'Idea');
    tag.run('a.md', 2, 'para/x', 'para/x');
    const { sql, parameters } = compileTagUsesQuery(0);
    expect(database.prepare(sql).all(...parameters)).toEqual([
      { path: 'a.md', key: 'idea', name: 'Idea', count: 2 },
      { path: 'a.md', key: 'para/x', name: 'para/x', count: 1 },
      { path: 'b.md', key: 'idea', name: 'IDEA', count: 1 },
    ]);
    expect(compileTagUsesQuery(2).parameters).toEqual([TAG_PAGE_SIZE, 2 * TAG_PAGE_SIZE]);
  });

  it('pages the counts', () => {
    const { parameters } = compileTagCountsQuery(2);
    expect(parameters).toEqual([TAG_PAGE_SIZE, 2 * TAG_PAGE_SIZE]);
  });

  it('leaves archived notes out of the notes using a tag, unless asked (A20-05)', () => {
    const { database, file, tag } = index();
    file.run('Live.md', 'Live');
    file.run('Archive/Old.md', 'Old');
    tag.run('Live.md', 0, 'idea', 'idea');
    tag.run('Archive/Old.md', 0, 'idea', 'idea');
    const paths = (includeArchived?: boolean) => {
      const { sql, parameters } = compileTaggedNotesQuery('idea', 0, {
        ...(includeArchived !== undefined && { includeArchived }),
      });
      return database
        .prepare(sql)
        .all(...parameters)
        .map((row) => row['path']);
    };
    expect(paths()).toEqual(['Live.md']);
    expect(paths(true)).toEqual(['Live.md', 'Archive/Old.md']);
  });

  it('counts archived uses only when asked, and names a tag by its first live use (A20-05)', () => {
    const { database, file, tag } = index();
    file.run('Archive/A.md', 'A');
    file.run('Live.md', 'Live');
    tag.run('Archive/A.md', 0, 'idea', 'IDEA');
    tag.run('Live.md', 0, 'idea', 'Idea');
    const counts = (includeArchived: boolean) => {
      const { sql, parameters } = compileTagCountsQuery(0, { includeArchived });
      return database.prepare(sql).all(...parameters);
    };
    expect(counts(false)).toEqual([{ key: 'idea', name: 'Idea', count: 1 }]);
    expect(counts(true)).toEqual([{ key: 'idea', name: 'IDEA', count: 2 }]);
  });

  it('leaves archived notes out of each note’s tag uses, unless asked', () => {
    const { database, file, tag } = index();
    file.run('Archive/A.md', 'A');
    file.run('Live.md', 'Live');
    tag.run('Archive/A.md', 0, 'idea', 'IDEA');
    tag.run('Live.md', 0, 'idea', 'Idea');
    const paths = (includeArchived: boolean) => {
      const { sql, parameters } = compileTagUsesQuery(0, { includeArchived });
      return database
        .prepare(sql)
        .all(...parameters)
        .map((row) => row['path']);
    };
    expect(paths(false)).toEqual(['Live.md']);
    expect(paths(true)).toEqual(['Archive/A.md', 'Live.md']);
  });

  it('lists the notes using a tag or one nested under it, by title, with their uses', () => {
    const { database, file, tag } = index();
    file.run('a.md', 'Beta');
    file.run('b.md', 'alpha');
    file.run('c.md', 'Gamma');
    file.run('d.md', 'Delta');
    tag.run('a.md', 0, 'para', 'para');
    tag.run('a.md', 1, 'para', 'para');
    tag.run('b.md', 0, 'para/resource', 'para/resource');
    tag.run('c.md', 0, 'paragraph', 'paragraph');
    tag.run('d.md', 0, 'other', 'other');
    const { sql, parameters } = compileTaggedNotesQuery('para', 0);
    expect(database.prepare(sql).all(...parameters)).toEqual([
      { path: 'b.md', title: 'alpha', count: 1 },
      { path: 'a.md', title: 'Beta', count: 2 },
    ]);
  });

  it('pages the notes using a tag, each page starting where the last one ended', () => {
    const { database, file, tag } = index();
    const total = TAG_PAGE_SIZE + 2;
    for (let at = 0; at < total; at += 1) {
      const path = `n${String(at).padStart(5, '0')}.md`;
      file.run(path, path);
      tag.run(path, 0, 'idea', 'idea');
    }
    const page = (number: number) => {
      const { sql, parameters } = compileTaggedNotesQuery('idea', number);
      return database.prepare(sql).all(...parameters) as { path: string }[];
    };
    expect(page(0)).toHaveLength(TAG_PAGE_SIZE);
    expect(page(1).map((row) => row.path)).toEqual(['n05000.md', 'n05001.md']);
  });

  it('matches a nested tag whose name is not plain ASCII by its whole parent', () => {
    const { database, file, tag } = index();
    file.run('a.md', 'A');
    file.run('b.md', 'B');
    tag.run('a.md', 0, '日本/東京', '日本/東京');
    tag.run('b.md', 0, '日本語', '日本語');
    const { sql, parameters } = compileTaggedNotesQuery('日本', 0);
    expect(database.prepare(sql).all(...parameters)).toEqual([
      { path: 'a.md', title: 'A', count: 1 },
    ]);
  });

  it('binds the tag rather than writing it into the statement', () => {
    const { sql, parameters } = compileTaggedNotesQuery("x' OR 1=1 --", 0);
    expect(sql).not.toContain('OR 1=1');
    expect(parameters[0]).toBe("x' OR 1=1 --");
  });
});
