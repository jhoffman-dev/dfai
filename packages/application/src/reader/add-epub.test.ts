import { describe, expect, it } from 'vitest';
import { createVaultPath, MAX_DOCUMENT_BYTES } from '@dfai/domain';
import { epubBytes, fakeBook, fakeEpubReader, memoryFiles } from '../testing/fake-reader.ts';
import { addEpubToLibrary, EpubNotAddedError } from './add-epub.ts';
import type { EpubReaderPort } from './epub-ports.ts';
import type { PickedDocument } from './library-copy.ts';

/*
 * Adding an EPUB to the library (#505): the copy and its literature note,
 * titled from the book's package, and the books refused with nothing
 * written — one that is no EPUB, one locked with DRM, one the reader cannot
 * read.
 */

const LIBRARY = createVaultPath('Library');
const BYTES = epubBytes('fables');

const picked = (name: string, bytes = BYTES): PickedDocument & { reads: number } => {
  const file = {
    name,
    size: bytes.length,
    reads: 0,
    bytes: async () => {
      file.reads += 1;
      return bytes;
    },
  };
  return file;
};

const FABLES = fakeBook(['A Hare one day'], {
  title: 'Fables of Brightwater',
  author: 'Mara Quill',
});

describe('adding an EPUB to the library', () => {
  it('copies the file under its own name and makes its epub literature note beside it', async () => {
    const { fs, files } = memoryFiles({ 'Library/.keep': '' });
    const added = await addEpubToLibrary(
      { fs, reader: fakeEpubReader(FABLES) },
      { epub: picked('fables-of-brightwater.epub'), folder: LIBRARY },
    );
    expect(added).toEqual({
      file: 'Library/fables-of-brightwater.epub',
      note: 'Library/Fables of Brightwater.md',
      title: 'Fables of Brightwater',
    });
    expect(files.get('Library/fables-of-brightwater.epub')).toEqual(BYTES);
    expect(files.get('Library/Fables of Brightwater.md')).toBe(
      [
        '---',
        'type: literature',
        'kind: epub',
        'title: "Fables of Brightwater"',
        'author: "Mara Quill"',
        'file: "[[Library/fables-of-brightwater.epub]]"',
        '---',
        '',
      ].join('\n'),
    );
    expect(FABLES.closed).toBe(true);
  });

  it('titles the note by the file when the package has no title, and names a link-safe copy', async () => {
    const { fs, files } = memoryFiles();
    const added = await addEpubToLibrary(
      { fs, reader: fakeEpubReader(fakeBook([''])) },
      { epub: picked('Fables #2 [draft].epub'), folder: LIBRARY },
    );
    expect(added.file).toBe('Library/Fables -2 -draft-.epub');
    expect(added.title).toBe('Fables -2 -draft-');
    expect(files.get(added.note)).not.toContain('author:');
  });

  it('refuses a file that is not an EPUB by its name without reading it', async () => {
    const { fs, files } = memoryFiles();
    const file = picked('fables.pdf');
    await expect(
      addEpubToLibrary({ fs, reader: fakeEpubReader(FABLES) }, { epub: file, folder: LIBRARY }),
    ).rejects.toThrow(new EpubNotAddedError('“fables.pdf” is not an EPUB.'));
    expect(file.reads).toBe(0);
    expect(files.size).toBe(0);
  });

  it('refuses a file too large, unread', async () => {
    const { fs } = memoryFiles();
    const file = { ...picked('big.epub'), size: MAX_DOCUMENT_BYTES + 1 };
    await expect(
      addEpubToLibrary({ fs, reader: fakeEpubReader(FABLES) }, { epub: file, folder: LIBRARY }),
    ).rejects.toThrow(/at most 32 MB/);
  });

  it('refuses bytes that are no EPUB, though the name says it is one', async () => {
    const { fs, files } = memoryFiles();
    await expect(
      addEpubToLibrary(
        { fs, reader: fakeEpubReader(FABLES) },
        { epub: picked('fables.epub', new TextEncoder().encode('%PDF-1.4')), folder: LIBRARY },
      ),
    ).rejects.toThrow(new EpubNotAddedError('“fables.epub” is not an EPUB.'));
    expect(files.size).toBe(0);
  });

  it('refuses a book locked with DRM in plain words, writing nothing', async () => {
    const { fs, files } = memoryFiles();
    await expect(
      addEpubToLibrary(
        { fs, reader: fakeEpubReader(FABLES, { locked: true }) },
        { epub: picked('locked.epub'), folder: LIBRARY },
      ),
    ).rejects.toThrow(/“locked\.epub” is protected with DRM, so DFAI can't open it/);
    expect(files.size).toBe(0);
  });

  it('says why a book could not be read, writing nothing', async () => {
    const { fs, files } = memoryFiles();
    const broken: EpubReaderPort = {
      open: async () => {
        throw new Error('its package is missing');
      },
    };
    await expect(
      addEpubToLibrary({ fs, reader: broken }, { epub: picked('broken.epub'), folder: LIBRARY }),
    ).rejects.toThrow('“broken.epub” could not be read as an EPUB: its package is missing');
    expect(files.size).toBe(0);
  });

  it('takes the copy back out when its note cannot be made, and says so', async () => {
    const { fs, files } = memoryFiles({ 'Library/.keep': '' });
    const failing = {
      ...fs,
      createNote: async () => {
        throw new Error('the disk is full');
      },
    };
    await expect(
      addEpubToLibrary(
        { fs: failing, reader: fakeEpubReader(FABLES) },
        { epub: picked('fables.epub'), folder: LIBRARY },
      ),
    ).rejects.toThrow(
      'The note for the EPUB could not be made: the disk is full Nothing was added.',
    );
    expect(files.has('Library/fables.epub')).toBe(false);
  });
});
