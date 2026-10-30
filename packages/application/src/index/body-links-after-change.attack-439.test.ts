import { describe, expect, it } from 'vitest';
import { createVaultPath, LINK_NAMES_PER_QUERY } from '@dfai/domain';
import type { MarkdownPort } from '../notes/ports.ts';
import { sqliteIndexPort } from '../testing/sqlite-index.ts';
import { deleteEntry } from '../vault/delete-entry.ts';
import type { OpenEditorsPort, VaultFsPort } from '../vault/ports.ts';
import { renameEntry } from '../vault/relocate-entry.ts';
import type { IndexedNote, IndexPort } from './ports.ts';
import { recordingActivity } from '../testing/fake-activity.ts';
import { createNoteChanges, type NoteChangeNews } from './note-changes.ts';
import { refreshIndex } from './refresh-index.ts';
import { createIndexSyncer } from './sync-index.ts';

/**
 * Adversarial tests for PR #439 (#431). A body link is resolved when its note is read. A refresh with a
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

/** Marks the question `compileLinkHoldersQuery` asks, the only one capped here. */
const HOLDERS_QUERY = 'SELECT DISTINCT src AS "path" FROM relations WHERE';

/**
 * The real-SQLite stand-in, recording which notes each refresh read again.
 * With `rowCap`, the holders question is cut short as the host cuts every
 * result (`MAX_QUERY_ROWS` = 5000 in index.rs): at most that many rows, and
 * `truncated: true` when more were there. A small cap stands in for 5000.
 */
function recordingIndex(rowCap = Number.POSITIVE_INFINITY): IndexPort & {
  written: string[];
  holderQueries: number;
} {
  const index = sqliteIndexPort();
  const recorder = {
    ...index,
    written: [] as string[],
    holderQueries: 0,
    put: async (notes: readonly IndexedNote[]) => {
      recorder.written.push(...notes.map((note) => note.path));
      await index.put(notes);
    },
    query: async (sql: string, parameters: readonly (string | number | null)[]) => {
      const result = await index.query(sql, parameters);
      if (!sql.startsWith(HOLDERS_QUERY)) return result;
      recorder.holderQueries += 1;
      if (result.rows.length <= rowCap) return result;
      return { ...result, rows: result.rows.slice(0, rowCap), truncated: true };
    },
  };
  return recorder;
}

/** Where each of a note's body links points, as the index holds it. */
async function linksFrom(index: IndexPort, src: string): Promise<(string | null)[]> {
  const result = await index.query('SELECT dst FROM links WHERE src = ? ORDER BY rowid', [src]);
  return result.rows.map((row) => (row[0] === null ? null : String(row[0])));
}

async function vaultWith(entries: Record<string, string>, rowCap?: number) {
  const files = new Map(Object.entries(entries));
  const fs = memoryVault(files);
  const index = recordingIndex(rowCap);
  await refreshIndex({ fs, index, markdown });
  index.written.length = 0;
  index.holderQueries = 0;
  return { files, fs, index };
}

const paths = (files: Map<string, string>) => [...files.keys()].map(createVaultPath);

describe('attack-439: holders past the host row cap', () => {
  it('re-resolves every holder when more hold the new name than one result returns', async () => {
    const holders = Object.fromEntries(
      ['A', 'B', 'C', 'D', 'E'].map((name) => [`${name}.md`, 'See [[Later]].']),
    );
    const { files, fs, index } = await vaultWith(holders, 3);

    files.set('Later.md', 'Made later.');
    await refreshIndex({ fs, index, markdown });

    for (const holder of Object.keys(holders)) {
      expect({ holder, links: await linksFrom(index, holder) }).toEqual({
        holder,
        links: ['Later.md'],
      });
    }
  });

  it('unresolves every holder of a note deleted in the app when more hold it than one result returns', async () => {
    const holders = Object.fromEntries(
      ['A', 'B', 'C', 'D', 'E'].map((name) => [`${name}.md`, 'See [[Gone]].']),
    );
    const { files, fs, index } = await vaultWith({ ...holders, 'Gone.md': 'Soon gone.' }, 3);

    await deleteEntry({
      fs,
      index,
      editors,
      entry: { path: createVaultPath('Gone.md'), kind: 'file' },
      notePaths: paths(files),
    });
    await refreshIndex({ fs, index, markdown });

    for (const holder of Object.keys(holders)) {
      expect({ holder, links: await linksFrom(index, holder) }).toEqual({ holder, links: [null] });
    }
  });
});

