import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { createVaultPath, resolveWikiLinkTarget, type VaultPath } from '@dfai/domain';
import { deleteEntry } from '../vault/delete-entry.ts';
import { renameEntry } from '../vault/relocate-entry.ts';
import type { OpenEditorsPort, VaultFsPort } from '../vault/ports.ts';
import { fakeIndexPort } from '../testing/fake-ports.ts';
import type { MarkdownPort } from '../notes/ports.ts';
import type { IndexedNote, IndexPort } from './ports.ts';
import { refreshIndex } from './refresh-index.ts';

/**
 * Adversarial (ADR-0019): "a relation is re-resolved when a note it could name
 * is made or goes away". Deleting a note in the app takes it out of the index
 * at once (delete-entry.ts), before the refresh that follows every change —
 * so the refresh never sees it go.
 */

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
    Object.fromEntries(
      (frontmatter ?? '')
        .split('\n')
        .map((line) => /^(\w+):\s*(.*)$/.exec(line))
        .filter((match): match is RegExpExecArray => match !== null)
        .map((match) => [match[1] as string, match[2] as string]),
    ),
  plainText: (body) => body.trim(),
  textRanges: (body: string) => [{ start: 0, end: body.length }],
  updateFrontmatter: () => '',
};

function memoryVault(files: Map<string, string>): VaultFsPort {
  const entries = () =>
    [...files].map(([path, text]) => ({
      name: path.split('/').at(-1) ?? path,
      path: createVaultPath(path),
      modified: 1,
      size: text.length,
    }));
  return {
    listDirectory: async () => [],
    listFiles: async () => [],
    listNotes: async () => entries(),
    readNotes: async (paths) =>
      paths.flatMap((path) => {
        const text = files.get(path);
        return text === undefined ? [] : [{ path, text, modified: 1, size: text.length }];
      }),
    readBinaryFile: async () => new ArrayBuffer(0),
    createNote: async () => 0,
    createFolder: async () => {},
    moveEntry: async ({ from, to }) => {
      const text = files.get(from);
      if (text === undefined) return;
      files.delete(from);
      files.set(to, text);
    },
    trashEntry: async ({ path }) => {
      files.delete(path);
    },
    writeBinaryFile: async () => 0,
    readTextFile: async (path) => ({ text: files.get(path) ?? '', modified: 1 }),
    writeTextFile: async () => 0,
  };
}

/** An index that keeps its manifest and its relations table the way the host does. */
function sqliteIndex(): IndexPort & { relationOf: (src: string) => string | null } {
  const database = new DatabaseSync(':memory:');
  database.exec(
    'CREATE TABLE relations (src TEXT NOT NULL, key TEXT NOT NULL, idx INTEGER NOT NULL, target TEXT NOT NULL, name TEXT NOT NULL, dst TEXT)',
  );
  // Asked with the relations which body links name a note gone (#431); these notes are put without any.
  database.exec(
    'CREATE TABLE links (src TEXT NOT NULL, dst TEXT, target TEXT NOT NULL, kind TEXT NOT NULL, leaf TEXT NOT NULL)',
  );
  // Asked how the meeting import settled each note held (#92); these notes hold no stamp.
  database.exec(
    'CREATE TABLE props (path TEXT NOT NULL, key TEXT NOT NULL, idx INTEGER NOT NULL, value_text TEXT)',
  );
  const manifest = new Map<string, number>();
  return {
    ...fakeIndexPort(),
    manifest: async () =>
      [...manifest].map(([path, size]) => ({ path, modified: 1, size, digest: '', type: null })),
    put: async (notes: readonly IndexedNote[]) => {
      for (const note of notes) {
        manifest.set(note.path, note.size);
        database.prepare('DELETE FROM relations WHERE src = ?').run(note.path);
        for (const row of note.relations) {
          database
            .prepare('INSERT INTO relations VALUES (?, ?, ?, ?, ?, ?)')
            .run(note.path, row.key, row.index, row.target, row.name, row.path);
        }
      }
    },
    remove: async (paths) => {
      for (const path of paths) {
        manifest.delete(path);
        database.prepare('DELETE FROM relations WHERE src = ?').run(path);
      }
    },
    query: async (sql, parameters) => {
      const rows = database.prepare(sql).all(...(parameters as string[])) as Record<
        string,
        unknown
      >[];
      return { columns: ['path'], rows: rows.map((row) => [row['path']]), truncated: false };
    },
    relationOf: (src) =>
      (
        database.prepare('SELECT dst FROM relations WHERE src = ?').get(src) as {
          dst: string | null;
        }
      ).dst,
  };
}

const editors: OpenEditorsPort = {
  state: () => 'closed',
  flush: async () => {},
  follow: () => {},
  abandon: () => {},
};

describe('relations after a note is deleted in the app (adversarial)', () => {
  it('re-resolves a relation to the note of the same name that is left', async () => {
    const both = ['projects/DFAI.md', 'work/DFAI.md'].map(createVaultPath);
    const first = resolveWikiLinkTarget('DFAI', both) as VaultPath;
    const other = both.find((path) => path !== first) as VaultPath;
    const files = new Map([
      ['tasks/Write.md', '---\nproject: [[DFAI]]\n---\nbody'],
      [first as string, 'one'],
      [other as string, 'two'],
    ]);
    const fs = memoryVault(files);
    const index = sqliteIndex();

    await refreshIndex({ fs, index, markdown });
    expect(index.relationOf('tasks/Write.md')).toBe(first);

    await deleteEntry({
      fs,
      index,
      editors,
      entry: { path: first, kind: 'file' },
      notePaths: [...files.keys()].map(createVaultPath),
    });
    await refreshIndex({ fs, index, markdown });

    // Why: delete-entry.ts removes the note from the index itself, so the refresh
    // finds nothing removed, never asks which relations named "atlas", and
    // Write.md keeps pointing at a note that is gone — "project = [[DFAI]]"
    // (resolved now to the other DFAI) no longer finds it, and project.status is empty.
    expect(index.relationOf('tasks/Write.md')).toBe(other);
  });

  it('re-resolves a relation to the note of the same name that is left after a rename', async () => {
    // Why: renaming moves the note and takes its old path out of the index at
    // once (relocate-entry.ts), so, as with a delete, the refresh never sees the
    // old name go and never asks which relations named it.
    const both = ['projects/DFAI.md', 'work/DFAI.md'].map(createVaultPath);
    const first = resolveWikiLinkTarget('DFAI', both) as VaultPath;
    const other = both.find((path) => path !== first) as VaultPath;
    const files = new Map([
      ['tasks/Write.md', '---\nproject: [[DFAI]]\n---\nbody'],
      [first as string, 'one'],
      [other as string, 'two'],
    ]);
    const fs = memoryVault(files);
    const index = sqliteIndex();

    await refreshIndex({ fs, index, markdown });
    expect(index.relationOf('tasks/Write.md')).toBe(first);

    await renameEntry({
      ports: { fs, index, editors },
      entry: { path: first, kind: 'file' },
      name: 'Retired',
      notePaths: [...files.keys()].map(createVaultPath),
    });
    await refreshIndex({ fs, index, markdown });

    expect(index.relationOf('tasks/Write.md')).toBe(other);
  });
});
