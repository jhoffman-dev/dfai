import { describe, expect, it } from 'vitest';
import { createVaultPath } from '@dfai/domain';
import type { MarkdownPort } from '../notes/ports.ts';
import { sqliteIndexPort } from '../testing/sqlite-index.ts';
import { deleteEntry } from '../vault/delete-entry.ts';
import type { OpenEditorsPort, VaultFsPort } from '../vault/ports.ts';
import { renameEntry } from '../vault/relocate-entry.ts';
import type { IndexedNote, IndexPort } from './ports.ts';
import { refreshIndex } from './refresh-index.ts';

/**
 * A body link is resolved when its note is read (#431). A refresh with a
 * manifest reads again only what changed, so a note that comes or goes must
 * send it back to the notes whose body links could name it — or "No links
 * yet" shows on a note that is linked, until the index is rebuilt.
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
  frontmatterProperties: () => ({}),
  plainText: (body) => body.trim(),
  textRanges: (body: string) => [{ start: 0, end: body.length }],
  updateFrontmatter: () => '',
};

function memoryVault(files: Map<string, string>): VaultFsPort {
  return {
    listDirectory: async () => [],
    listFiles: async () => [],
    listNotes: async () =>
      [...files].map(([path, text]) => ({
        name: path.split('/').at(-1) ?? path,
        path: createVaultPath(path),
        modified: 1,
        size: text.length,
      })),
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

const editors: OpenEditorsPort = {
  state: () => 'closed',
  flush: async () => {},
  follow: () => {},
  abandon: () => {},
};

/** The real-SQLite stand-in, recording which notes each refresh read again. */
function recordingIndex(): IndexPort & { written: string[] } {
  const index = sqliteIndexPort();
  const written: string[] = [];
  return {
    ...index,
    written,
    put: async (notes: readonly IndexedNote[]) => {
      written.push(...notes.map((note) => note.path));
      await index.put(notes);
    },
  };
}

/** Where each of a note's body links points, as the index holds it. */
async function linksFrom(index: IndexPort, src: string): Promise<(string | null)[]> {
  const result = await index.query('SELECT dst FROM links WHERE src = ? ORDER BY rowid', [src]);
  return result.rows.map((row) => (row[0] === null ? null : String(row[0])));
}

async function vaultWith(entries: Record<string, string>) {
  const files = new Map(Object.entries(entries));
  const fs = memoryVault(files);
  const index = recordingIndex();
  await refreshIndex({ fs, index, markdown });
  index.written.length = 0;
  return { files, fs, index };
}

describe('body links to notes that come and go (#431)', () => {
  it('resolves a body link once the note it names is made', async () => {
    const { files, fs, index } = await vaultWith({
      'Deal.md': 'Signed with [[Larkspur Payroll]].',
    });
    expect(await linksFrom(index, 'Deal.md')).toEqual([null]);

    files.set('Larkspur Payroll.md', 'A payroll firm.');
    await refreshIndex({ fs, index, markdown });

    expect(await linksFrom(index, 'Deal.md')).toEqual(['Larkspur Payroll.md']);
  });

  it('resolves links written with display text, a path, or another case', async () => {
    const { files, fs, index } = await vaultWith({
      'Deal.md': '[[Larkspur Payroll|the payroll firm]] and [[clients/Larkspur Payroll]]',
      'Ærø.md': 'Ferry to [[ærø harbour]].',
    });

    files.set('clients/Larkspur Payroll.md', 'A payroll firm.');
    files.set('Ærø Harbour.md', 'A harbour.');
    await refreshIndex({ fs, index, markdown });

    expect(await linksFrom(index, 'Deal.md')).toEqual([
      'clients/Larkspur Payroll.md',
      'clients/Larkspur Payroll.md',
    ]);
    expect(await linksFrom(index, 'Ærø.md')).toEqual(['Ærø Harbour.md']);
  });

  it('reads again only the notes whose links name the note made', async () => {
    const { files, fs, index } = await vaultWith({
      'Deal.md': 'Signed with [[Larkspur Payroll]].',
      'Other.md': 'Nothing to do with it: [[Somewhere Else]].',
      'Plain.md': 'No links at all.',
    });

    files.set('Larkspur Payroll.md', 'A payroll firm.');
    await refreshIndex({ fs, index, markdown });

    expect(index.written.sort()).toEqual(['Deal.md', 'Larkspur Payroll.md']);
  });

  it('resolves a link once a note is renamed in the app to the name it gives', async () => {
    const { files, fs, index } = await vaultWith({
      'Deal.md': 'Signed with [[Larkspur Payroll]].',
      'Draft.md': 'A payroll firm.',
    });

    await renameEntry({
      ports: { fs, index, editors },
      entry: { path: createVaultPath('Draft.md'), kind: 'file' },
      name: 'Larkspur Payroll',
      notePaths: [...files.keys()].map(createVaultPath),
    });
    await refreshIndex({ fs, index, markdown });

    expect(await linksFrom(index, 'Deal.md')).toEqual(['Larkspur Payroll.md']);
  });

  it('leaves a link pointing nowhere once its note is deleted in the app', async () => {
    const { files, fs, index } = await vaultWith({
      'Deal.md': 'Signed with [[Larkspur Payroll]].',
      'Larkspur Payroll.md': 'A payroll firm.',
    });
    expect(await linksFrom(index, 'Deal.md')).toEqual(['Larkspur Payroll.md']);

    await deleteEntry({
      fs,
      index,
      editors,
      entry: { path: createVaultPath('Larkspur Payroll.md'), kind: 'file' },
      notePaths: [...files.keys()].map(createVaultPath),
    });
    await refreshIndex({ fs, index, markdown });

    expect(await linksFrom(index, 'Deal.md')).toEqual([null]);
  });

  it('leaves a link pointing nowhere once its note is deleted outside the app', async () => {
    const { files, fs, index } = await vaultWith({
      'Deal.md': 'Signed with [[Larkspur Payroll]].',
      'Larkspur Payroll.md': 'A payroll firm.',
    });

    files.delete('Larkspur Payroll.md');
    await refreshIndex({ fs, index, markdown });

    expect(await linksFrom(index, 'Deal.md')).toEqual([null]);
  });

  it('moves a link to the note of the same name a new note outranks', async () => {
    const { files, fs, index } = await vaultWith({
      'Deal.md': 'Signed with [[Larkspur Payroll]].',
      'Archive/Larkspur Payroll.md': 'The old firm.',
    });
    expect(await linksFrom(index, 'Deal.md')).toEqual(['Archive/Larkspur Payroll.md']);

    files.set('Larkspur Payroll.md', 'The firm now.');
    await refreshIndex({ fs, index, markdown });

    expect(await linksFrom(index, 'Deal.md')).toEqual(['Larkspur Payroll.md']);
  });
});