describe('attack-439: forgetNotes does not cascade', () => {
  it('re-reads only the holder of a note deleted in the app, not the notes linking to that holder', async () => {
    const { files, fs, index } = await vaultWith({
      'Hub.md': 'Index: [[Gone]].',
      'Spoke 1.md': 'Back to [[Hub]].',
      'Spoke 2.md': 'Back to [[Hub]].',
      'Spoke 3.md': 'Back to [[Hub]].',
      'Gone.md': 'Soon gone.',
    });

    await deleteEntry({
      fs,
      index,
      editors,
      entry: { path: createVaultPath('Gone.md'), kind: 'file' },
      notePaths: paths(files),
    });
    await refreshIndex({ fs, index, markdown });

    expect(await linksFrom(index, 'Hub.md')).toEqual([null]);
    expect(index.written.sort()).toEqual(['Hub.md']);
  });

  it('re-reads only the renamed note and its holders, not the notes linking to those holders', async () => {
    const { files, fs, index } = await vaultWith({
      'Hub.md': 'Index: [[Draft]].',
      'Spoke 1.md': 'Back to [[Hub]].',
      'Spoke 2.md': 'Back to [[Hub]].',
      'Draft.md': 'A draft.',
    });

    await renameEntry({
      ports: { fs, index, editors },
      entry: { path: createVaultPath('Draft.md'), kind: 'file' },
      name: 'Final',
      notePaths: paths(files),
    });
    await refreshIndex({ fs, index, markdown });

    expect(await linksFrom(index, 'Hub.md')).toEqual([null]);
    expect(index.written.sort()).toEqual(['Final.md', 'Hub.md']);
  });
});

