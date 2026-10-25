import { describe, expect, it, vi } from 'vitest';
import {
  createVaultPath,
  highlightMarker,
  kindleHighlightKey,
  withKindleHighlights,
  literatureNoteText,
  type HighlightAnchor,
  type KindleHighlight,
  type LiteratureNote,
  type VaultEntry,
  type VaultPath,
} from '@dfai/domain';
import { lineNoteBlocks } from '@dfai/domain/testing';
import { fakeIndexPort, fakeVaultFs } from '../testing/fake-ports.ts';
import { memoryFiles, readerMarkdown } from '../testing/fake-reader.ts';
import { createTransclusionReader } from '../transclusion/read-transclusions.ts';
import {
  linkedDocument,
  openHighlightPlace,
  readerHighlightLinks,
  whereHighlightOpens,
  type HighlightPlaceOpener,
} from './open-highlight-place.ts';

/*
 * Following a highlight back to its place (#506): a PDF's opens its reader,
 * a Kindle book's its note at the block; the embeds of highlights name
 * their source; and `[[…pdf]]` finds the PDF it names.
 */

const PDF = createVaultPath('Library/the-lantern-keepers.pdf');
const PDF_NOTE = createVaultPath('Library/The Lantern Keepers.md');
const KINDLE_NOTE = createVaultPath('Library/Brightwater.md');
const PLAIN_NOTE = createVaultPath('Trips/Plans.md');

const PAGE_THREE: HighlightAnchor = {
  kind: 'pdf',
  page: 3,
  quote: { exact: 'The last lamp', prefix: '', suffix: '' },
  rects: [{ x: 0.1, y: 0.1, width: 0.3, height: 0.02 }],
};
const LOCATION_41: HighlightAnchor = {
  kind: 'kindle',
  location: { start: 41, end: 44 },
  annotationId: null,
};

const highlightText = (id: string, anchor: HighlightAnchor) =>
  `> Quote ${id}.\n> ${highlightMarker({ style: { mark: 'highlight', color: 'yellow' }, anchor })}\n\n^${id}\n`;

const note = (source: LiteratureNote, ...blocks: string[]) =>
  [literatureNoteText(source), ...blocks].join('\n');

function vault() {
  return memoryFiles({
    [PDF_NOTE]: note(
      { kind: 'pdf', title: 'The Lantern Keepers', author: 'Mara Quill', file: PDF },
      highlightText('k3x9q2', PAGE_THREE),
      'A paragraph of my own. ^mine01\n',
    ),
    [KINDLE_NOTE]: note(
      { kind: 'kindle', title: 'Brightwater', author: 'Tobias Fenn', file: null },
      highlightText('kd0041', LOCATION_41),
    ),
    [PLAIN_NOTE]: `${highlightText('q1q1q1', PAGE_THREE)}`,
  });
}

const ports = () => ({ fs: vault().fs, markdown: readerMarkdown() });

describe('where following a block of a note leads', () => {
  it("is a PDF's reader, at the highlight", async () => {
    expect(await whereHighlightOpens(ports(), { note: PDF_NOTE, blockId: 'k3x9q2' })).toEqual({
      kind: 'reader',
      source: 'pdf',
      document: PDF,
      highlightId: 'k3x9q2',
    });
  });

  it("is a Kindle highlight's note, at the block", async () => {
    expect(await whereHighlightOpens(ports(), { note: KINDLE_NOTE, blockId: 'kd0041' })).toEqual({
      kind: 'note',
      note: KINDLE_NOTE,
      blockId: 'kd0041',
    });
  });

  it("is the note for a block of a PDF's note that is not a highlight", async () => {
    expect(await whereHighlightOpens(ports(), { note: PDF_NOTE, blockId: 'mine01' })).toEqual({
      kind: 'note',
      note: PDF_NOTE,
      blockId: 'mine01',
    });
  });

  it('is the note for a quote in a note that is no literature note, marker or not', async () => {
    expect(await whereHighlightOpens(ports(), { note: PLAIN_NOTE, blockId: 'q1q1q1' })).toEqual({
      kind: 'note',
      note: PLAIN_NOTE,
      blockId: 'q1q1q1',
    });
  });

  it('is the note when the note cannot be read: its page then says why', async () => {
    const missing = createVaultPath('Library/Gone.md');
    expect(await whereHighlightOpens(ports(), { note: missing, blockId: 'k3x9q2' })).toEqual({
      kind: 'note',
      note: missing,
      blockId: 'k3x9q2',
    });
  });
});

