import { describe, expect, it } from 'vitest';
import {
  createVaultPath,
  DEFAULT_HIGHLIGHT_STYLE,
  literatureNoteText,
  readHighlights,
} from '@dfai/domain';
import { lineNoteBlocks } from '@dfai/domain/testing';
import { editedBeforeTrash } from '../testing/edited-before-trash.ts';
import { fakeOpenNotes } from '../testing/fake-ports.ts';
import { memoryFiles, readerMarkdown } from '../testing/fake-reader.ts';
import { highlightArea } from './pdf-highlights.ts';

/*
 * Verification of PR #515 (#504) after ad1cc5f7: an area's picture is put in
 * the Trash again when adding its highlight throws. But the note's write can
 * land and still throw — the host's answer lost to a timeout, or the pane's
 * reload after it failing — and the picture the note now embeds is trashed
 * under it. And ADR-0043 says a note that already holds the area "writes
 * none"; the use-case writes one and sends it to the Trash, so each repeat
 * leaves a PNG in the person's Trash. All names are made up.
 */

const PDF = createVaultPath('Library/The Lantern Keepers.pdf');
const NOTE = createVaultPath('Library/The Lantern Keepers.md');
const SOURCE = literatureNoteText({
  kind: 'pdf',
  title: 'The Lantern Keepers',
  author: 'Mara Quill',
  file: PDF,
});

function vaultWhoseNoteWriteLandsThenThrows() {
  const memory = memoryFiles({ [NOTE]: SOURCE, [PDF]: new Uint8Array([37]) });
  const fs = {
    ...memory.fs,
    writeTextFile: async (args: Parameters<typeof memory.fs.writeTextFile>[0]) => {
      await memory.fs.writeTextFile(args);
      throw new Error('the host did not answer in time');
    },
  };
  let draws = 0;
  const ports = {
    fs,
    markdown: readerMarkdown(),
    openNotes: fakeOpenNotes(),
    rng: { next: () => ((draws += 1) % 36) / 36 + 0.001 },
  };
  return { ...memory, ports };
}

describe("an area highlight's picture is never trashed while its note embeds it", () => {
  it('keeps the picture when the note took the highlight but the write then reported a failure', async () => {
    const { ports, files } = vaultWhoseNoteWriteLandsThenThrows();
    await expect(
      highlightArea(ports, {
        note: NOTE,
        pdf: PDF,
        page: 2,
        box: { x: 0.1, y: 0.2, width: 0.3, height: 0.2 },
        picture: async () => new Uint8Array([137, 80, 78, 71]),
        placement: 'attachments',
        style: DEFAULT_HIGHLIGHT_STYLE,
      }),
    ).rejects.toThrow('the host did not answer in time');
    const [block] = readHighlights(files.get(NOTE) as string, lineNoteBlocks);
    const embedded = /!\[\[(.+?)\]\]/.exec(block?.quote ?? '')?.[1];
    expect(embedded).toBe('attachments/The Lantern Keepers p2 area.png');
    expect(files.has(embedded as string)).toBe(true);
  });
});

describe("an area highlight's picture when the pane's reload after the write fails", () => {
  it('is kept, since the note was written and embeds it', async () => {
    const { fs, files } = memoryFiles({ [NOTE]: SOURCE, [PDF]: new Uint8Array([37]) });
    let draws = 0;
    const ports = {
      fs,
      markdown: readerMarkdown(),
      openNotes: fakeOpenNotes({
        state: () => 'clean',
        reload: () => {
          throw new Error('the pane is gone');
        },
      }),
      rng: { next: () => ((draws += 1) % 36) / 36 + 0.001 },
    };
    await expect(
      highlightArea(ports, {
        note: NOTE,
        pdf: PDF,
        page: 2,
        box: { x: 0.1, y: 0.2, width: 0.3, height: 0.2 },
        picture: async () => new Uint8Array([137, 80, 78, 71]),
        placement: 'attachments',
        style: DEFAULT_HIGHLIGHT_STYLE,
      }),
    ).rejects.toThrow('the pane is gone');
    expect(files.has('attachments/The Lantern Keepers p2 area.png')).toBe(true);
  });
});

describe("an area highlight's picture when the note embeds it between the re-read and the Trash (#693)", () => {
  it('is kept: the Trash is held to the note as re-read', async () => {
    const memory = memoryFiles({ [NOTE]: SOURCE, [PDF]: new Uint8Array([37]) });
    const picture = 'attachments/The Lantern Keepers p2 area.png';
    const failingWrite = {
      ...memory.fs,
      writeTextFile: async () => {
        throw new Error('the disk is full');
      },
    };
    const fs = editedBeforeTrash(failingWrite, () =>
      memory.files.set(NOTE, `${SOURCE}\n![[${picture}]]\n`),
    );
    let draws = 0;
    const ports = {
      fs,
      markdown: readerMarkdown(),
      openNotes: fakeOpenNotes(),
      rng: { next: () => ((draws += 1) % 36) / 36 + 0.001 },
    };
    await expect(
      highlightArea(ports, {
        note: NOTE,
        pdf: PDF,
        page: 2,
        box: { x: 0.1, y: 0.2, width: 0.3, height: 0.2 },
        picture: async () => new Uint8Array([137, 80, 78, 71]),
        placement: 'attachments',
        style: DEFAULT_HIGHLIGHT_STYLE,
      }),
    ).rejects.toThrow('the disk is full');
    expect(memory.files.get(NOTE)).toContain(`![[${picture}]]`);
    expect(memory.files.has(picture)).toBe(true);
  });
});

describe('a note that already holds the area writes no picture for it again (ADR-0043)', () => {
  it('writes no file at all when the same box is highlighted a second time', async () => {
    const memory = memoryFiles({ [NOTE]: SOURCE, [PDF]: new Uint8Array([37]) });
    const written: string[] = [];
    const fs = {
      ...memory.fs,
      writeBinaryFile: async (args: Parameters<typeof memory.fs.writeBinaryFile>[0]) => {
        written.push(args.path);
        return memory.fs.writeBinaryFile(args);
      },
    };
    let draws = 0;
    const ports = {
      fs,
      markdown: readerMarkdown(),
      openNotes: fakeOpenNotes(),
      rng: { next: () => ((draws += 1) % 36) / 36 + 0.001 },
    };
    const area = () =>
      highlightArea(ports, {
        note: NOTE,
        pdf: PDF,
        page: 2,
        box: { x: 0.1, y: 0.2, width: 0.3, height: 0.2 },
        picture: async () => new Uint8Array([137, 80, 78, 71]),
        placement: 'attachments',
        style: DEFAULT_HIGHLIGHT_STYLE,
      });
    expect((await area()).added).toBe(true);
    expect(written).toHaveLength(1);
    expect((await area()).added).toBe(false);
    expect(written).toHaveLength(1);
  });
});