describe('attack-439: what held', () => {
  it('resolves an NFD link to an NFC note made later, and the other way round', async () => {
    const { files, fs, index } = await vaultWith({
      'A.md': 'To [[Cafe\u0301]].',
      'B.md': 'To [[Re\u0301sume\u0301]].',
    });
    files.set('Caf\u00e9.md', 'NFC name.');
    files.set('Re\u0301sume\u0301.md'.normalize('NFD'), 'NFD name.');
    await refreshIndex({ fs, index, markdown });
    expect(await linksFrom(index, 'A.md')).toEqual(['Caf\u00e9.md']);
    expect(await linksFrom(index, 'B.md')).toEqual(['Re\u0301sume\u0301.md'.normalize('NFD')]);
  });

  it('resolves links with an emoji, heading, block, embed and .md suffix', async () => {
    const { files, fs, index } = await vaultWith({
      'A.md': '[[🚀 Launch#Goals]] [[🚀 launch#^b1]] ![[🚀 Launch]] [[🚀 Launch.md]]',
    });
    files.set('🚀 Launch.md', 'Off we go.');
    await refreshIndex({ fs, index, markdown });
    expect(await linksFrom(index, 'A.md')).toEqual(Array(4).fill('🚀 Launch.md'));
  });

  it('does not re-read a note whose only mention is in code', async () => {
    const { files, fs, index } = await vaultWith({
      'Code.md': 'Inline `[[Later]]` and\n\n```\n[[Later]]\n```\n',
    });
    files.set('Later.md', 'Made.');
    await refreshIndex({ fs, index, markdown });
    expect(index.written).toEqual(['Later.md']);
  });

  it('matches names holding SQL wildcards and quotes only exactly', async () => {
    const { files, fs, index } = await vaultWith({
      'Pct.md': "[[100%]] [[a_b]] [[O'Brien]]",
      'Near.md': '[[100x]] [[aXb]] [[OXBrien]]',
    });
    files.set('100%.md', '.');
    files.set('a_b.md', '.');
    files.set("O'Brien.md", '.');
    await refreshIndex({ fs, index, markdown });
    expect(await linksFrom(index, 'Pct.md')).toEqual(['100%.md', 'a_b.md', "O'Brien.md"]);
    expect(index.written).not.toContain('Near.md');
  });

  it('re-resolves a link to a very long title', async () => {
    const title = 'Long '.repeat(50).trim();
    const { files, fs, index } = await vaultWith({ 'A.md': `[[${title}]]` });
    files.set(`${title}.md`, '.');
    await refreshIndex({ fs, index, markdown });
    expect(await linksFrom(index, 'A.md')).toEqual([`${title}.md`]);
  });

  it('re-resolves holders of every new note across the batching boundary', async () => {
    const count = LINK_NAMES_PER_QUERY * 2 + 1;
    const names = Array.from({ length: count }, (_, at) => `N${at}`);
    const { files, fs, index } = await vaultWith({
      'First.md': `[[${names[0]}]]`,
      'Edge.md': `[[${names[LINK_NAMES_PER_QUERY]}]]`,
      'Last.md': `[[${names[count - 1]}]]`,
    });
    for (const name of names) files.set(`${name}.md`, '.');
    await refreshIndex({ fs, index, markdown });
    expect(await linksFrom(index, 'First.md')).toEqual([`${names[0]}.md`]);
    expect(await linksFrom(index, 'Edge.md')).toEqual([`${names[LINK_NAMES_PER_QUERY]}.md`]);
    expect(await linksFrom(index, 'Last.md')).toEqual([`${names[count - 1]}.md`]);
    expect(index.holderQueries).toBe(3);
  });

  it('moves a link to the archived note of the same name once the live one is deleted', async () => {
    const { files, fs, index } = await vaultWith({
      'Deal.md': '[[Plan]]',
      'Plan.md': 'live',
      'Archive/Plan.md': 'old',
    });
    expect(await linksFrom(index, 'Deal.md')).toEqual(['Plan.md']);
    await deleteEntry({
      fs,
      index,
      editors,
      entry: { path: createVaultPath('Plan.md'), kind: 'file' },
      notePaths: paths(files),
    });
    await refreshIndex({ fs, index, markdown });
    expect(await linksFrom(index, 'Deal.md')).toEqual(['Archive/Plan.md']);
  });

  it('keeps a folder link on its folder and a bare link on the shallowest note', async () => {
    const { files, fs, index } = await vaultWith({
      'Deal.md': '[[Projects/Plan]] [[Plan]]',
      'Work/Deep/Plan.md': 'deep',
    });
    expect(await linksFrom(index, 'Deal.md')).toEqual([null, 'Work/Deep/Plan.md']);
    files.set('Projects/Plan.md', 'projects');
    await refreshIndex({ fs, index, markdown });
    expect(await linksFrom(index, 'Deal.md')).toEqual(['Projects/Plan.md', 'Projects/Plan.md']);
  });

  it('follows a case-only rename outside the app', async () => {
    const { files, fs, index } = await vaultWith({ 'Deal.md': '[[plan]]', 'Plan.md': '.' });
    files.delete('Plan.md');
    files.set('plan.md', '.');
    await refreshIndex({ fs, index, markdown });
    expect(await linksFrom(index, 'Deal.md')).toEqual(['plan.md']);
  });

  it('follows a rename chain A to B to C in the app before one refresh', async () => {
    const { files, fs, index } = await vaultWith({
      'Deal.md': '[[A]] [[B]] [[C]]',
      'A.md': '.',
    });
    for (const [from, to] of [
      ['A', 'B'],
      ['B', 'C'],
    ] as const) {
      await renameEntry({
        ports: { fs, index, editors },
        entry: { path: createVaultPath(`${from}.md`), kind: 'file' },
        name: to,
        notePaths: paths(files),
      });
    }
    await refreshIndex({ fs, index, markdown });
    expect(await linksFrom(index, 'Deal.md')).toEqual([null, null, 'C.md']);
  });

  it('re-resolves a holder renamed outside the app in the same refresh as its target is made', async () => {
    const { files, fs, index } = await vaultWith({ 'Deal.md': '[[Later]]' });
    files.delete('Deal.md');
    files.set('Deals/Deal.md', '[[Later]]');
    files.set('Later.md', '.');
    await refreshIndex({ fs, index, markdown });
    expect(await linksFrom(index, 'Deals/Deal.md')).toEqual(['Later.md']);
    expect(await linksFrom(index, 'Deal.md')).toEqual([]);
  });

  it('reads nothing extra for a note made and deleted between two refreshes', async () => {
    const { files, fs, index } = await vaultWith({ 'Deal.md': '[[Blip]]' });
    files.set('Blip.md', '.');
    files.delete('Blip.md');
    await refreshIndex({ fs, index, markdown });
    expect(index.written).toEqual([]);
    expect(await linksFrom(index, 'Deal.md')).toEqual([null]);
  });
});

describe('attack-439: a forgotten holder is not news', () => {
  it('publishes only the deleted note, not the holders forgetNotes let go of', async () => {
    const files = new Map(
      Object.entries({ 'Deal.md': '[[Gone]]', 'Other.md': '[[Gone]]', 'Gone.md': '.' }),
    );
    const fs = memoryVault(files);
    const index = sqliteIndexPort();
    const published: NoteChangeNews[] = [];
    const changes = createNoteChanges({
      onError: (cause) => {
        throw cause;
      },
    });
    changes.subscribe((news) => published.push(news));
    const syncer = createIndexSyncer({
      fs,
      index,
      markdown,
      activity: recordingActivity(),
      changes,
      openVault: () => 'v',
    });
    await syncer.sync({ vault: 'v', fromScratch: false });
    published.length = 0;

    await deleteEntry({
      fs,
      index,
      editors,
      entry: { path: createVaultPath('Gone.md'), kind: 'file' },
      notePaths: paths(files),
    });
    await syncer.sync({ vault: 'v', fromScratch: false });

    expect(published.flatMap((news) => news.changes.map((change) => change.path))).toEqual([
      'Gone.md',
    ]);
  });
});
