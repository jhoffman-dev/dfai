import { describe, expect, it, vi } from 'vitest';
import { createVaultPath, type EditorDocument, type ParsedBody } from '@dfai/domain';
import { openNote } from './open-note.ts';
import { saveNote } from './save-note.ts';
import type { MarkdownPort } from './ports.ts';
import type { VaultFsPort } from '../vault/ports.ts';

const path = createVaultPath('today.md');

/** A markdown port that records what it is asked to do, without a real parser. */
function fakeMarkdown(): MarkdownPort & { serialized: string[] } {
  const serialized: string[] = [];
  const parsedFor = (body: string): ParsedBody => ({
    blocks: [{ id: 'b0', index: 0, source: body, start: 0, end: body.length, normalized: body }],
    doc: { type: 'doc', content: [{ type: 'paragraph', attrs: { blockId: 'b0' } }] },
  });
  return {
    serialized,
    frontmatterProperties: () => ({}),
    frontmatterProblem: () => null,
    frontmatterKeyTexts: () => ({}),
    plainText: (body: string) => body,
    textRanges: (body: string) => [{ start: 0, end: body.length }],
    updateFrontmatter: (_frontmatter, changes) =>
      `---\n${Object.entries(changes)
        .map(([key, value]) => `${key}: ${String(value)}`)
        .join('\n')}\n---\n`,
    parseBody: parsedFor,
    serializeBody: ({ doc }) => {
      const text = String(doc.content[0]?.attrs?.['text'] ?? 'serialized body\n');
      serialized.push(text);
      return text;
    },
    rawParts: () => [],
    noteBlocks: () => ({ quotes: [], hidden: [] }),
    writeTree: () => '',
    addToFrontmatterMap: () => null,
  };
}

function fakeFs(files: Record<string, string>) {
  const written: Array<{ path: string; contents: string; expectedModified: number | null }> = [];
  const fs: VaultFsPort = {
    listDirectory: async () => [],
    listFiles: async () => [],
    listNotes: async () => [],
    readNotes: async () => [],
    readBinaryFile: async () => new ArrayBuffer(0),
    createNote: async () => 0,
    createFolder: async () => {},
    moveEntry: async () => {},
    trashEntry: async () => {},
    writeBinaryFile: async () => 0,
    readTextFile: async (target) => ({ text: files[target] ?? '', modified: 11 }),
    writeTextFile: async ({ path: target, contents, expectedModified }) => {
      written.push({ path: target, contents, expectedModified });
      files[target] = contents;
      return 22;
    },
  };
  return { fs, written };
}

describe('openNote', () => {
  it('separates frontmatter from the body it hands to the parser', async () => {
    const markdown = fakeMarkdown();
    const parseBody = vi.spyOn(markdown, 'parseBody');
    const { fs } = fakeFs({ 'today.md': '---\ntitle: Today\n---\n\n# Today\n' });

    const note = await openNote({ fs, markdown, path });

    expect(note.frontmatter).toBe('---\ntitle: Today\n---\n');
    expect(note.originalBody).toBe('\n# Today\n');
    expect(parseBody).toHaveBeenCalledWith('\n# Today\n');
  });

  it('records the modification time the note was read at', async () => {
    const { fs } = fakeFs({ 'today.md': 'body\n' });
    const note = await openNote({ fs, markdown: fakeMarkdown(), path });
    expect(note.modified).toBe(11);
  });

  it('handles a note with no frontmatter', async () => {
    const { fs } = fakeFs({ 'today.md': '# Today\n' });
    const note = await openNote({ fs, markdown: fakeMarkdown(), path });
    expect(note.frontmatter).toBeNull();
    expect(note.originalBody).toBe('# Today\n');
  });

  it('propagates a read failure', async () => {
    const fs: VaultFsPort = {
      listDirectory: async () => [],
      listFiles: async () => [],
      listNotes: async () => [],
      readNotes: async () => [],
      readBinaryFile: async () => new ArrayBuffer(0),
      createNote: async () => 0,
      createFolder: async () => {},
      moveEntry: async () => {},
      trashEntry: async () => {},
      writeBinaryFile: async () => 0,
      readTextFile: () => Promise.reject(new Error('not a text file')),
      writeTextFile: async () => 1,
    };
    await expect(openNote({ fs, markdown: fakeMarkdown(), path })).rejects.toThrow(
      'not a text file',
    );
  });
});

describe('saveNote', () => {
  const docWith = (text: string): EditorDocument => ({
    type: 'doc',
    content: [{ type: 'paragraph', attrs: { blockId: 'b0', text } }],
  });

  it('writes the frontmatter back exactly as it was read', async () => {
    const markdown = fakeMarkdown();
    const { fs, written } = fakeFs({ 'today.md': '---\ntitle: Today\n---\nold body\n' });
    const note = await openNote({ fs, markdown, path });

    await saveNote({ fs, markdown, note, doc: docWith('new body\n') });

    expect(written[0]?.contents).toBe('---\ntitle: Today\n---\nnew body\n');
  });

  it('writes nothing but the body when there is no frontmatter', async () => {
    const markdown = fakeMarkdown();
    const { fs, written } = fakeFs({ 'today.md': 'old\n' });
    const note = await openNote({ fs, markdown, path });

    await saveNote({ fs, markdown, note, doc: docWith('new\n') });

    expect(written[0]?.contents).toBe('new\n');
  });

  it('starts typed text on its own line under frontmatter that closed on the last byte', async () => {
    const markdown = fakeMarkdown();
    const { fs, written } = fakeFs({ 'today.md': '---\ntitle: Today\n---' });
    const note = await openNote({ fs, markdown, path });

    await saveNote({ fs, markdown, note, doc: docWith('typed\n') });

    expect(written[0]?.contents).toBe('---\ntitle: Today\n---\ntyped\n');
  });

  it('passes the modification time it read, so an outside edit is caught', async () => {
    const markdown = fakeMarkdown();
    const { fs, written } = fakeFs({ 'today.md': 'old\n' });
    const note = await openNote({ fs, markdown, path });

    await saveNote({ fs, markdown, note, doc: docWith('new\n') });

    expect(written[0]?.expectedModified).toBe(11);
  });

  it('carries the new modification time forward for the next save', async () => {
    const markdown = fakeMarkdown();
    const { fs } = fakeFs({ 'today.md': 'old\n' });
    const note = await openNote({ fs, markdown, path });

    const saved = await saveNote({ fs, markdown, note, doc: docWith('new\n') });

    expect(saved.note.modified).toBe(22);
    expect(saved.note.originalBody).toBe('new\n');
  });

  it('does not write when the host refuses the save', async () => {
    const markdown = fakeMarkdown();
    const fs: VaultFsPort = {
      listDirectory: async () => [],
      listFiles: async () => [],
      listNotes: async () => [],
      readNotes: async () => [],
      readBinaryFile: async () => new ArrayBuffer(0),
      createNote: async () => 0,
      createFolder: async () => {},
      moveEntry: async () => {},
      trashEntry: async () => {},
      writeBinaryFile: async () => 0,
      readTextFile: async () => ({ text: 'old\n', modified: 11 }),
      writeTextFile: () =>
        Promise.reject(new Error('the note changed on disk since it was opened')),
    };
    const note = await openNote({ fs, markdown, path });

    await expect(saveNote({ fs, markdown, note, doc: docWith('new\n') })).rejects.toThrow(
      'changed on disk',
    );
  });
});
