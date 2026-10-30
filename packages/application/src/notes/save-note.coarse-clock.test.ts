import { describe, expect, it } from 'vitest';
import { createVaultPath, type EditorDocument, type ParsedBody } from '@dfai/domain';
import { openNote } from './open-note.ts';
import { saveNote } from './save-note.ts';
import type { MarkdownPort } from './ports.ts';
import { VaultAccessError, type VaultFsPort } from '../vault/ports.ts';

const path = createVaultPath('Plan.md');

/** The one second a coarse disk (HFS+) puts every write of it in. */
const TICK = 1_700_000_000_000;

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

/**
 * One note on a disk whose clock keeps whole seconds, holding to the host's
 * contract: a save is refused when the time it names is not the file's, or
 * the text it names is not the file's bytes. Every write lands in `TICK`.
 */
function coarseDisk(text: string) {
  const file = { text, modified: TICK };
  const fs: Pick<VaultFsPort, 'readTextFile' | 'writeTextFile'> = {
    readTextFile: async () => ({ ...file }),
    writeTextFile: async ({ contents, expectedModified, expectedText }) => {
      const otherTime = expectedModified !== null && expectedModified !== file.modified;
      const otherBytes = expectedText !== undefined && expectedText !== file.text;
      if (otherTime || otherBytes) {
        throw new VaultAccessError('the note changed on disk since it was opened');
      }
      file.text = contents;
      return file.modified;
    },
  };
  /** Another program's write: the same length, in the same second. */
  const writtenElsewhere = (next: string) => {
    expect(next).toHaveLength(file.text.length);
    file.text = next;
  };
  return { fs: fs as VaultFsPort, file, writtenElsewhere };
}

describe('saveNote on a disk that keeps whole seconds (#245)', () => {
  it('refuses a save from a version another program replaced in the same second', async () => {
    const disk = coarseDisk('Ship on Monday.\n');
    const note = await openNote({ fs: disk.fs, markdown, path });
    disk.writtenElsewhere('Ship on Friday.\n');

    await expect(
      saveNote({ fs: disk.fs, markdown, note, doc: docWith('Ship it.\n') }),
    ).rejects.toThrow('changed on disk');
    expect(disk.file.text).toBe('Ship on Friday.\n');
  });

  it('refuses one whose frontmatter alone was changed elsewhere', async () => {
    const disk = coarseDisk('---\nstatus: open\n---\nBody\n');
    const note = await openNote({ fs: disk.fs, markdown, path });
    disk.writtenElsewhere('---\nstatus: done\n---\nBody\n');

    await expect(
      saveNote({ fs: disk.fs, markdown, note, doc: docWith('Body, typed\n') }),
    ).rejects.toThrow('changed on disk');
    expect(disk.file.text).toBe('---\nstatus: done\n---\nBody\n');
  });

  it('lands a save, and the next save from what it left, within the one second', async () => {
    const disk = coarseDisk('---\nstatus: open\n---\nOne\n');
    const opened = await openNote({ fs: disk.fs, markdown, path });

    const first = await saveNote({ fs: disk.fs, markdown, note: opened, doc: docWith('Two\n') });
    const second = await saveNote({
      fs: disk.fs,
      markdown,
      note: first.note,
      doc: docWith('Three\n'),
    });

    expect(second.text).toBe('---\nstatus: open\n---\nThree\n');
    expect(disk.file.text).toBe(second.text);
  });

  it('lands a save from the note read again after the other write', async () => {
    const disk = coarseDisk('Ship on Monday.\n');
    await openNote({ fs: disk.fs, markdown, path });
    disk.writtenElsewhere('Ship on Friday.\n');
    const again = await openNote({ fs: disk.fs, markdown, path });

    await saveNote({ fs: disk.fs, markdown, note: again, doc: docWith('Ship it.\n') });
    expect(disk.file.text).toBe('Ship it.\n');
  });
});