/** A Kindle literature note as a Kindle sync writes it (#508), with one passage. */
function syncedKindleNote(): { text: string; id: string } {
  const asin = 'B0FICTION1';
  const passage: KindleHighlight = {
    key: kindleHighlightKey({
      asin,
      annotationId: 'ann-1',
      location: 41,
      words: 'The tide kept time.',
    }),
    asin,
    annotationId: 'ann-1',
    style: 'highlight',
    colour: 'yellow',
    quote: 'The tide kept time.',
    note: null,
    location: 41,
    page: null,
    commentOn: null,
  };
  const empty = literatureNoteText({
    kind: 'kindle',
    title: 'Saltmarsh',
    author: 'Ida Wren',
    asin,
    file: null,
  });
  let state = 7;
  const random = () => (state = (state * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  const write = withKindleHighlights({
    text: empty,
    asin,
    highlights: [passage],
    random,
    noteBlocks: lineNoteBlocks,
  });
  const id = /\^([a-z0-9]{6})\s*$/m.exec(write.text)?.[1];
  if (id === undefined) throw new Error('the sync wrote no block id');
  return { text: write.text, id };
}

describe('a highlight a Kindle sync wrote', () => {
  it('opens its note at its block, never a reader', async () => {
    const path = createVaultPath('Library/Saltmarsh.md');
    const { text, id } = syncedKindleNote();
    const synced = { fs: memoryFiles({ [path]: text }).fs, markdown: readerMarkdown() };
    expect(await whereHighlightOpens(synced, { note: path, blockId: id })).toEqual({
      kind: 'note',
      note: path,
      blockId: id,
    });
    const opens = {
      openDocument: vi.fn<HighlightPlaceOpener['openDocument']>(),
      openNote: vi.fn<HighlightPlaceOpener['openNote']>(),
    };
    await openHighlightPlace({ ...synced, opener: opens }, { note: path, highlightId: id });
    expect(opens.openNote).toHaveBeenCalledWith({ path, blockId: id });
    expect(opens.openDocument).not.toHaveBeenCalled();
  });
});

describe('opening a highlight where it lives', () => {
  const opener = () => ({
    openDocument: vi.fn<HighlightPlaceOpener['openDocument']>(),
    openNote: vi.fn<HighlightPlaceOpener['openNote']>(),
  });

  it("opens a PDF's highlight in its reader and nothing else", async () => {
    const opens = opener();
    await openHighlightPlace(
      { ...ports(), opener: opens },
      { note: PDF_NOTE, highlightId: 'k3x9q2' },
    );
    expect(opens.openDocument).toHaveBeenCalledWith({ path: PDF, highlightId: 'k3x9q2' });
    expect(opens.openNote).not.toHaveBeenCalled();
  });

  it('opens a Kindle highlight at its block in its note and nothing else', async () => {
    const opens = opener();
    const opened = await openHighlightPlace(
      { ...ports(), opener: opens },
      { note: KINDLE_NOTE, highlightId: 'kd0041' },
    );
    expect(opens.openNote).toHaveBeenCalledWith({ path: KINDLE_NOTE, blockId: 'kd0041' });
    expect(opens.openDocument).not.toHaveBeenCalled();
    expect(opened.kind).toBe('note');
  });
});

describe('which highlights of an open note offer "Open in PDF"', () => {
  const linksOf = (path: string) => {
    const text = vault().files.get(path) as string;
    const properties = readerMarkdown().frontmatterProperties(
      text.slice(4, text.indexOf('\n---\n')),
    );
    return readerHighlightLinks(readerMarkdown(), { properties, text });
  };

  it("is every highlight of a PDF's literature note, and no other block", () => {
    const links = linksOf(PDF_NOTE);
    expect(links?.label).toBe('Open in PDF');
    expect([...(links?.ids ?? [])]).toEqual(['k3x9q2']);
  });

  it("is none in a Kindle book's note", () => {
    expect(linksOf(KINDLE_NOTE)).toBeNull();
  });

  it('is none in a note that is no literature note', () => {
    expect(
      readerHighlightLinks(readerMarkdown(), {
        properties: {},
        text: highlightText('q1q1q1', PAGE_THREE),
      }),
    ).toBeNull();
  });
});

describe("an embed of a literature note's highlight", () => {
  it('names its source and page; an embed of any other block names none', async () => {
    const { fs } = vault();
    const raw = (anchor: string) => ({ type: 'rawBlock', attrs: { markdown: '> Quote.', anchor } });
    const markdown = {
      ...readerMarkdown(),
      parseBody: () => ({
        blocks: [],
        doc: { type: 'doc' as const, content: [raw('k3x9q2'), raw('mine01')] },
      }),
    };
    const reader = createTransclusionReader({ fs, markdown, index: fakeIndexPort() });
    const [highlight, other] = await reader.read({
      holder: PLAIN_NOTE,
      notePaths: [PDF_NOTE, PLAIN_NOTE],
      links: [
        { target: 'The Lantern Keepers', heading: '#^k3x9q2', alias: null },
        { target: 'The Lantern Keepers', heading: '#^mine01', alias: null },
      ],
    });
    expect(highlight?.kind === 'block' ? highlight.highlight : 'not shown').toEqual({
      kind: 'pdf',
      hue: 'red',
      title: 'The Lantern Keepers',
      place: 'p. 3',
      opensInReader: true,
    });
    expect(other?.kind === 'block' ? other.highlight : 'not shown').toBeNull();
  });
});

describe('the PDF a `[[…pdf]]` link names', () => {
  const files = (extra: Record<string, string | Uint8Array> = {}) =>
    memoryFiles({
      [PDF]: new Uint8Array([1]),
      'Library/Courses/reading.pdf': new Uint8Array([1]),
      'Elsewhere/Deep/Fog.pdf': new Uint8Array([1]),
      [PLAIN_NOTE]: 'Plans\n',
      ...extra,
    }).fs;

  it('is an EPUB of the vault for `[[…epub]]` (#505), asking the host for EPUBs only', async () => {
    const fs = files({
      'Library/fables.epub': new Uint8Array([1]),
      'Library/fables.pdf': new Uint8Array([1]),
    });
    const asked: string[] = [];
    const listing = {
      listFiles: async (options: Parameters<typeof fs.listFiles>[0]) => {
        asked.push(options.extension);
        return fs.listFiles(options);
      },
    };
    expect(await linkedDocument({ fs: listing }, 'fables.epub')).toBe('Library/fables.epub');
    expect(await linkedDocument({ fs: listing }, 'missing.epub')).toBeNull();
    expect(asked).toEqual(['epub', 'epub']);
  });

  it('is a PDF of the vault by its name alone, though no literature note names it', async () => {
    expect(await linkedDocument({ fs: files() }, 'fog.pdf')).toBe('Elsewhere/Deep/Fog.pdf');
  });

  it('is the PDF whose path ends as the link is written, as Obsidian reads it', async () => {
    expect(await linkedDocument({ fs: files() }, 'Courses/reading.pdf')).toBe(
      'Library/Courses/reading.pdf',
    );
  });

  it('is one of the PDFs the name is shared by, the same one every time', async () => {
    const shared = files({
      'reading.pdf': new Uint8Array([1]),
      'Z/reading.pdf': new Uint8Array([1]),
    });
    expect(await linkedDocument({ fs: shared }, 'reading.pdf')).toBe('reading.pdf');
  });

  it('is none for a PDF the vault does not hold: a link never names a file that is not there', async () => {
    expect(await linkedDocument({ fs: files() }, 'Areas/Missing.pdf')).toBeNull();
  });

  it('is none for a link to a note, and the vault is not read for it', async () => {
    const listDirectory = vi.fn(async () => []);
    const listFiles = vi.fn(async () => []);
    const fs = fakeVaultFs({ listDirectory, listFiles });
    expect(await linkedDocument({ fs }, 'The Lantern Keepers')).toBeNull();
    expect(listDirectory).not.toHaveBeenCalled();
    expect(listFiles).not.toHaveBeenCalled();
  });

  it('is an error, not a guess, when the vault cannot be read', async () => {
    const fs = fakeVaultFs({
      listFiles: async () => {
        throw new Error('the disk went away');
      },
    });
    await expect(linkedDocument({ fs }, 'fog.pdf')).rejects.toThrow('the disk went away');
  });
});

/*
 * Verification (#506, PR #522 after 54f53fc3): `[[…pdf]]` walked the vault
 * folder by folder, one host call per folder, on every click; and one folder
 * that could not be listed failed every PDF link, where the note walk skips it.
 * The fake host below answers both ways of asking from one tree, as the real
 * one does: by folder (`listDirectory`) and in one walk (`listFiles`).
 */

const directory = (path: string): VaultEntry =>
  ({ kind: 'directory', name: path.split('/').at(-1), path: createVaultPath(path) }) as VaultEntry;
const file = (path: string): VaultEntry =>
  ({ kind: 'file', name: path.split('/').at(-1), path: createVaultPath(path) }) as VaultEntry;

/** A host over a tree of listings, counting every call made to it; a folder in `unreadable` cannot be listed. */
function treeHost(
  tree: ReadonlyMap<string, readonly VaultEntry[]>,
  unreadable = new Set<string>(),
) {
  let calls = 0;
  const listed = (path: string): readonly VaultEntry[] => {
    if (unreadable.has(path)) throw new Error(`Permission denied: ${path}`);
    return tree.get(path) ?? [];
  };
  const fs = fakeVaultFs({
    listDirectory: async (path: VaultPath) => {
      calls += 1;
      return listed(path);
    },
    // As the host walks: a folder it cannot read is skipped, the vault's own root is not.
    listFiles: async ({ extension }) => {
      calls += 1;
      const found: VaultPath[] = [];
      const walk = (path: string) => {
        let entries: readonly VaultEntry[];
        try {
          entries = listed(path);
        } catch (error) {
          if (path === '') throw error;
          return;
        }
        for (const entry of entries) {
          if (entry.kind === 'directory') walk(entry.path);
          else if (entry.name.toLowerCase().endsWith(`.${extension}`)) found.push(entry.path);
        }
      };
      walk('');
      return found;
    },
  });
  return { fs, calls: () => calls };
}

/** A vault of `areas` × 10 × 20 folders, ten notes in each, as a tree of listings. */
function largeVault(areas: number): Map<string, VaultEntry[]> {
  const tree = new Map<string, VaultEntry[]>([['', []]]);
  const add = (parent: string, entry: VaultEntry) => {
    const listed = tree.get(parent) ?? [];
    if (!listed.some((known) => known.path === entry.path)) listed.push(entry);
    tree.set(parent, listed);
    if (entry.kind === 'directory' && !tree.has(entry.path)) tree.set(entry.path, []);
  };
  for (let a = 0; a < areas; a += 1) {
    add('', directory(`Area ${a}`));
    for (let b = 0; b < 10; b += 1) {
      add(`Area ${a}`, directory(`Area ${a}/Topic ${b}`));
      for (let c = 0; c < 20; c += 1) {
        const folder = `Area ${a}/Topic ${b}/Folder ${c}`;
        add(`Area ${a}/Topic ${b}`, directory(folder));
        for (let n = 0; n < 10; n += 1) add(folder, file(`${folder}/Note ${n}.md`));
      }
    }
  }
  add('Area 3/Topic 4/Folder 5', file('Area 3/Topic 4/Folder 5/the-lantern-keepers.pdf'));
  return tree;
}

describe('following [[…pdf]] in a vault of 2,000 folders and 20,000 notes', () => {
  it('does not ask the host to list every folder of the vault on each click', async () => {
    const host = treeHost(largeVault(10));
    expect(await linkedDocument({ fs: host.fs }, 'the-lantern-keepers.pdf')).toBe(
      'Area 3/Topic 4/Folder 5/the-lantern-keepers.pdf',
    );
    // Measured: 2,111 calls per click, 250–360 ms on disk for this vault
    // (readdir + stat, before IPC); the note walk does it in one `listNotes`.
    expect(host.calls()).toBeLessThanOrEqual(33);
  });
});

describe('following [[…pdf]] when one folder of the vault cannot be listed', () => {
  it('still finds the PDF in the folders that can, as the note walk does', async () => {
    const pdf = 'Library/the-lantern-keepers.pdf';
    const tree = new Map<string, VaultEntry[]>([
      ['', [directory('Library'), directory('Private')]],
      ['Library', [file(pdf)]],
    ]);
    // A folder this user may not read, or one a sync removed mid-walk.
    const host = treeHost(tree, new Set(['Private']));
    expect(await linkedDocument({ fs: host.fs }, 'the-lantern-keepers.pdf')).toBe(pdf);
  });
});
