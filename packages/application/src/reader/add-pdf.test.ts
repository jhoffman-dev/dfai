import { describe, expect, it } from 'vitest';
import { createVaultPath, MAX_DOCUMENT_BYTES } from '@dfai/domain';
import {
  fakePdf,
  fakeReader,
  linesPage,
  memoryFiles,
  pdfBytes,
  readerMarkdown,
} from '../testing/fake-reader.ts';
import { addPdfToLibrary, PdfNotAddedError } from './add-pdf.ts';
import type { PickedDocument } from './library-copy.ts';
import { PdfUnreadableError, type PdfReaderPort } from './ports.ts';

const LIBRARY = createVaultPath('Library');
const BYTES = pdfBytes('the lantern keepers');

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

const LANTERN = fakePdf([linesPage('A light kept')], {
  title: 'The Lantern Keepers',
  author: 'Mara Quill',
});

describe('adding a PDF to the library', () => {
  it('copies the file under its own name and makes its literature note beside it', async () => {
    const { fs, files } = memoryFiles({ 'Library/.keep': '' });
    const added = await addPdfToLibrary(
      { fs, reader: fakeReader(LANTERN) },
      { pdf: picked('lantern-scan.pdf'), folder: LIBRARY },
    );
    expect(added).toEqual({
      file: 'Library/lantern-scan.pdf',
      note: 'Library/The Lantern Keepers.md',
      title: 'The Lantern Keepers',
    });
    expect(files.get('Library/lantern-scan.pdf')).toEqual(BYTES);
    expect(files.get('Library/The Lantern Keepers.md')).toBe(
      [
        '---',
        'type: literature',
        'kind: pdf',
        'title: "The Lantern Keepers"',
        'author: "Mara Quill"',
        'file: "[[Library/lantern-scan.pdf]]"',
        '---',
        '',
      ].join('\n'),
    );
    expect(LANTERN.closed).toBe(true);
  });

  it('makes the library folder when it is not there yet', async () => {
    const { fs, files } = memoryFiles();
    await addPdfToLibrary(
      { fs, reader: fakeReader(fakePdf([])) },
      { pdf: picked('A.pdf'), folder: LIBRARY },
    );
    expect(files.has('Library/A.pdf')).toBe(true);
    expect(files.has('Library/A.md')).toBe(true);
  });

  it('titles the note by the file when the PDF has no title, and numbers past a taken name', async () => {
    const { fs, files } = memoryFiles({
      'Library/Notes [v2].pdf': pdfBytes(),
      'Library/Notes -v2-.pdf': pdfBytes(),
    });
    const added = await addPdfToLibrary(
      { fs, reader: fakeReader(fakePdf([])) },
      { pdf: picked('Notes [v2].pdf'), folder: LIBRARY },
    );
    expect(added.file).toBe('Library/Notes -v2- 2.pdf');
    expect(added.title).toBe('Notes -v2- 2');
    expect(files.get(added.note)).toContain('file: "[[Library/Notes -v2- 2.pdf]]"');
    expect(files.get(added.note)).not.toContain('author:');
  });

  it('numbers the note past one of the same title, as a second copy of a book needs', async () => {
    const { fs } = memoryFiles({ 'Library/The Lantern Keepers.md': 'mine' });
    const added = await addPdfToLibrary(
      { fs, reader: fakeReader(LANTERN) },
      { pdf: picked('second.pdf'), folder: LIBRARY },
    );
    expect(added.note).toBe('Library/The Lantern Keepers 2.md');
  });

  it('refuses a file that is not a PDF by name, unread, and writes nothing', async () => {
    const { fs, files } = memoryFiles();
    const file = picked('notes.txt');
    await expect(
      addPdfToLibrary({ fs, reader: fakeReader(LANTERN) }, { pdf: file, folder: LIBRARY }),
    ).rejects.toThrow(new PdfNotAddedError('“notes.txt” is not a PDF.'));
    expect(file.reads).toBe(0);
    expect(files.size).toBe(0);
  });

  it('refuses a PDF past the most the vault holds, unread', async () => {
    const { fs } = memoryFiles();
    const file = { ...picked('big.pdf'), size: MAX_DOCUMENT_BYTES + 1 };
    await expect(
      addPdfToLibrary({ fs, reader: fakeReader(LANTERN) }, { pdf: file, folder: LIBRARY }),
    ).rejects.toThrow(/at most 32 MB/);
  });

  it('refuses a file named .pdf that does not start as one', async () => {
    const { fs, files } = memoryFiles();
    await expect(
      addPdfToLibrary(
        { fs, reader: fakeReader(LANTERN) },
        { pdf: picked('fake.pdf', new TextEncoder().encode('<html>')), folder: LIBRARY },
      ),
    ).rejects.toThrow('“fake.pdf” is not a PDF.');
    expect(files.size).toBe(0);
  });

  it('refuses a PDF the reader cannot open, saying why, and writes nothing', async () => {
    const { fs, files } = memoryFiles();
    const locked: PdfReaderPort = {
      open: async () => {
        throw new PdfUnreadableError('it is locked with a password');
      },
    };
    await expect(
      addPdfToLibrary({ fs, reader: locked }, { pdf: picked('locked.pdf'), folder: LIBRARY }),
    ).rejects.toThrow('“locked.pdf” could not be read as a PDF: it is locked with a password');
    const broken: PdfReaderPort = {
      open: async () => {
        throw new Error('worker died');
      },
    };
    await expect(
      addPdfToLibrary({ fs, reader: broken }, { pdf: picked('a.pdf'), folder: LIBRARY }),
    ).rejects.toThrow('could not be read as a PDF: worker died');
    expect(files.size).toBe(0);
  });

  it('says so when the copy cannot be written', async () => {
    const { fs } = memoryFiles();
    const refusing = { ...fs, writeBinaryFile: async () => Promise.reject(new Error('disk full')) };
    await expect(
      addPdfToLibrary(
        { fs: refusing, reader: fakeReader(LANTERN) },
        { pdf: picked('a.pdf'), folder: LIBRARY },
      ),
    ).rejects.toThrow(
      '“a.pdf” could not be saved in Library: The file could not be saved: disk full',
    );
  });

  it('leaves no copy behind when its note cannot be made, so a retry finds a clean folder', async () => {
    const { fs, files } = memoryFiles();
    const refusing = { ...fs, createNote: async () => Promise.reject(new Error('read-only')) };
    await expect(
      addPdfToLibrary(
        { fs: refusing, reader: fakeReader(LANTERN) },
        { pdf: picked('a.pdf'), folder: LIBRARY },
      ),
    ).rejects.toThrow('The note for the PDF could not be made: read-only Nothing was added.');
    expect(files.has('Library/a.pdf')).toBe(false);
  });

  it('says where the copy stayed when it cannot be put away either', async () => {
    const { fs, files } = memoryFiles();
    const refusing = {
      ...fs,
      createNote: async () => Promise.reject(new Error('read-only')),
      trashEntry: async () => Promise.reject(new Error('no Trash')),
    };
    await expect(
      addPdfToLibrary(
        { fs: refusing, reader: fakeReader(LANTERN) },
        { pdf: picked('a.pdf'), folder: LIBRARY },
      ),
    ).rejects.toThrow('The PDF was saved as Library/a.pdf and could not be removed: no Trash');
    expect(files.has('Library/a.pdf')).toBe(true);
  });

  it('reads the markdown the note is written in back as a literature note of the copy', async () => {
    const { fs, files } = memoryFiles();
    const added = await addPdfToLibrary(
      { fs, reader: fakeReader(LANTERN) },
      { pdf: picked('a.pdf'), folder: LIBRARY },
    );
    const frontmatter = (files.get(added.note) as string).split('---')[1] ?? '';
    expect(readerMarkdown().frontmatterProperties(`---${frontmatter}---\n`)).toMatchObject({
      type: 'literature',
      file: '[[Library/a.pdf]]',
    });
  });
});
