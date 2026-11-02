import { describe, expect, it } from 'vitest';
import {
  createVaultPath,
  parentVaultPath,
  WEB_DEVICE,
  type EditorDocument,
  type ParsedBody,
  type VaultEntry,
} from '@dfai/domain';
import { fakeVaultFs } from '../testing/fake-ports.ts';
import { VaultAccessError } from '../vault/ports.ts';
import type { MarkdownPort } from './ports.ts';
import { openNote } from './open-note.ts';
import { keepRefusedAsCopy } from './keep-refused-as-copy.ts';

/** A markdown port whose body is the one paragraph the document holds. */
const markdown: MarkdownPort = {
  frontmatterProperties: () => ({}),
  frontmatterProblem: () => null,
  frontmatterKeyTexts: () => ({}),
  plainText: (body) => body,
  textRanges: (body) => [{ start: 0, end: body.length }],
  updateFrontmatter: (frontmatter) => frontmatter ?? '',
  parseBody: (body): ParsedBody => ({
    blocks: [],
    doc: { type: 'doc', content: [{ type: 'paragraph', attrs: { text: body } }] },
  }),
  serializeBody: ({ doc }) => String(doc.content[0]?.attrs?.['text'] ?? ''),
  rawParts: () => [],
  noteBlocks: () => ({ quotes: [], hidden: [] }),
  writeTree: () => '',
  addToFrontmatterMap: () => null,
};

const docWith = (text: string): EditorDocument => ({
  type: 'doc',
  content: [{ type: 'paragraph', attrs: { text } }],
});

/** A vault of files held in memory, refusing to create over one that is there. */
function memoryVault(files: Record<string, string>) {
  const held = new Map(Object.entries(files));
  const folders = new Set<string>();
  const fs = fakeVaultFs({
    readTextFile: async (path) => {
      const text = held.get(path);
      if (text === undefined) throw new VaultAccessError('no such entry');
      return { text, modified: 2 };
    },
    listDirectory: async (folder) =>
      [...held.keys()]
        .filter((path) => parentVaultPath(createVaultPath(path)) === folder)
        .map((path): VaultEntry => ({ kind: 'file', path: createVaultPath(path), name: path })),
    createFolder: async ({ path }) => void folders.add(path),
    createNote: async ({ path, contents }) => {
      if (held.has(path)) throw new Error(`${path} is taken`);
      held.set(path, contents);
      return 3;
    },
  });
  return { fs, held, folders };
}

const path = createVaultPath('Projects/Plan.md');

async function refusedEdit(vault: ReturnType<typeof memoryVault>, typed: string) {
  const note = await openNote({ fs: vault.fs, markdown, path });
  return { note, doc: docWith(typed) };
}

describe('keepRefusedAsCopy', () => {
  it('keeps the newer version in place and the refused one whole beside it', async () => {
    const vault = memoryVault({ 'Projects/Plan.md': '---\nstatus: open\n---\nmine' });
    const { note, doc } = await refusedEdit(vault, 'mine, typed on');
    vault.held.set('Projects/Plan.md', 'theirs');

    const copy = await keepRefusedAsCopy({ fs: vault.fs, markdown, note, doc, device: WEB_DEVICE });

    expect(copy).toBe('Projects/Plan (conflict from DFAI web).md');
    expect(vault.held.get('Projects/Plan.md')).toBe('theirs');
    expect(vault.held.get(copy!)).toBe('---\nstatus: open\n---\nmine, typed on');
  });

  it('numbers the copy past one already beside the note', async () => {
    const vault = memoryVault({
      'Projects/Plan.md': 'base',
      'Projects/Plan (conflict from DFAI web).md': 'an earlier copy',
    });
    const { note, doc } = await refusedEdit(vault, 'mine');
    vault.held.set('Projects/Plan.md', 'theirs');

    const copy = await keepRefusedAsCopy({ fs: vault.fs, markdown, note, doc, device: WEB_DEVICE });

    expect(copy).toBe('Projects/Plan (conflict from DFAI web) 2.md');
    expect(vault.held.get('Projects/Plan (conflict from DFAI web).md')).toBe('an earlier copy');
    expect(vault.held.get(copy!)).toBe('mine');
  });

  it('makes no copy when the note already holds the refused text', async () => {
    const vault = memoryVault({ 'Projects/Plan.md': 'base' });
    const { note, doc } = await refusedEdit(vault, 'same');
    vault.held.set('Projects/Plan.md', 'same');

    expect(
      await keepRefusedAsCopy({ fs: vault.fs, markdown, note, doc, device: WEB_DEVICE }),
    ).toBeNull();
    expect([...vault.held.keys()]).toEqual(['Projects/Plan.md']);
  });

  it('puts a copy of a setting in the conflicts folder, made first', async () => {
    const vault = memoryVault({ '.atlas/types/Book.md': 'base' });
    const note = await openNote({
      fs: vault.fs,
      markdown,
      path: createVaultPath('.atlas/types/Book.md'),
    });
    vault.held.set('.atlas/types/Book.md', 'theirs');

    const copy = await keepRefusedAsCopy({
      fs: vault.fs,
      markdown,
      note,
      doc: docWith('mine'),
      device: WEB_DEVICE,
    });

    expect(copy).toBe('Sync conflicts/atlas/types/Book (conflict from DFAI web).md');
    expect([...vault.folders]).toContain('Sync conflicts/atlas/types');
    expect(vault.held.get(copy!)).toBe('mine');
  });

  it('puts mine back at the note’s own path, folder and all, when the note was deleted', async () => {
    const vault = memoryVault({ 'Projects/Plan.md': 'base' });
    const { note, doc } = await refusedEdit(vault, 'mine');
    vault.held.delete('Projects/Plan.md');

    const kept = await keepRefusedAsCopy({ fs: vault.fs, markdown, note, doc, device: WEB_DEVICE });

    expect(kept).toBe('Projects/Plan.md');
    expect(vault.held.get('Projects/Plan.md')).toBe('mine');
    expect([...vault.held.keys()]).toEqual(['Projects/Plan.md']);
    expect([...vault.folders]).toContain('Projects');
  });

  it('fails, writing nothing, when the note cannot be read for another reason', async () => {
    const vault = memoryVault({ 'Projects/Plan.md': 'base' });
    const { note, doc } = await refusedEdit(vault, 'mine');
    vault.fs.readTextFile = async () => {
      throw new VaultAccessError('GitHub answered 502');
    };

    await expect(
      keepRefusedAsCopy({ fs: vault.fs, markdown, note, doc, device: WEB_DEVICE }),
    ).rejects.toThrow(/502/);
    expect([...vault.held.keys()]).toEqual(['Projects/Plan.md']);
  });

  it('fails without writing when the copy’s name is taken meanwhile, so the edits stay held', async () => {
    const vault = memoryVault({ 'Projects/Plan.md': 'base' });
    const { note, doc } = await refusedEdit(vault, 'mine');
    vault.held.set('Projects/Plan.md', 'theirs');
    const listed = vault.fs.listDirectory;
    vault.fs.listDirectory = async (folder) => {
      const entries = await listed(folder);
      // Another writer takes the name between the listing and the create.
      vault.held.set('Projects/Plan (conflict from DFAI web).md', 'someone else’s');
      return entries;
    };

    await expect(
      keepRefusedAsCopy({ fs: vault.fs, markdown, note, doc, device: WEB_DEVICE }),
    ).rejects.toThrow(/taken/);
    expect(vault.held.get('Projects/Plan (conflict from DFAI web).md')).toBe('someone else’s');
    expect(vault.held.get('Projects/Plan.md')).toBe('theirs');
  });
});
